import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyze, assemble } from '../src/core/pipeline.js';
import { createModuleResolver } from '../src/core/resolver.js';
import { discoverTsConfig } from '../src/core/tsconfig.js';
import { formatReport, validateBundleText, type ValidationReport } from '../src/core/validator.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];

/** Crea un proyecto temporal con los archivos dados. `nx.json` marca la raíz del workspace. */
function writeProject(files: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'smart-context-'));
  tempDirs.push(directory);

  for (const [name, content] of Object.entries({ 'nx.json': '{}', ...files })) {
    const target = join(directory, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return directory;
}

after(() => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
});

function bundleOf(root: string, entry: string, trim = true) {
  const context = analyze(join(root, entry));
  return { context, assembly: assemble(context, root, trim) };
}

function validate(root: string, text: string): ValidationReport {
  return validateBundleText(text, { rootDir: root, baseline: true });
}

function assertCompiles(report: ValidationReport): void {
  assert.ok(report.ok, formatReport(report, 'el paquete de prueba'));
}

const SIMPLE_TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true },
});

const TRIM_PROJECT = {
  'tsconfig.json': SIMPLE_TSCONFIG,
  'main.ts': `import { used, Public } from './lib.js';\n\nconsole.log(used('x'), Public);\n`,
  'lib.ts': [
    `import { dep, unusedDep } from './dep.js';`,
    `import type { Config } from './types.js';`,
    ``,
    `const PREFIX = 'x';`,
    ``,
    `function helper(value: string): string {`,
    `  return PREFIX + value + dep;`,
    `}`,
    ``,
    `function neverUsed(): number {`,
    `  return unusedDep;`,
    `}`,
    ``,
    `/** Does something useful. */`,
    `export function used(input: string, config?: Config): string {`,
    `  return helper(input);`,
    `}`,
    ``,
    `export interface Options { verbose: boolean }`,
    ``,
    `export const a = 1, b = a + 1;`,
    ``,
    `class Internal {}`,
    ``,
    `export { Internal as Public, helper };`,
    ``,
    `export default function (): number { return a; }`,
    ``,
    `console.log('lib loaded');`,
    ``,
  ].join('\n'),
  'dep.ts': `export const dep = 1;\nexport const unusedDep = 2;\nexport const other = 3;\n`,
  'types.ts': `export interface Config { debug?: boolean }\nexport type Unused = string;\n`,
};

const SOLVE_PROJECT = {
  'tsconfig.json': SIMPLE_TSCONFIG,
  'main.ts': `import { alpha } from './a.js';\n\nconsole.log(alpha);\n`,
  'a.ts': `import { beta } from './b.js';\nimport { ghost } from './ghost.js';\n\nexport const alpha = beta + 1;\n\nexport function unusedA(): number {\n  return ghost;\n}\n`,
  'b.ts': `import { cyc } from './c.js';\n\nexport const beta = 2;\n\nexport function useCyc(): number {\n  return cyc;\n}\n`,
  'c.ts': `import { useCyc } from './b.js';\n\nexport const cyc = 1;\n\nexport function loop(): number {\n  return useCyc();\n}\n`,
  'ghost.ts': `export const ghost = 42;\n`,
};

/** Monorepo estilo Nx: `paths` en tsconfig.base.json, imports relativos sin extensión. */
const ALIAS_PROJECT = {
  'tsconfig.base.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      paths: {
        '@app/shared': ['libs/shared/src/index.ts'],
        '@domain/models': ['libs/domain/src/models.ts'],
        '@core/services/*': ['libs/core/src/services/*.ts'],
      },
    },
  }),
  'apps/web/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base.json' }),
  'apps/web/src/main.ts': [
    `import { greet, VERSION } from '@app/shared';`,
    `import type { User } from '@domain/models';`,
    `import { formatUser } from '@core/services/formatter';`,
    ``,
    `const user: User = { id: 1, name: 'Ana' };`,
    `console.log(greet(user.name), formatUser(user), VERSION);`,
    ``,
  ].join('\n'),
  'libs/shared/src/index.ts': `export { greet } from './greet';\nexport const VERSION = '1.0.0';\nexport const UNUSED_FLAG = true;\n`,
  'libs/shared/src/greet.ts': [
    `import { PREFIX } from './constants';`,
    ``,
    `export function greet(name: string): string {`,
    `  return PREFIX + ' ' + name;`,
    `}`,
    ``,
    `export function shout(name: string): string {`,
    `  return greet(name).toUpperCase();`,
    `}`,
    ``,
  ].join('\n'),
  'libs/shared/src/constants.ts': `export const PREFIX = 'Hola';\nexport const SUFFIX = '!';\n`,
  'libs/domain/src/models.ts': `export interface User { id: number; name: string }\nexport interface Admin extends User { role: 'admin' }\n`,
  'libs/core/src/services/formatter.ts': [
    `import type { User } from '@domain/models';`,
    ``,
    `export function formatUser(user: User): string {`,
    `  return user.id + ':' + user.name;`,
    `}`,
    ``,
    `export function formatAll(users: User[]): string {`,
    `  return users.map(formatUser).join(',');`,
    `}`,
    ``,
  ].join('\n'),
};

