import { dirname } from 'node:path';
import { buildBundle } from './bundler.js';
import { buildDependencyGraph, type DependencyGraph } from './graph.js';
import { createModuleResolver, type ModuleResolver } from './resolver.js';
import { solveContext } from './solver.js';
import { discoverTsConfig, loadTsConfig, type LoadedTsConfig } from './tsconfig.js';
import { keepAll, type TrimResult } from './trimmer.js';

export interface AnalysisContext {
  entry: string;
  graph: DependencyGraph;
  resolver: ModuleResolver;
  tsconfig: LoadedTsConfig | null;
}

export interface Assembly {
  results: TrimResult[];
  dropped: string[];
  text: string;
}

/** Carga el tsconfig (el indicado o el que aplica a `entry`) y construye el grafo de dependencias. */
export function analyze(entry: string, tsconfigPath?: string): AnalysisContext {
  const tsconfig = tsconfigPath !== undefined ? loadTsConfig(tsconfigPath) : discoverTsConfig(dirname(entry));
  const resolver = createModuleResolver(tsconfig);
  const graph = buildDependencyGraph(entry, resolver);
  return { entry, graph, resolver, tsconfig };
}

/** Recorta (o no) cada archivo del grafo y arma el texto del paquete. */
export function assemble(context: AnalysisContext, rootDir: string, trim: boolean): Assembly {
  if (!trim) {
    const results = keepAll(context.graph);
    return { results, dropped: [], text: buildBundle(context.graph, rootDir, results) };
  }

  const solved = solveContext(context.graph, context.resolver);
  return {
    results: solved.results,
    dropped: solved.dropped,
    text: buildBundle(context.graph, rootDir, solved.results),
  };
}