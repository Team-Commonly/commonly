/**
 * packages/seats is the runtime the CLI bundles (D62, extract-in-place). These
 * tests hold the two properties the move depends on: the package imports
 * nothing from Commonly, and the CLI tarball carries it.
 */
import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, statSync } from 'fs';
import { builtinModules } from 'module';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { createHermesAdapter, createRegistry, stub } from '@commonlyai/seats';
import * as pkgBwrap from '@commonlyai/seats/sandbox/bwrap';
import * as pkgSeatbelt from '@commonlyai/seats/sandbox/seatbelt';
import * as cliBwrap from '../src/lib/sandbox/bwrap.js';
import * as cliSeatbelt from '../src/lib/sandbox/seatbelt.js';
import cliHermes from '../src/lib/adapters/hermes.js';
import { getAdapter } from '../src/lib/adapters/index.js';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEATS = resolve(CLI, '..', 'packages', 'seats');

const sourceFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? sourceFiles(full) : (full.endsWith('.js') ? [full] : []);
});

const specifiers = (code) => [
  ...code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"`;]*?from\s*['"]([^'"]+)['"]/g),
  ...code.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g),
  ...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
].map((match) => match[1]);

// Modules moved into the package whole (D65: move code, never copy it). The cli
// path stays for its callers and must hold nothing but a re-export, or the two
// copies drift. hermes.js is not here: it binds Commonly policy, which is logic
// that belongs in the cli.
const MOVED = {
  'src/lib/adapters/stub.js': null,
  'src/lib/sandbox/seatbelt.js': [cliSeatbelt, pkgSeatbelt],
  'src/lib/sandbox/bwrap.js': [cliBwrap, pkgBwrap],
};

/** Statements left once comments go; a re-export-only file has nothing else. */
const nonReexportStatements = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean)
  .filter((statement) => !/^export\s+(?:\*|\{[^}]*\})\s+from\s+'@commonlyai\/seats(?:\/[\w/-]+)?'$/.test(statement));

describe('packages/seats', () => {
  test('imports only node built-ins and its own modules', () => {
    const builtins = new Set(builtinModules);
    const files = sourceFiles(join(SEATS, 'src'));
    expect(files.length).toBeGreaterThan(5);
    const outside = [];
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('node:') || builtins.has(spec)) continue;
        const target = spec.startsWith('.') ? resolve(dirname(file), spec) : null;
        if (target && (target + sep).startsWith(join(SEATS, 'src') + sep)) continue;
        outside.push(`${relative(SEATS, file)} → ${spec}`);
      }
    }
    expect(outside).toEqual([]);
  });

  test('the boundary scan sees a bad import', () => {
    expect(specifiers("import x from '../../cli/src/lib/environment.js';\nexport { y } from 'commander';"))
      .toEqual(['../../cli/src/lib/environment.js', 'commander']);
  });

  test('a module moved into the package is only a re-export at its cli path', () => {
    for (const [path, modules] of Object.entries(MOVED)) {
      expect([path, nonReexportStatements(readFileSync(join(CLI, path), 'utf8'))]).toEqual([path, []]);
      if (!modules) continue;
      const [cli, pkg] = modules;
      expect(Object.keys(cli).sort()).toEqual(Object.keys(pkg).sort());
      for (const name of Object.keys(pkg)) expect([path, name, cli[name] === pkg[name]]).toEqual([path, name, true]);
    }
  });

  test('the re-export scan sees logic pasted beside a re-export', () => {
    expect(nonReexportStatements("// moved\nexport * from '@commonlyai/seats/sandbox/bwrap';")).toEqual([]);
    expect(nonReexportStatements("export * from '@commonlyai/seats/sandbox/bwrap';\nexport const f = () => 1;"))
      .toEqual(['export const f = () => 1']);
    expect(nonReexportStatements("export * from './local.js';")).toEqual(["export * from './local.js'"]);
  });

  test('the CLI registry serves the bound adapters', () => {
    expect(getAdapter('stub')).toBe(stub);
    expect(getAdapter('hermes')).toBe(cliHermes);
    expect(Object.keys(cliHermes).sort()).toEqual(
      Object.keys(createHermesAdapter()).sort(),
    );
  });

  test('a host-less Hermes adapter takes the neutral defaults', async () => {
    const hermes = createHermesAdapter();
    expect(hermes.requiresModel).toBe(false);
    await expect(hermes.validateEnvironment({ sandbox: { trust: 'public' } }))
      .rejects.toThrow('no enforced confinement adapter exists');
  });

  test('a registry refuses duplicate names', () => {
    expect(() => createRegistry([stub, stub])).toThrow('duplicate adapter name: stub');
    expect(createRegistry([stub]).get('stub')).toBe(stub);
  });

  test('the CLI tarball bundles every package source file', () => {
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: CLI, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }));
    const packed = new Set(pack.files.map((file) => file.path));
    const expected = sourceFiles(join(SEATS, 'src'))
      .map((file) => `node_modules/@commonlyai/seats/${relative(SEATS, file).split(sep).join('/')}`);
    expect(expected.filter((path) => !packed.has(path))).toEqual([]);
  }, 60000);
});
