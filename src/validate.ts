#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { Command } from 'commander';
import { formatReport, validateBundleFile } from './core/validator.js';

interface ValidateOptions {
  root: string;
  tsconfig?: string;
  baseline: boolean;
}

/** Expande `*` en el nombre del archivo (PowerShell y cmd no lo hacen al llamar a Node). */
function expandPattern(pattern: string): string[] {
  const absolute = resolve(process.cwd(), pattern);
  if (!basename(absolute).includes('*')) return [absolute];

  const directory = dirname(absolute);
  if (!existsSync(directory)) return [];

  const escaped = basename(absolute)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const matcher = new RegExp(`^${escaped}$`);

  return readdirSync(directory)
    .filter((name) => matcher.test(name))
    .sort()
    .map((name) => resolve(directory, name));
}

function main(argv: readonly string[]): void {
  const program = new Command();

  program
    .name('smart-context-validate')
    .description('Compila un paquete de contexto recortado y reporta los símbolos que el recorte dejó sin resolver.')
    .argument('<bundles...>', 'Paquetes generados (admite comodín, por ejemplo context*.txt)')
    .option('-r, --root <dir>', 'Directorio contra el que se generaron las rutas del paquete', process.cwd())
    .option('-c, --tsconfig <path>', 'tsconfig a usar (por defecto se busca desde el archivo de entrada)')
    .option('--no-baseline', 'Cuenta también los errores que ya existían en el código original')
    .parse(argv);

  const patterns = program.args;
  const { root, tsconfig, baseline } = program.opts<ValidateOptions>();

  try {
    const bundles = patterns.flatMap(expandPattern);
    if (bundles.length === 0) {
      throw new Error(`Ningún archivo coincide con: ${patterns.join(', ')}`);
    }

    let failed = 0;
    for (const bundle of bundles) {
      const report = validateBundleFile(bundle, { rootDir: root, tsconfigPath: tsconfig, baseline });
      console.log(formatReport(report, relative(process.cwd(), bundle)));
      console.log('');
      if (!report.ok) failed++;
    }

    if (failed > 0) {
      console.error(`${failed} de ${bundles.length} paquete(s) no compilan.`);
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

main(process.argv);