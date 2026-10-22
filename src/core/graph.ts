import { extractModuleSpecifiers } from './imports.js';
import { parseFile } from './parser.js';
import type { ModuleResolver } from './resolver.js';

export interface UnresolvedImport {
  from: string;
  specifier: string;
}

export interface DependencyGraph {
  entry: string;
  files: string[];
  unresolved: UnresolvedImport[];
}

export function buildDependencyGraph(entry: string, resolver: ModuleResolver): DependencyGraph {
  const visited = new Set<string>();
  const unresolved: UnresolvedImport[] = [];
  const queue: string[] = [entry];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);

    for (const specifier of extractModuleSpecifiers(parseFile(current))) {
      const resolution = resolver.resolve(current, specifier);

      if (resolution.kind === 'unresolved') {
        unresolved.push({ from: current, specifier });
      } else if (resolution.kind === 'local' && !visited.has(resolution.file)) {
        queue.push(resolution.file);
      }
    }
  }

  return { entry, files: [...visited], unresolved };
}