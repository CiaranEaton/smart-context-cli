import ts from 'typescript';
import type { DependencyGraph } from './graph.js';
import { parseFile } from './parser.js';

export type DeclarationKind =
  | 'function'
  | 'class'
  | 'variable'
  | 'interface'
  | 'type'
  | 'enum'
  | 'namespace'
  | 'import'
  | 'export-list'
  | 're-export'
  | 'export-default'
  | 'statement';

export interface TopLevelDeclaration {
  kind: DeclarationKind;
  /** Nombres locales que introduce. Vacío en imports de efecto, `export default` anónimo, etc. */
  names: string[];
  hasExportModifier: boolean;
  /** Debe conservarse siempre: sentencias sueltas, imports de efecto, augmentations. */
  alwaysKeep: boolean;
  moduleSpecifier: string | null;
  /** Otros nombres de nivel superior del mismo archivo que esta declaración usa. */
  references: string[];
  /** Offsets en el texto. `start` incluye el JSDoc. */
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

export interface ExportBinding {
  /** Nombre público ('default' incluido). */
  exportedName: string;
  /** Nombre local que respalda la exportación. `null` si es anónima o viene de otro módulo. */
  localName: string | null;
  /** Índice en `declarations` de la sentencia que la produce. */
  declaration: number;
}

export type UnsupportedReason = 'not-a-module' | 'export-equals';

export interface FileExports {
  file: string;
  declarations: TopLevelDeclaration[];
  bindings: ExportBinding[];
  /** Specifiers de `export * from '...'`. */
  starReexports: string[];
  /** Motivos por los que este archivo no se puede recortar de forma segura. */
  unsupported: UnsupportedReason[];
}

interface Shape {
  kind: DeclarationKind;
  names: string[];
  moduleSpecifier: string | null;
}

function optionalName(name: ts.Identifier | undefined): string[] {
  return name !== undefined ? [name.text] : [];
}

function collectBindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, out);
  }
}

function importNames(clause: ts.ImportClause | undefined): string[] {
  if (clause === undefined) return [];

  const names: string[] = [];
  if (clause.name !== undefined) names.push(clause.name.text);

  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) {
      names.push(bindings.name.text);
    } else {
      for (const element of bindings.elements) names.push(element.name.text);
    }
  }
  return names;
}

function describeStatement(statement: ts.Statement): Shape {
  if (ts.isFunctionDeclaration(statement)) {
    return { kind: 'function', names: optionalName(statement.name), moduleSpecifier: null };
  }
  if (ts.isClassDeclaration(statement)) {
    return { kind: 'class', names: optionalName(statement.name), moduleSpecifier: null };
  }
  if (ts.isVariableStatement(statement)) {
    const names: string[] = [];
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(declaration.name, names);
    }
    return { kind: 'variable', names, moduleSpecifier: null };
  }
  if (ts.isInterfaceDeclaration(statement)) {
    return { kind: 'interface', names: [statement.name.text], moduleSpecifier: null };
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    return { kind: 'type', names: [statement.name.text], moduleSpecifier: null };
  }
  if (ts.isEnumDeclaration(statement)) {
    return { kind: 'enum', names: [statement.name.text], moduleSpecifier: null };
  }
  if (ts.isModuleDeclaration(statement)) {
    const { name } = statement;
    // `declare module 'x'` y `declare global` son augmentations, no introducen un nombre local.
    const isAugmentation = !ts.isIdentifier(name) || (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
    return { kind: 'namespace', names: isAugmentation ? [] : [name.text], moduleSpecifier: null };
  }
  if (ts.isImportDeclaration(statement)) {
    const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
    return { kind: 'import', names: importNames(statement.importClause), moduleSpecifier: specifier };
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    const reference = statement.moduleReference;
    const specifier =
      ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression)
        ? reference.expression.text
        : null;
    return { kind: 'import', names: [statement.name.text], moduleSpecifier: specifier };
  }
  if (ts.isExportDeclaration(statement)) {
    const specifier =
      statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
    return { kind: specifier !== null ? 're-export' : 'export-list', names: [], moduleSpecifier: specifier };
  }
  if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) {
    return { kind: 'export-default', names: [], moduleSpecifier: null };
  }
  return { kind: 'statement', names: [], moduleSpecifier: null };
}

