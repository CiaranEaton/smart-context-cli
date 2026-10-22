import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import ts from 'typescript';
import { FALLBACK_OPTIONS, type LoadedTsConfig } from './tsconfig.js';

export type Resolution =
  /** Archivo fuente del proyecto: entra al grafo. */
  | { kind: 'local'; file: string }
  /** Paquete de node_modules, módulo built-in o algo que no vamos a empaquetar. */
  | { kind: 'external' }
  /** Debería ser local (relativo o alias de `paths`) pero no se encontró. */
  | { kind: 'unresolved' };

export interface ModuleResolver {
  readonly tsconfigPath: string | null;
  resolve(from: string, specifier: string): Resolution;
}

const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/;
const NODE_MODULES = /[\\/]node_modules[\\/]/;

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

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

/** Resolución de imports relativos sin depender del tsconfig. */
export function resolveLocalImport(fromFile: string, specifier: string): string | null {
  const base = resolvePath(dirname(fromFile), specifier);
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

/** ¿El specifier coincide con alguna clave de `paths` (`@app/shared`, `@core/services/*`)? */
function matchesPathPattern(specifier: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const star = pattern.indexOf('*');
    if (star === -1) return pattern === specifier;

    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    return specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix);
  });
}

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

export function createModuleResolver(config: LoadedTsConfig | null): ModuleResolver {
  const options = config?.options ?? FALLBACK_OPTIONS;
  // `*` a secas es un comodín que coincide con todo: no sirve para distinguir alias de paquetes.
  const patterns = (config?.pathPatterns ?? []).filter((pattern) => pattern !== '*');
  const cache = ts.createModuleResolutionCache(
    ts.sys.getCurrentDirectory(),
    (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
    options,
  );

  return {
    tsconfigPath: config?.path ?? null,

    resolve(from: string, specifier: string): Resolution {
      const relative = isRelativeSpecifier(specifier);

      if (relative) {
        const file = resolveLocalImport(from, specifier);
        if (file !== null) return { kind: 'local', file };
      }

      const { resolvedModule } = ts.resolveModuleName(specifier, toPosix(from), options, ts.sys, cache);
      if (resolvedModule !== undefined) {
        const file = resolvePath(resolvedModule.resolvedFileName);
        // Un paquete del workspace enlazado en node_modules resuelve (vía realpath) a un
        // archivo fuera de node_modules: eso sí es código del proyecto.
        return SOURCE_FILE.test(file) && !NODE_MODULES.test(file) ? { kind: 'local', file } : { kind: 'external' };
      }

      return relative || matchesPathPattern(specifier, patterns) ? { kind: 'unresolved' } : { kind: 'external' };
    },
  };
}