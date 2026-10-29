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
import cliHermes from '../src/lib/adapters/hermes.js';
import * as seatsProxy from '@commonlyai/seats/wire/provider-proxy';
import * as cliProxy from '../src/lib/provider-proxy.js';
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

  test('the CLI provider proxy is the package module', () => {
    expect(Object.keys(cliProxy).sort()).toEqual(['PROVIDER_WIRES', 'redactProviderMaterial', 'resolveProviderKeyFile', 'startProviderProxy']);
    for (const name of Object.keys(cliProxy)) expect(cliProxy[name]).toBe(seatsProxy[name]);
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
