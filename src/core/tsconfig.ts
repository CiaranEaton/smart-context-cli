import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

export interface LoadedTsConfig {
  /** Ruta absoluta del tsconfig cargado. */
  path: string;
  /** Opciones ya fusionadas con `extends`. */
  options: ts.CompilerOptions;
  /** Claves de `compilerOptions.paths` (por ejemplo `@app/shared`, `@core/services/*`). */
  pathPatterns: string[];
}

/** Opciones que se usan cuando el proyecto analizado no tiene tsconfig. */
export const FALLBACK_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
};

/** TS18003: "No inputs were found in config file". No nos importa: solo queremos las opciones. */
const NO_INPUTS_ERROR = 18003;

const CANDIDATE_NAMES = ['tsconfig.json', 'tsconfig.base.json'] as const;

/** Si un directorio contiene alguno de estos, es la raíz del workspace y no se sigue subiendo. */
const WORKSPACE_MARKERS = ['.git', 'nx.json', 'turbo.json', 'pnpm-workspace.yaml', 'lerna.json'] as const;

function flatten(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

export function loadTsConfig(configPath: string): LoadedTsConfig {
  const absolutePath = resolve(configPath);
  if (!ts.sys.fileExists(absolutePath)) {
    throw new Error(`No existe el tsconfig: ${absolutePath}`);
  }

  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    // No expandimos `include`: evita escanear todo el monorepo solo para leer opciones.
    readDirectory: () => [],
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(`tsconfig inválido (${absolutePath}): ${flatten(diagnostic)}`);
    },
  };

  const parsed = ts.getParsedCommandLineOfConfigFile(absolutePath, undefined, host);
  if (parsed === undefined) {
    throw new Error(`No se pudo leer el tsconfig: ${absolutePath}`);
  }

  const blocking = parsed.errors.filter((diagnostic) => diagnostic.code !== NO_INPUTS_ERROR);
  if (blocking.length > 0) {
    throw new Error(`tsconfig con errores (${absolutePath}):\n  ${blocking.map(flatten).join('\n  ')}`);
  }

  return {
    path: absolutePath,
    options: parsed.options,
    pathPatterns: Object.keys(parsed.options.paths ?? {}),
  };
}

/**
 * Busca el tsconfig que aplica a `startDir`, subiendo por los directorios padre.
 * Prefiere el primero que declare `paths` (típico de `tsconfig.base.json` en Nx);
 * si ninguno lo hace, devuelve el primero que encontró.
 */
export function discoverTsConfig(startDir: string): LoadedTsConfig | null {
  let directory = resolve(startDir);
  let fallback: LoadedTsConfig | null = null;

  for (;;) {
    for (const name of CANDIDATE_NAMES) {
      const candidate = join(directory, name);
      if (!ts.sys.fileExists(candidate)) continue;

      const loaded = loadTsConfig(candidate);
      if (loaded.pathPatterns.length > 0) return loaded;
      fallback ??= loaded;
    }

    const isWorkspaceRoot = WORKSPACE_MARKERS.some(
      (marker) => ts.sys.fileExists(join(directory, marker)) || ts.sys.directoryExists(join(directory, marker)),
    );
    const parent = dirname(directory);
    if (isWorkspaceRoot || parent === directory) return fallback;
    directory = parent;
  }
}