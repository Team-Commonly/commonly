/**
 * F453. Nothing opens a refused key file, this process included: every
 * refusal comes before the provider proxy reads the key. The fs layer here
 * counts every open or read of the key path and fails it as unreadable, so a
 * refusal that came after a read would surface as EACCES, not as the refusal.
 */
import { jest } from '@jest/globals';
import {
  mkdir, mkdtemp, realpath, rm, symlink, writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const watched = new Set();
let opens = 0;
const unreadable = (path) => {
  opens += 1;
  const error = new Error(`EACCES: permission denied, open '${path}'`);
  error.code = 'EACCES';
  return error;
};
const isWatched = (path) => typeof path === 'string' && watched.has(path);
const guard = (fn, asyncFn) => (path, ...rest) => {
  if (isWatched(path)) {
    const error = unreadable(path);
    if (asyncFn) return Promise.reject(error);
    throw error;
  }
  return fn(path, ...rest);
};
const realFs = await import('fs');
const realFsPromises = await import('fs/promises');
const fsMock = () => ({
  ...realFs,
  default: realFs.default,
  openSync: guard(realFs.openSync),
  readFileSync: guard(realFs.readFileSync),
  createReadStream: guard(realFs.createReadStream),
});
const fsPromisesMock = () => ({
  ...realFsPromises,
  default: realFsPromises.default,
  open: guard(realFsPromises.open, true),
  readFile: guard(realFsPromises.readFile, true),
});
for (const name of ['fs', 'node:fs']) await jest.unstable_mockModule(name, fsMock);
for (const name of ['fs/promises', 'node:fs/promises']) await jest.unstable_mockModule(name, fsPromisesMock);

const { default: pi, TESTED_PI_VERSIONS } = await import('../src/lib/adapters/pi.js');
const { resolveProviderKeyFile } = await import('../src/lib/provider-proxy.js');

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'adapters');

let root;
let workspace;
let home;
let binDir;
beforeEach(async () => {
  opens = 0;
  watched.clear();
  root = await realpath(await mkdtemp(join(tmpdir(), 'keyfile-never-opened-')));
  workspace = join(root, 'workspace');
  home = join(root, 'pi-home');
  const packageRoot = join(root, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  binDir = join(root, 'bin');
  await Promise.all([mkdir(join(packageRoot, 'dist'), { recursive: true }), mkdir(binDir), mkdir(workspace)]);
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
  await writeFile(join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  await symlink(join(packageRoot, 'dist', 'cli.js'), join(binDir, 'pi'));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const placeKey = async (dir) => {
  await mkdir(dir, { recursive: true });
  const keyFile = join(dir, 'provider.key');
  await writeFile(keyFile, 'sk-test-not-a-real-key\n', { mode: 0o600 });
  watched.add(keyFile);
  return keyFile;
};

const publicTurn = (keyFile, spawned) => pi.spawn('hi', {
  cwd: workspace,
  agentName: 'kai-public',
  runtimeToken: 'cm_agent_secret',
  instanceUrl: 'https://api.example',
  env: { PATH: `${binDir}:/usr/bin` },
  environment: {
    model: 'owner-model',
    sandbox: { trust: 'public' },
    provider: { id: 'owner', baseURL: 'https://models.example/v1', keyFile },
  },
  _piHome: home,
  _platform: 'darwin',
  _version: TESTED_PI_VERSIONS[0],
  _bridgePath: join(ADAPTERS_DIR, 'pi-commonly-mcp.mjs'),
  _wrapArgvWithSeatbelt: (inner) => ['/usr/bin/sandbox-exec', '-p', '(version 1)(deny default)', ...inner],
  _spawnImpl: () => { spawned.count += 1; throw new Error('spawn reached'); },
});

test('a key file in the public seat home is refused before the proxy would read it', async () => {
  // The public seat home is `<_piHome>-public`, readable inside the jail.
  const keyFile = await placeKey(`${home}-public`);
  const spawned = { count: 0 };
  await expect(publicTurn(keyFile, spawned)).rejects.toThrow(/inside the sandbox of a public seat/);
  expect(opens).toBe(0);
  expect(spawned.count).toBe(0);
});

test('control: a key outside every root reaches the proxy, which opens it (so the spy sees reads)', async () => {
  const keyFile = await placeKey(join(root, 'keys'));
  const spawned = { count: 0 };
  await expect(publicTurn(keyFile, spawned)).rejects.toThrow(/EACCES/);
  expect(opens).toBeGreaterThan(0);
  expect(spawned.count).toBe(0);
});

test.each([
  ['a declared bwrap read root', (keys) => ({ environment: { sandbox: { trust: 'public', filesystem: { 'read-outside': [keys] } } }, platform: 'linux' })],
  ['a seat directory the adapter names', (keys) => ({ environment: { sandbox: { trust: 'public' } }, platform: 'darwin', seatDirectories: [keys] })],
  ['a confined private seat (dsh) with its seat home', (keys) => ({ environment: {}, platform: 'darwin', sandboxed: true, seatDirectories: [keys] })],
])('the shared resolver refuses %s without opening the file, unreadable or not', async (_label, options) => {
  const keys = join(root, 'keys');
  const keyFile = await placeKey(keys);
  await expect(resolveProviderKeyFile({ keyFile }, workspace, 'T', options(keys)))
    .rejects.toThrow(`T provider.keyFile ${keyFile} is inside the seat's sandbox; move it outside ${keys}`);
  expect(opens).toBe(0);
});
