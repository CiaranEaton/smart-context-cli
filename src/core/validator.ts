import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { parseBundle, type BundleSection } from './bundle-format.js';
import { discoverTsConfig, FALLBACK_OPTIONS, loadTsConfig, type LoadedTsConfig } from './tsconfig.js';

export interface ValidationOptions {
  /** Directorio contra el que se generaron las rutas del paquete (normalmente el cwd). */
  rootDir: string;
  /** tsconfig a usar; si no se indica, se busca desde el archivo de entrada del paquete. */
  tsconfigPath?: string | undefined;
  /** Si es true, ignora los errores que ya existían en el código original. */
  baseline: boolean;
}

export interface ValidationIssue {
  /** Ruta del archivo tal como aparece en el paquete. */
  file: string;
  /** Línea dentro del archivo recortado. */
  line: number;
  column: number;
  /** Línea correspondiente dentro del archivo de paquete. */
  bundleLine: number;
  code: number;
  message: string;
  /** Nombre que TypeScript no pudo resolver (si el error es de ese tipo). */
  symbol: string | null;
}

export interface ValidationReport {
  ok: boolean;
  files: string[];
  tsconfig: string | null;
  issues: ValidationIssue[];
  /** Errores que ya existían en el código original y por eso no se cuentan. */
  inheritedErrors: number;
}

const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/;
const NODE_MODULES = /[\\/]node_modules[\\/]/;

/**
 * Códigos de error de "no se pudo resolver X" y en qué comilla del mensaje viene el nombre.
 * 2304/2552: Cannot find name 'X'. 2503: Cannot find namespace 'X'. 2307: Cannot find module 'X'.
 * 2305/2614/2724: Module 'M' has no exported member 'X'. 2459/2460: declares 'X' locally but not exported.
 */
const SYMBOL_ARGUMENT: ReadonlyMap<number, number> = new Map<number, number>([
  [2304, 0],
  [2552, 0],
  [2503, 0],
  [2307, 0],
  [2305, 1],
  [2614, 1],
  [2724, 1],
  [2459, 1],
  [2460, 1],
]);

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

