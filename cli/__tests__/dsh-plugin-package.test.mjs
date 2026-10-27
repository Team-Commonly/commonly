/**
 * packages/dsh-plugin is a dsh bundle: package.json plus one patch file, no code.
 * Nothing else in CI reads it, so these checks are what keep it in step with the
 * dsh adapter's own MCP row and keep credentials out of the published files.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { TESTED_DSH_VERSIONS, buildPatch, resolveCommonlyMcp } from '../src/lib/adapters/dsh.js';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'dsh-plugin');
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
const patchPath = join(PACKAGE_DIR, manifest.dsh.bundle.patch);

/**
 * dsh reads a bundle patch with js-yaml's JSON schema plus one `!!js` scalar
 * type that constructs `{ __jsExpr: <source> }` (vendor/include/src/index.ts at
 * dsh-v0.2.1-rc.2). The cli has no YAML parser, so the patch is kept to JSON
 * flow style and this applies the only two YAML features it uses: full-line
 * comments and `!!js "<string>"`. Anything else fails JSON.parse, by design.
 */
const parsePatch = (text) => JSON.parse(text
  .split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
  .replace(/!!js\s+("(?:[^"\\]|\\.)*")/g, '{"__jsExpr": $1}'));

/** dsh's evaluator (vendor/loader/src/config/utils.ts): sloppy-mode `with`, then eval. */
// eslint-disable-next-line no-new-func
const evaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }');

const expressionPaths = (value, path = []) => {
  if (!value || typeof value !== 'object') return [];
  if ('__jsExpr' in value) return [path.join('.')];
  return Object.entries(value).flatMap(([key, child]) => expressionPaths(child, [...path, key]));
};

const patch = parsePatch(readFileSync(patchPath, 'utf8'));
const inserted = patch.flatMap((entry) => entry.insert || []);
const row = inserted.find((entry) => entry.id === 'mcp-commonly');

test('the manifest is a private dsh bundle pinned to the dsh version the adapter tested', () => {
  expect(manifest.private).toBe(true);
  expect(manifest.license).toBe('Apache-2.0');
  expect(manifest.keywords).toContain('dsh-plugin');
  expect(manifest.repository).toMatchObject({
    url: 'git+https://github.com/Team-Commonly/commonly.git', directory: 'packages/dsh-plugin',
  });
  expect(existsSync(patchPath)).toBe(true);
  expect(manifest.files).toContain(manifest.dsh.bundle.patch.replace(/^\.\//, ''));
  expect(TESTED_DSH_VERSIONS).toContain(manifest.engines.dsh);
  // Bundle-only: no row names this package, so there is no entry point to ship.
  expect(manifest.main).toBeUndefined();
  for (const file of readdirSync(PACKAGE_DIR)) {
    expect(['package.json', ...manifest.files]).toContain(file);
  }
});

test('the patch parses and its MCP row matches the adapter row', () => {
  expect(Array.isArray(patch)).toBe(true);
  const adapterRow = resolveCommonlyMcp([], {
    credentialFile: '/tmp/dsh-plugin-test-key', instanceUrl: 'https://api.commonly.me',
  });
  expect(inserted.map((entry) => entry.id)).toEqual(['mcp-commonly']);
  expect(row.id).toBe(adapterRow.id);
  expect(row.name).toBe(adapterRow.name);
  expect(row.config.serverName).toBe(adapterRow.config.serverName);
  expect(row.config.transport).toBe(adapterRow.config.transport);
  expect(row.config.failOnStartupError).toBe(adapterRow.config.failOnStartupError);
  // The key travels by file path; dsh's MCP bridge scrubs inherited credentials.
  expect(Object.keys(row.config.env).sort()).toEqual(Object.keys(adapterRow.config.env).sort());
  expect(row.config.command).toBe('npx');
  expect(row.config.args).toEqual(['-y', '@commonlyai/mcp@latest']);
});

test('the only expression resolves the key file under the home directory', () => {
  // dsh evaluates `!!js` only inside a row's config; anywhere else it stays a truthy object.
  expect(expressionPaths(patch)).toEqual(['0.insert.0.config.env.COMMONLY_TOKEN_FILE']);
  expect(row.config.env.COMMONLY_API_URL).toBe('https://api.commonly.me');
  expect(evaluate({}, row.config.env.COMMONLY_TOKEN_FILE.__jsExpr))
    .toBe(join(homedir(), '.commonly', 'keys', 'dsh-agent'));
});

test('session-log upload is off, as the adapter sets it', () => {
  const adapterRows = buildPatch({ proxyBaseURL: 'http://127.0.0.1:9/v1', model: 'm', cwd: '/tmp/w', mcp: {} });
  const ours = patch.filter((entry) => entry.id === 'session-log-deepseek');
  expect(ours).toEqual([adapterRows.find((entry) => entry.id === 'session-log-deepseek')]);
});

test('no credential is anywhere in the package', () => {
  for (const file of readdirSync(PACKAGE_DIR)) {
    const text = readFileSync(join(PACKAGE_DIR, file), 'utf8');
    expect({ file, hit: text.match(/cm_agent_|eyJ[A-Za-z0-9_-]{10,}|\bsk-[A-Za-z0-9]{16,}/)?.[0] })
      .toEqual({ file, hit: undefined });
  }
  expect(JSON.stringify(row.config)).not.toMatch(/COMMONLY_AGENT_TOKEN|COMMONLY_TOKEN_FD/);
});
