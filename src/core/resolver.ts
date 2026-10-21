import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** En NodeNext, './foo.js' en el código apunta a './foo.ts' en disco. */
function toTypeScriptPath(path: string): string | null {
  const match = /\.(m|c)?js$/.exec(path);
  if (match === null) return null;
  const ext = match[1] === 'm' ? '.mts' : match[1] === 'c' ? '.cts' : '.ts';
  return path.slice(0, -match[0].length) + ext;
}

export function resolveLocalImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const jsMapped = toTypeScriptPath(base);

  const candidates: string[] = [
    base,
    ...(jsMapped !== null ? [jsMapped] : []),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];

  return candidates.find(isFile) ?? null;
}