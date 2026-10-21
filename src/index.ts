#!/usr/bin/env node
import { buildBundle } from './core/bundler.js';
import { buildExportIndex, type FileExports } from './core/exports.js';
import { buildDependencyGraph } from './core/graph.js';
import { buildUsageTable, type FileUsage } from './core/symbols.js';
import { solveContext } from './core/solver.js';
import { keepAll, type TrimResult } from './core/trimmer.js';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { Command } from 'commander';

interface CliOptions {
  file: string;
  out?: string;
  symbols?: boolean;
  exports?: boolean;
  trim: boolean;
}

function resolveTargetFile(input: string): string {
  const absolutePath = resolve(process.cwd(), input);

  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`El archivo no existe: ${absolutePath}`);
  }

  if (extname(absolutePath) !== '.ts') {
    throw new Error(`Se esperaba un archivo .ts, recibido: ${extname(absolutePath) || '(sin extensión)'}`);
  }

  return absolutePath;
}

function describeMode(usage: FileUsage): string {
  if (usage.isEntry) return 'entrada: se conserva completo';
  if (usage.keepWhole) return `completo: ${usage.wholeReasons.join(', ')}`;
  return 'recorte posible';
}

function printUsage(table: readonly FileUsage[], show: (path: string) => string): void {
  console.log(`Uso de símbolos (${table.length} archivos):`);
  for (const usage of table) {
    console.log(`  ${show(usage.file)}  [${describeMode(usage)}]`);
    if (usage.names.length > 0) {
      console.log(`    símbolos: ${usage.names.join(', ')}`);
    }
    if (usage.importedBy.length > 0) {
      console.log(`    importado por: ${usage.importedBy.map(show).join(', ')}`);
    }
  }
}

function printExports(index: readonly FileExports[], show: (path: string) => string): void {
  console.log(`Declaraciones de nivel superior (${index.length} archivos):`);
  for (const info of index) {
    console.log(`  ${show(info.file)}`);
    if (info.unsupported.length > 0) {
      console.log(`    sin recorte: ${info.unsupported.join(', ')}`);
    }

    for (const declaration of info.declarations) {
      const lines =
        declaration.startLine === declaration.endLine
          ? `L${declaration.startLine}`
          : `L${declaration.startLine}-${declaration.endLine}`;
      const label = declaration.names.length > 0 ? declaration.names.join(', ') : '(sin nombre)';

      const flags: string[] = [];
      if (declaration.hasExportModifier) flags.push('export');
      if (declaration.alwaysKeep) flags.push('siempre');
      const suffix = flags.length > 0 ? `  [${flags.join(', ')}]` : '';

      console.log(`    ${lines.padEnd(8)} ${declaration.kind.padEnd(14)} ${label}${suffix}`);
      if (declaration.references.length > 0) {
        console.log(`${' '.repeat(27)}usa: ${declaration.references.join(', ')}`);
      }
    }

    if (info.bindings.length > 0) {
      console.log(`    exporta: ${info.bindings.map((binding) => binding.exportedName).join(', ')}`);
    }
    if (info.starReexports.length > 0) {
      console.log(`    export * de: ${info.starReexports.join(', ')}`);
    }
  }
}

function printTrimReport(results: readonly TrimResult[], show: (path: string) => string): void {
  console.log('Recorte por archivo:');
  for (const result of results) {
    if (result.wholeReason !== null) {
      console.log(`  ${show(result.file)}  completo (${result.wholeReason}), ${result.keptLines} líneas`);
      continue;
    }
    console.log(`  ${show(result.file)}  recortado ${result.originalLines} -> ${result.keptLines} líneas`);
    if (result.droppedNames.length > 0) {
      console.log(`    quitó: ${result.droppedNames.join(', ')}`);
    }
  }

  const before = results.reduce((sum, result) => sum + result.originalLines, 0);
  const after = results.reduce((sum, result) => sum + result.keptLines, 0);
  console.log(`Total: ${before} -> ${after} líneas`);
}

function main(argv: readonly string[]): void {
  const program = new Command();

  program
    .name('smart-context')
    .description('Genera un paquete de contexto con las dependencias locales reales de un archivo TypeScript.')
    .version('0.1.0')
    .requiredOption('-f, --file <path>', 'Ruta del archivo .ts a analizar')
    .option('-o, --out <path>', 'Archivo donde escribir el paquete de contexto')
    .option('--symbols', 'Muestra qué símbolos usa cada archivo de sus dependencias')
    .option('--exports', 'Muestra las declaraciones de nivel superior y sus referencias internas')
    .option('--no-trim', 'Incluye cada archivo completo, sin recortar')
    .parse(argv);

  const { file, out, symbols, exports: showExports, trim } = program.opts<CliOptions>();

  try {
    const targetFile = resolveTargetFile(file);
    const graph = buildDependencyGraph(targetFile);
    const show = (path: string): string => relative(process.cwd(), path);

    console.log(`Archivo de entrada: ${show(graph.entry)}`);
    console.log(`Archivos en el contexto (${graph.files.length}):`);
    for (const path of graph.files) {
      console.log(`  ${show(path)}`);
    }

    if (graph.unresolved.length > 0) {
      console.warn(`Imports no resueltos (${graph.unresolved.length}):`);
      for (const { from, specifier } of graph.unresolved) {
        console.warn(`  ${specifier}  (en ${show(from)})`);
      }
    }

    if (symbols === true) {
      printUsage(buildUsageTable(graph), show);
    }

    if (showExports === true) {
      printExports(buildExportIndex(graph), show);
    }

    if (out !== undefined) {
      const solved = trim ? solveContext(graph) : undefined;
      const results = solved?.results ?? keepAll(graph);
      printTrimReport(results, show);

      if (solved !== undefined && solved.dropped.length > 0) {
        console.log(`Archivos descartados (${solved.dropped.length}): ${solved.dropped.map(show).join(', ')}`);
      }

      const outPath = resolve(process.cwd(), out);
      writeFileSync(outPath, buildBundle(graph, process.cwd(), results), 'utf8');
      console.log(`Paquete escrito en: ${show(outPath)}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

main(process.argv);