function mustKeep(shape: Shape): boolean {
  switch (shape.kind) {
    case 'statement':
      return true;
    case 'import':
    case 'namespace':
      return shape.names.length === 0;
    default:
      return false;
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

/** Identificadores que solo nombran una propiedad y no pueden referirse a una declaración de nivel superior. */
function isNonReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  );
}

/**
 * Nombres de nivel superior que el nodo menciona. Es conservador: un parámetro que
 * "sombrea" un nombre de nivel superior cuenta como referencia, lo que solo puede
 * incluir de más, nunca de menos.
 */
function collectReferences(node: ts.Node, topLevel: ReadonlySet<string>, own: readonly string[]): string[] {
  const found = new Set<string>();

  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current) && topLevel.has(current.text) && !isNonReference(current)) {
      found.add(current.text);
    }
    ts.forEachChild(current, visit);
  };

  visit(node);
  for (const name of own) found.delete(name);
  return [...found].sort();
}

function readExportDeclaration(
  node: ts.ExportDeclaration,
  declaration: number,
  bindings: ExportBinding[],
  starReexports: string[],
): void {
  const clause = node.exportClause;
  const isReexport = node.moduleSpecifier !== undefined;

  if (clause === undefined) {
    if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      starReexports.push(node.moduleSpecifier.text);
    }
    return;
  }

  if (ts.isNamespaceExport(clause)) {
    bindings.push({ exportedName: clause.name.text, localName: null, declaration });
    return;
  }

  for (const element of clause.elements) {
    bindings.push({
      exportedName: element.name.text,
      // En `export { a as b }` el nombre local es `a`; en un re-export no hay nombre local.
      localName: isReexport ? null : (element.propertyName ?? element.name).text,
      declaration,
    });
  }
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

export function analyzeExports(file: string): FileExports {
  const sourceFile = parseFile(file);
  const unsupported: UnsupportedReason[] = [];
  if (!ts.isExternalModule(sourceFile)) unsupported.push('not-a-module');

  const described = sourceFile.statements.map((statement) => ({
    statement,
    shape: describeStatement(statement),
  }));
  const topLevelNames = new Set(described.flatMap(({ shape }) => shape.names));

  const declarations: TopLevelDeclaration[] = [];
  const bindings: ExportBinding[] = [];
  const starReexports: string[] = [];

  for (const { statement, shape } of described) {
    if (ts.isEmptyStatement(statement)) continue;
    if (ts.isExportAssignment(statement) && statement.isExportEquals === true) {
      unsupported.push('export-equals');
    }

    const index = declarations.length;
    const hasExportModifier = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const start = statement.getStart(sourceFile, true);
    const end = statement.getEnd();
    // Los import/export declaration no usan nombres locales: sus bindings llevan esa información.
    const skipsWalk = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement);

    declarations.push({
      kind: shape.kind,
      names: shape.names,
      hasExportModifier,
      alwaysKeep: mustKeep(shape),
      moduleSpecifier: shape.moduleSpecifier,
      references: skipsWalk ? [] : collectReferences(statement, topLevelNames, shape.names),
      start,
      end,
      startLine: lineOf(sourceFile, start),
      endLine: lineOf(sourceFile, end),
    });

    if (hasExportModifier) {
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        bindings.push({ exportedName: 'default', localName: shape.names[0] ?? null, declaration: index });
      } else {
        for (const name of shape.names) {
          bindings.push({ exportedName: name, localName: name, declaration: index });
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      readExportDeclaration(statement, index, bindings, starReexports);
    } else if (shape.kind === 'export-default') {
      bindings.push({ exportedName: 'default', localName: null, declaration: index });
    }
  }

  return { file, declarations, bindings, starReexports, unsupported };
}

export function buildExportIndex(graph: DependencyGraph): FileExports[] {
  return graph.files.map((file) => analyzeExports(file));
}