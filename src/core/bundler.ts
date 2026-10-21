import { relative } from 'node:path';
import type { DependencyGraph } from './graph.js';
import type { TrimResult } from './trimmer.js';

export function buildBundle(graph: DependencyGraph, rootDir: string, results: readonly TrimResult[]): string {
  const toDisplay = (path: string): string => relative(rootDir, path).replaceAll('\\', '/');

  const before = results.reduce((sum, result) => sum + result.originalLines, 0);
  const after = results.reduce((sum, result) => sum + result.keptLines, 0);

  const header = [
    '// smart-context bundle',
    `// Entry: ${toDisplay(graph.entry)}`,
    `// Files: ${results.length}`,
    `// Lines: ${after} (original: ${before})`,
    '',
  ].join('\n');

  const sections = results.map((result) => {
    const note =
      result.wholeReason === null ? ` [trimmed: ${result.originalLines} -> ${result.keptLines} lines]` : '';
    return `// ===== FILE: ${toDisplay(result.file)}${note} =====\n${result.content}\n`;
  });

  return [header, ...sections].join('\n');
}