describe('smoke test de compilación del paquete recortado', () => {
  it('compila un paquete con imports relativos', () => {
    const root = writeProject(TRIM_PROJECT);
    const { assembly } = bundleOf(root, 'main.ts');

    assert.ok(assembly.text.includes('function helper'), 'helper debe sobrevivir porque lo usa `used`');
    assert.ok(!assembly.text.includes('neverUsed'), 'neverUsed debe haberse recortado');
    assertCompiles(validate(root, assembly.text));
  });

  it('descarta archivos huérfanos y ciclos, y lo que queda compila', () => {
    const root = writeProject(SOLVE_PROJECT);
    const { assembly } = bundleOf(root, 'main.ts');

    assert.deepEqual(
      assembly.dropped.map((file) => relative(root, file)).sort(),
      ['c.ts', 'ghost.ts'],
    );
    assertCompiles(validate(root, assembly.text));
  });

  it('resuelve alias de paths (estilo Nx) y el paquete compila', () => {
    const root = writeProject(ALIAS_PROJECT);
    const { context, assembly } = bundleOf(root, 'apps/web/src/main.ts');

    assert.equal(context.graph.unresolved.length, 0);
    assert.deepEqual(
      context.graph.files.map((file) => relative(root, file).replaceAll('\\', '/')).sort(),
      [
        'apps/web/src/main.ts',
        'libs/core/src/services/formatter.ts',
        'libs/domain/src/models.ts',
        'libs/shared/src/constants.ts',
        'libs/shared/src/greet.ts',
        'libs/shared/src/index.ts',
      ],
    );

    for (const trimmed of ['UNUSED_FLAG', 'shout', 'SUFFIX', 'Admin', 'formatAll']) {
      assert.ok(!assembly.text.includes(trimmed), `${trimmed} debería haberse recortado`);
    }
    assertCompiles(validate(root, assembly.text));
  });

  it('detecta una declaración que el recorte dejó fuera y nombra el símbolo', () => {
    const root = writeProject(TRIM_PROJECT);
    const { assembly } = bundleOf(root, 'main.ts');
    const broken = assembly.text.replace(/^function helper[\s\S]*?^\}\n/m, '');
    assert.notEqual(broken, assembly.text, 'el sabotaje debe haber modificado el paquete');

    const report = validate(root, broken);
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some((issue) => issue.code === 2304 && issue.symbol === 'helper'),
      formatReport(report, 'paquete saboteado'),
    );
  });

  it('detecta un export faltante en un módulo importado por alias', () => {
    const root = writeProject(ALIAS_PROJECT);
    const { assembly } = bundleOf(root, 'apps/web/src/main.ts');
    // Renombrar el export deja el módulo válido pero sin el miembro que importan main.ts y formatter.ts.
    const broken = assembly.text.replace('export interface User {', 'export interface Person {');
    assert.notEqual(broken, assembly.text);

    const report = validate(root, broken);
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some((issue) => issue.code === 2305 && issue.symbol === 'User'),
      formatReport(report, 'paquete saboteado'),
    );
  });

  it('no deja que un archivo descartado tape el error porque exista en disco', () => {
    const root = writeProject(SOLVE_PROJECT);
    const { assembly } = bundleOf(root, 'main.ts');
    // `ghost.ts` existe en disco pero el recorte lo descartó: importarlo debe fallar.
    const broken = assembly.text.replace(
      "import { beta } from './b.js';",
      "import { beta } from './b.js';\nimport { ghost } from './ghost.js';\nconsole.log(ghost);",
    );

    const report = validate(root, broken);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.code === 2307), formatReport(report, 'paquete saboteado'));
  });

  it('rechaza un archivo que no es un paquete', () => {
    assert.throws(() => validateBundleText('hola', { rootDir: REPO_ROOT, baseline: true }), /no contiene secciones/);
  });

  it('el propio smart-context-cli, recortado desde src/index.ts, compila', () => {
    const { assembly } = bundleOf(REPO_ROOT, join('src', 'index.ts'));
    assertCompiles(validate(REPO_ROOT, assembly.text));
  });
});

describe('resolución de alias de tsconfig', () => {
  it('usa el tsconfig del proyecto, que hereda los paths de tsconfig.base.json', () => {
    const root = writeProject(ALIAS_PROJECT);
    const config = discoverTsConfig(join(root, 'apps/web/src'));

    assert.ok(config !== null);
    assert.equal(relative(root, config.path).replaceAll('\\', '/'), 'apps/web/tsconfig.json');
    assert.deepEqual(config.pathPatterns.sort(), ['@app/shared', '@core/services/*', '@domain/models']);
  });

  it('clasifica imports como local, externo o sin resolver', () => {
    const root = writeProject(ALIAS_PROJECT);
    const config = discoverTsConfig(join(root, 'apps/web/src'));
    const resolver = createModuleResolver(config);
    const from = join(root, 'apps/web/src/main.ts');

    const shared = resolver.resolve(from, '@app/shared');
    assert.equal(shared.kind, 'local');
    assert.equal(shared.kind === 'local' ? relative(root, shared.file).replaceAll('\\', '/') : '', 'libs/shared/src/index.ts');

    const wildcard = resolver.resolve(from, '@core/services/formatter');
    assert.equal(wildcard.kind, 'local');

    assert.equal(resolver.resolve(from, '@core/services/missing').kind, 'unresolved');
    assert.equal(resolver.resolve(from, './nope').kind, 'unresolved');
    assert.equal(resolver.resolve(from, 'node:fs').kind, 'external');
    assert.equal(resolver.resolve(from, 'un-paquete-que-no-existe').kind, 'external');
  });
});