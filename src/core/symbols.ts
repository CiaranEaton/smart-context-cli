import ts from 'typescript';
import type { DependencyGraph } from './graph.js';
import { isLocalSpecifier } from './imports.js';
import { parseFile } from './parser.js';
import { resolveLocalImport } from './resolver.js';

/** Motivos por los que un archivo no se puede recortar de forma segura. */
export type WholeReason = 'namespace' | 'export-all' | 'side-effect' | 'dynamic-import';

export interface ImportRecord {
  specifier: string;
  /** Nombres exportados que se piden al módulo destino ('default' incluido). */
  names: string[];
  whole: WholeReason | null;
}

export interface FileUsage {
  file: string;
  isEntry: boolean;
  names: string[];
  wholeReasons: WholeReason[];
  importedBy: string[];
  keepWhole: boolean;
}

type ReadResult = Pick<ImportRecord, 'names' | 'whole'>;

function finish(names: string[]): ReadResult {
  // Sin nombres (p. ej. `import {} from './x'`) el módulo igual se ejecuta.
  return names.length > 0 ? { names, whole: null } : { names, whole: 'side-effect' };
}

function readImportClause(clause: ts.ImportClause | undefined): ReadResult {
  if (clause === undefined) return { names: [], whole: 'side-effect' };

  const names: string[] = [];
  if (clause.name !== undefined) names.push('default');

  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) return { names, whole: 'namespace' };
    // En `import { a as b }` el nombre exportado por el destino es `a`.
    for (const element of bindings.elements) {
      names.push((element.propertyName ?? element.name).text);
    }
  }

  return finish(names);
}

function readExportClause(node: ts.ExportDeclaration): ReadResult {
  const clause = node.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) {
    return { names: [], whole: 'export-all' };
  }
  return finish(clause.elements.map((element) => (element.propertyName ?? element.name).text));
}

/** Extrae, por cada import/re-export local, qué nombres pide del módulo destino. */
export function collectImportRecords(sourceFile: ts.SourceFile): ImportRecord[] {
  const records: ImportRecord[] = [];

  const push = (specifier: string, result: ReadResult): void => {
    if (isLocalSpecifier(specifier)) records.push({ specifier, ...result });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      push(node.moduleSpecifier.text, readImportClause(node.importClause));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push(node.moduleSpecifier.text, readExportClause(node));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [firstArg] = node.arguments;
      if (firstArg !== undefined && ts.isStringLiteralLike(firstArg)) {
        push(firstArg.text, { names: [], whole: 'dynamic-import' });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return records;
}

interface Accumulator {
  names: Set<string>;
  reasons: Set<WholeReason>;
  importedBy: Set<string>;
}

function createAccumulator(): Accumulator {
  return { names: new Set(), reasons: new Set(), importedBy: new Set() };
}

/** Para cada archivo del grafo: qué símbolos le piden sus importadores. */
export function buildUsageTable(graph: DependencyGraph): FileUsage[] {
  const accumulators = new Map<string, Accumulator>(
    graph.files.map((file) => [file, createAccumulator()]),
  );

  for (const file of graph.files) {
    for (const record of collectImportRecords(parseFile(file))) {
      const resolved = resolveLocalImport(file, record.specifier);
      const target = resolved === null ? undefined : accumulators.get(resolved);
      if (target === undefined) continue;

      for (const name of record.names) target.names.add(name);
      if (record.whole !== null) target.reasons.add(record.whole);
      target.importedBy.add(file);
    }
  }

  return graph.files.map((file): FileUsage => {
    const acc = accumulators.get(file) ?? createAccumulator();
    const isEntry = file === graph.entry;
    return {
      file,
      isEntry,
      names: [...acc.names].sort(),
      wholeReasons: [...acc.reasons],
      importedBy: [...acc.importedBy],
      keepWhole: isEntry || acc.reasons.size > 0,
    };
  });
}