import { extractLocalSpecifiers } from './imports.js';
import { parseFile } from './parser.js';
import { resolveLocalImport } from './resolver.js';

export interface UnresolvedImport {
  from: string;
  specifier: string;
}

export interface DependencyGraph {
  entry: string;
  files: string[];
  unresolved: UnresolvedImport[];
}

export function buildDependencyGraph(entry: string): DependencyGraph {
  const visited = new Set<string>();
  const unresolved: UnresolvedImport[] = [];
  const queue: string[] = [entry];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);

    for (const specifier of extractLocalSpecifiers(parseFile(current))) {
      const resolved = resolveLocalImport(current, specifier);
      if (resolved === null) {
        unresolved.push({ from: current, specifier });
      } else if (!visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return { entry, files: [...visited], unresolved };
}