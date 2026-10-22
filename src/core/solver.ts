import ts from 'typescript';
import { analyzeExports, type FileExports } from './exports.js';
import type { DependencyGraph } from './graph.js';
import type { ModuleResolver } from './resolver.js';
import { collectImportRecords, type FileUsage, type WholeReason } from './symbols.js';
import { trimFile, type TrimResult } from './trimmer.js';

interface Demand {
  names: Set<string>;
  reasons: Set<WholeReason>;
  importedBy: Set<string>;
}

export interface SolveResult {
  results: TrimResult[];
  dropped: string[];
  renders: number;
}

function createDemand(): Demand {
  return { names: new Set(), reasons: new Set(), importedBy: new Set() };
}

function toUsage(file: string, demand: Demand, entry: string): FileUsage {
  const isEntry = file === entry;
  return {
    file,
    isEntry,
    names: [...demand.names].sort(),
    wholeReasons: [...demand.reasons],
    importedBy: [...demand.importedBy],
    keepWhole: isEntry || demand.reasons.size > 0,
  };
}

export function solveContext(graph: DependencyGraph, resolver: ModuleResolver): SolveResult {
  const knownFiles = new Set(graph.files);
  const demands = new Map<string, Demand>([[graph.entry, createDemand()]]);
  const exportsCache = new Map<string, FileExports>();
  const rendered = new Map<string, TrimResult>();
  const queue: string[] = [graph.entry];
  const queued = new Set<string>(queue);
  let renders = 0;

  const exportsOf = (file: string): FileExports => {
    const cached = exportsCache.get(file);
    if (cached !== undefined) return cached;
    const info = analyzeExports(file);
    exportsCache.set(file, info);
    return info;
  };

  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    queued.delete(file);
    const demand = demands.get(file);
    if (demand === undefined) continue;

    const result = trimFile(toUsage(file, demand, graph.entry), exportsOf(file));
    rendered.set(file, result);
    renders++;

    const trimmed = ts.createSourceFile(file, result.content, ts.ScriptTarget.Latest, true);
    for (const record of collectImportRecords(trimmed)) {
      const resolution = resolver.resolve(file, record.specifier);
      if (resolution.kind !== 'local' || !knownFiles.has(resolution.file)) continue;
      const target = resolution.file;

      let targetDemand = demands.get(target);
      let changed = false;
      if (targetDemand === undefined) {
        targetDemand = createDemand();
        demands.set(target, targetDemand);
        changed = true;
      }

      for (const name of record.names) {
        if (!targetDemand.names.has(name)) {
          targetDemand.names.add(name);
          changed = true;
        }
      }
      if (record.whole !== null && !targetDemand.reasons.has(record.whole)) {
        targetDemand.reasons.add(record.whole);
        changed = true;
      }
      targetDemand.importedBy.add(file);

      if (changed && !queued.has(target)) {
        queued.add(target);
        queue.push(target);
      }
    }
  }

  const results = graph.files.flatMap((file) => {
    const result = rendered.get(file);
    return result === undefined ? [] : [result];
  });
  const dropped = graph.files.filter((file) => !rendered.has(file));

  return { results, dropped, renders };
}