import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { ExportBinding, FileExports } from './exports.js';
import type { DependencyGraph } from './graph.js';
import { parseFile } from './parser.js';
import type { FileUsage } from './symbols.js';

export interface TrimResult {
  file: string;
  content: string;
  /** Motivo por el que se conserva completo; null si se recortó. */
  wholeReason: string | null;
  originalLines: number;
  keptLines: number;
  droppedNames: string[];
}

interface RenderContext {
  sourceFile: ts.SourceFile;
  /** Nombres de nivel superior que usa lo que se conserva. */
  used: ReadonlySet<string>;
  /** Nombres públicos pedidos, por índice de la declaración de export que los produce. */
  wanted: ReadonlyMap<number, ReadonlySet<string>>;
}

interface Trimmed {
  content: string;
  droppedNames: string[];
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

function wholeResult(file: string, text: string, reason: string): TrimResult {
  const content = text.replace(/\r\n/g, '\n').trimEnd();
  const lines = countLines(content);
  return { file, content, wholeReason: reason, originalLines: lines, keptLines: lines, droppedNames: [] };
}

function wholeReason(usage: FileUsage, info: FileExports): string | null {
  if (usage.isEntry) return 'entrada';
  if (usage.wholeReasons.length > 0) return usage.wholeReasons.join(', ');
  if (info.unsupported.length > 0) return info.unsupported.join(', ');
  if (info.starReexports.length > 0) return 'export-all propio';
  if (usage.names.length === 0) return 'sin símbolos pedidos';
  return null;
}

function renderImport(ctx: RenderContext, node: ts.ImportDeclaration, original: string): string | null {
  const clause = node.importClause;
  if (clause === undefined) return original;

  const parts: string[] = [];
  let complete = true;

  if (clause.name !== undefined) {
    if (ctx.used.has(clause.name.text)) parts.push(clause.name.text);
    else complete = false;
  }

  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) {
      if (ctx.used.has(bindings.name.text)) parts.push(`* as ${bindings.name.text}`);
      else complete = false;
    } else {
      const kept = bindings.elements.filter((element) => ctx.used.has(element.name.text));
      if (kept.length !== bindings.elements.length) complete = false;
      if (kept.length > 0) {
        parts.push(`{ ${kept.map((element) => element.getText(ctx.sourceFile)).join(', ')} }`);
      }
    }
  }

  if (complete) return original;
  if (parts.length === 0) return null;

  const first = clause.name ?? bindings;
  if (first === undefined) return original;

  const { sourceFile } = ctx;
  return (
    sourceFile.text.slice(node.getStart(sourceFile), first.getStart(sourceFile)) +
    parts.join(', ') +
    sourceFile.text.slice(clause.getEnd(), node.getEnd())
  );
}

function renderExport(
  ctx: RenderContext,
  node: ts.ExportDeclaration,
  index: number,
  original: string,
): string | null {
  const wanted = ctx.wanted.get(index);
  if (wanted === undefined) return null;

  const clause = node.exportClause;
  if (clause === undefined) return original;
  if (ts.isNamespaceExport(clause)) return wanted.has(clause.name.text) ? original : null;

  const kept = clause.elements.filter((element) => wanted.has(element.name.text));
  if (kept.length === 0) return null;
  if (kept.length === clause.elements.length) return original;

  const { sourceFile } = ctx;
  return (
    sourceFile.text.slice(node.getStart(sourceFile), clause.getStart(sourceFile)) +
    `{ ${kept.map((element) => element.getText(sourceFile)).join(', ')} }` +
    sourceFile.text.slice(clause.getEnd(), node.getEnd())
  );
}