function pathKey(path: string): string {
  const normalized = toPosix(resolve(path));
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function extractSymbol(code: number, message: string): string | null {
  const index = SYMBOL_ARGUMENT.get(code);
  if (index === undefined) return null;
  const quoted = [...message.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return quoted[index] ?? null;
}

/** Opciones del proyecto, ajustadas para comprobar tipos sin emitir nada. */
function toValidationOptions(base: ts.CompilerOptions): ts.CompilerOptions {
  const options: ts.CompilerOptions = { ...base, noEmit: true, skipLibCheck: true, composite: false, incremental: false };
  delete options.rootDir;
  delete options.outDir;
  delete options.declarationDir;
  delete options.tsBuildInfoFile;
  delete options.emitDeclarationOnly;
  return options;
}

interface VirtualFiles {
  contents: Map<string, string>;
  directories: Set<string>;
}

function buildVirtualFiles(sections: readonly BundleSection[], rootDir: string): VirtualFiles {
  const contents = new Map<string, string>();
  const directories = new Set<string>();

  for (const section of sections) {
    const absolute = resolve(rootDir, section.path);
    contents.set(pathKey(absolute), section.content);

    for (let directory = dirname(absolute); ; directory = dirname(directory)) {
      directories.add(pathKey(directory));
      if (dirname(directory) === directory) break;
    }
  }

  return { contents, directories };
}

/**
 * Host que ve el paquete recortado y nada más del proyecto: los archivos del paquete se leen
 * de memoria, node_modules y las libs de TypeScript del disco, y cualquier otro archivo fuente
 * se trata como inexistente. Así, si el recorte dejó un import apuntando a un archivo que
 * descartó, el error no queda tapado porque ese archivo exista en disco.
 */
function createBundleHost(options: ts.CompilerOptions, virtual: VirtualFiles): ts.CompilerHost {
  const base = ts.createCompilerHost(options, true);
  const libDirectory = pathKey(dirname(ts.getDefaultLibFilePath(options)));

  const isProjectSource = (fileName: string): boolean => {
    const key = pathKey(fileName);
    return SOURCE_FILE.test(key) && !NODE_MODULES.test(key) && !key.startsWith(`${libDirectory}/`);
  };

  return {
    ...base,
    fileExists: (fileName) =>
      virtual.contents.has(pathKey(fileName)) || (!isProjectSource(fileName) && base.fileExists(fileName)),
    readFile: (fileName) =>
      virtual.contents.get(pathKey(fileName)) ?? (isProjectSource(fileName) ? undefined : base.readFile(fileName)),
    directoryExists: (directoryName) =>
      virtual.directories.has(pathKey(directoryName)) || (base.directoryExists?.(directoryName) ?? false),
    getSourceFile: (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
      const text = virtual.contents.get(pathKey(fileName));
      if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
      if (isProjectSource(fileName)) return undefined;
      return base.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    },
  };
}

/** Errores sintácticos y semánticos de los archivos indicados (los de configuración global se ignoran). */
function collectErrors(program: ts.Program, files: readonly string[]): ts.Diagnostic[] {
  return files
    .flatMap((file) => {
      const sourceFile = program.getSourceFile(file);
      if (sourceFile === undefined) return [];
      return [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
    })
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
}

function diagnosticKey(diagnostic: ts.Diagnostic): string {
  const file = diagnostic.file === undefined ? '' : pathKey(diagnostic.file.fileName);
  return `${file}|${diagnostic.code}|${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
}

function pickTsConfig(sections: readonly BundleSection[], options: ValidationOptions): LoadedTsConfig | null {
  if (options.tsconfigPath !== undefined) return loadTsConfig(options.tsconfigPath);
  const entry = sections[0];
  return entry === undefined ? null : discoverTsConfig(dirname(resolve(options.rootDir, entry.path)));
}

export function validateBundleText(text: string, options: ValidationOptions): ValidationReport {
  const sections = parseBundle(text);
  if (sections.length === 0) {
    throw new Error('El archivo no contiene secciones "// ===== FILE: <ruta> =====". ¿Es un paquete generado por smart-context?');
  }

  const rootDir = resolve(options.rootDir);
  const config = pickTsConfig(sections, options);
  const compilerOptions = toValidationOptions(config?.options ?? FALLBACK_OPTIONS);

  const files = sections.map((section) => resolve(rootDir, section.path));
  const sectionByKey = new Map(sections.map((section, i) => [pathKey(files[i] ?? section.path), section]));

  const virtual = buildVirtualFiles(sections, rootDir);
  const trimmedProgram = ts.createProgram({
    rootNames: files,
    options: compilerOptions,
    host: createBundleHost(compilerOptions, virtual),
  });

  // Errores que ya tenía el código original: se restan para quedarnos solo con los que causó el recorte.
  const inherited = new Map<string, number>();
  if (options.baseline) {
    const originalProgram = ts.createProgram({ rootNames: files, options: compilerOptions });
    for (const diagnostic of collectErrors(originalProgram, files)) {
      const key = diagnosticKey(diagnostic);
      inherited.set(key, (inherited.get(key) ?? 0) + 1);
    }
  }

  const issues: ValidationIssue[] = [];
  let inheritedErrors = 0;

  files.forEach((file, i) => {
    if (trimmedProgram.getSourceFile(file) === undefined) {
      issues.push({
        file: sections[i]?.path ?? file,
        line: 1,
        column: 1,
        bundleLine: sections[i]?.firstLine ?? 1,
        code: 6053,
        message: 'TypeScript no pudo cargar este archivo del paquete.',
        symbol: null,
      });
    }
  });

  for (const diagnostic of collectErrors(trimmedProgram, files)) {
    const key = diagnosticKey(diagnostic);
    const remaining = inherited.get(key) ?? 0;
    if (remaining > 0) {
      inherited.set(key, remaining - 1);
      inheritedErrors++;
      continue;
    }

    const sourceFile = diagnostic.file;
    if (sourceFile === undefined) continue;
    const section = sectionByKey.get(pathKey(sourceFile.fileName));
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');

    issues.push({
      file: section?.path ?? toPosix(relative(rootDir, sourceFile.fileName)),
      line: line + 1,
      column: character + 1,
      bundleLine: (section?.firstLine ?? 1) + line,
      code: diagnostic.code,
      message,
      symbol: extractSymbol(diagnostic.code, message),
    });
  }

  return {
    ok: issues.length === 0,
    files: sections.map((section) => section.path),
    tsconfig: config === null ? null : toPosix(relative(rootDir, config.path)),
    issues,
    inheritedErrors,
  };
}

export function validateBundleFile(bundlePath: string, options: ValidationOptions): ValidationReport {
  let text: string;
  try {
    text = readFileSync(bundlePath, 'utf8');
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo leer el paquete ${bundlePath}: ${reason}`);
  }
  return validateBundleText(text, options);
}

export function formatReport(report: ValidationReport, label: string): string {
  const lines: string[] = [
    `Validación de ${label}`,
    `  tsconfig: ${report.tsconfig ?? '(no encontrado: opciones por defecto)'}`,
    `  archivos verificados: ${report.files.length}`,
  ];
  if (report.inheritedErrors > 0) {
    lines.push(`  errores heredados del código original (ignorados): ${report.inheritedErrors}`);
  }

  if (report.ok) {
    lines.push('OK: el paquete recortado compila sin errores nuevos.');
    return lines.join('\n');
  }

  lines.push(`FALLO: el recorte introdujo ${report.issues.length} error(es):`);
  for (const issue of report.issues) {
    lines.push(`  ${issue.file}:${issue.line}:${issue.column}  (paquete, línea ${issue.bundleLine})  TS${issue.code}`);
    lines.push(`    ${issue.message.split('\n').join('\n    ')}`);
  }

  const unresolved = [...new Set(report.issues.flatMap((issue) => (issue.symbol === null ? [] : [issue.symbol])))];
  if (unresolved.length > 0) {
    lines.push(`Símbolos sin resolver: ${unresolved.join(', ')}`);
    lines.push('Probablemente el recorte descartó una declaración que sigue usándose: revisa esos nombres.');
  }
  return lines.join('\n');
}