/** Devuelve el contenido recortado, o un motivo (string) si hay que conservar el archivo completo. */
function attemptTrim(sourceFile: ts.SourceFile, usage: FileUsage, info: FileExports): Trimmed | string {
  const statements = sourceFile.statements.filter((statement) => !ts.isEmptyStatement(statement));
  const aligned =
    statements.length === info.declarations.length &&
    statements.every((statement, i) => statement.getStart(sourceFile, true) === info.declarations[i]?.start);
  if (!aligned) return 'índice desalineado';

  // 1. Bindings pedidos por los importadores.
  const requested = new Set<ExportBinding>();
  for (const name of usage.names) {
    const matches = info.bindings.filter((binding) => binding.exportedName === name);
    if (matches.length === 0) return `símbolo no encontrado: ${name}`;
    for (const match of matches) requested.add(match);
  }

  // 2. Cierre de alcanzabilidad.
  const byName = new Map<string, number[]>();
  info.declarations.forEach((declaration, index) => {
    for (const name of declaration.names) {
      const list = byName.get(name);
      if (list === undefined) byName.set(name, [index]);
      else list.push(index);
    }
  });

  const keep = new Set<number>();
  const pending: number[] = [];
  const add = (index: number): void => {
    if (!keep.has(index)) {
      keep.add(index);
      pending.push(index);
    }
  };
  const addName = (name: string): void => {
    for (const index of byName.get(name) ?? []) add(index);
  };

  info.declarations.forEach((declaration, index) => {
    if (declaration.alwaysKeep) add(index);
  });
  for (const binding of requested) {
    add(binding.declaration);
    if (binding.localName !== null) addName(binding.localName);
  }
  for (let index = pending.pop(); index !== undefined; index = pending.pop()) {
    for (const reference of info.declarations[index]?.references ?? []) addName(reference);
  }

  // 3. Qué nombres usa lo que se conserva (decide qué sobrevive en cada import).
  const used = new Set<string>();
  for (const index of keep) {
    for (const reference of info.declarations[index]?.references ?? []) used.add(reference);
  }
  for (const binding of requested) {
    if (binding.localName !== null) used.add(binding.localName);
  }

  const wanted = new Map<number, Set<string>>();
  for (const binding of requested) {
    const names = wanted.get(binding.declaration) ?? new Set<string>();
    names.add(binding.exportedName);
    wanted.set(binding.declaration, names);
  }

  // 4. Reescritura.
  const ctx: RenderContext = { sourceFile, used, wanted };
    const pieces: Array<{ index: number; text: string }> = [];

  statements.forEach((statement, index) => {
    const declaration = info.declarations[index];
    if (declaration === undefined || !keep.has(index)) return;

    const original = sourceFile.text.slice(declaration.start, declaration.end);
    let rendered: string | null = original;
    if (ts.isImportDeclaration(statement)) rendered = renderImport(ctx, statement, original);
    else if (ts.isExportDeclaration(statement)) rendered = renderExport(ctx, statement, index, original);

    if (rendered !== null) pieces.push({ index, text: rendered });
  });

  const content = pieces
    .map((piece, i) => {
      const previous = pieces[i - 1];
      if (previous === undefined) return piece.text;

      const before = info.declarations[previous.index];
      const after = info.declarations[piece.index];
      if (before === undefined || after === undefined) return `\n\n${piece.text}`;

      // Contiguas en el original: se conserva el espacio (y comentarios) que había entre ellas.
      if (piece.index === previous.index + 1) {
        return sourceFile.text.slice(before.end, after.start) + piece.text;
      }
      const bothImports = before.kind === 'import' && after.kind === 'import';
      return (bothImports ? '\n' : '\n\n') + piece.text;
    })
    .join('')
    .replace(/\r\n/g, '\n');

  const droppedNames = info.declarations.flatMap((declaration, index) =>
    keep.has(index) || declaration.kind === 'import' ? [] : declaration.names,
  );

  return { content, droppedNames };
}

export function trimFile(usage: FileUsage, info: FileExports): TrimResult {
  const file = usage.file;
  const sourceFile = parseFile(file);
  const text = sourceFile.text;
  const reason = wholeReason(usage, info);
  const outcome = reason ?? attemptTrim(sourceFile, usage, info);

  if (typeof outcome === 'string') return wholeResult(file, text, outcome);

  return {
    file,
    content: outcome.content,
    wholeReason: null,
    originalLines: countLines(text.trimEnd()),
    keptLines: countLines(outcome.content),
    droppedNames: outcome.droppedNames,
  };
}

/** Equivalente a `--no-trim`: cada archivo completo. */
export function keepAll(graph: DependencyGraph): TrimResult[] {
  return graph.files.map((file) => wholeResult(file, readFileSync(file, 'utf8'), 'sin recorte (--no-trim)'));
}