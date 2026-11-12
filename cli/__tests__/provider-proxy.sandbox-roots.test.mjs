/**
 * F453. A public seat's provider key file is read by the proxy, outside the
 * sandbox, so a key file the sandbox could read is refused before the seat
 * starts. The check lives once in the shared resolver path every adapter
 * already calls, and covers both sandboxes: the Seatbelt baseline's read
 * grants on macOS and bwrap's read binds (defaults plus the seat's declared
 * read-outside and write-outside) on Linux.
 */
import {
  link, mkdir, mkdtemp, realpath, rm, symlink, writeFile,
} from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, relative } from 'path';
import { resolveProviderKeyFile, sandboxReadableRoots, keyFileReadableRoot } from '../src/lib/provider-proxy.js';
import { seatbeltSystemReadRoots } from '../src/lib/sandbox/seatbelt.js';
import qwen from '../src/lib/adapters/qwen.js';
import opencode from '../src/lib/adapters/opencode.js';

let root;
let workspace;
let keys;
let keyFile;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'keyfile-roots-')));
  workspace = join(root, 'workspace');
  keys = join(root, 'keys');
  await mkdir(workspace);
  await mkdir(keys);
  keyFile = join(keys, 'provider.key');
  await writeFile(keyFile, 'sk-test-not-a-real-key\n', { mode: 0o600 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const provider = () => ({ id: 'owner', baseURL: 'https://models.example/v1', keyFile });
const publicEnv = (filesystem) => ({
  model: 'owner-model', provider: provider(), sandbox: { trust: 'public', ...(filesystem ? { filesystem } : {}) },
});

describe('sandboxReadableRoots', () => {
  test('a seat that is not public gets no sandbox roots, so nothing changes for it', () => {
    expect(sandboxReadableRoots({ sandbox: { filesystem: { 'read-outside': ['/x'] } } }, 'linux')).toBeUndefined();
    expect(sandboxReadableRoots({ sandbox: { trust: 'workspace' } }, 'darwin')).toBeUndefined();
    expect(sandboxReadableRoots({}, 'darwin')).toBeUndefined();
  });

  test('the legacy internal trust is public, so it is checked the same way', () => {
    expect(sandboxReadableRoots({ sandbox: { trust: 'internal', filesystem: { 'read-outside': ['/x'] } } }, 'linux').subpaths)
      .toContain('/x');
  });

  test('macOS: the Seatbelt baseline read grants', () => {
    expect(sandboxReadableRoots(publicEnv(), 'darwin')).toBe(seatbeltSystemReadRoots());
  });

  test('Linux: the default binds plus declared read-outside and write-outside, ~ expanded', () => {
    const roots = sandboxReadableRoots(publicEnv({ 'read-outside': ['~/r', '/opt/r'], 'write-outside': ['/srv/w'] }), 'linux');
    expect(roots.subpaths).toEqual(expect.arrayContaining(['/etc/ssl/certs', '/usr/lib', '/bin', join(homedir(), 'r'), '/opt/r', '/srv/w']));
    expect(roots.literals).toEqual([]);
  });

  test('a confined seat on a platform with no baseline here gets empty roots, so its seat directories are still checked', () => {
    expect(sandboxReadableRoots(publicEnv(), 'win32')).toEqual({ subpaths: [], literals: [] });
  });

  test('the adapter decides: a confined private seat is checked, an unconfined public one is not', () => {
    expect(sandboxReadableRoots({}, 'darwin', { sandboxed: true })).toBe(seatbeltSystemReadRoots());
    expect(sandboxReadableRoots(publicEnv(), 'darwin', { sandboxed: false })).toBeUndefined();
  });
});

describe('resolveProviderKeyFile refuses a key file the sandbox can read', () => {
  test.each([['read-outside'], ['write-outside']])('Linux: a key under a declared %s', async (key) => {
    await expect(resolveProviderKeyFile(provider(), workspace, 'T', {
      environment: publicEnv({ [key]: [keys] }), platform: 'linux',
    })).rejects.toThrow(`T provider.keyFile ${keyFile} is inside the sandbox of a public seat; move it outside ${keys}`);
  });

  test('Linux: the same declaration on a private seat is accepted', async () => {
    const environment = { ...publicEnv(), sandbox: { filesystem: { 'read-outside': [keys] } } };
    await expect(resolveProviderKeyFile(provider(), workspace, 'T', { environment, platform: 'linux' })).resolves.toBe(keyFile);
  });

  test('a declared root above the key, or the key file itself, is refused too', async () => {
    for (const declared of [root, keyFile]) {
      await expect(resolveProviderKeyFile(provider(), workspace, 'T', {
        environment: publicEnv({ 'read-outside': [declared] }), platform: 'linux',
      })).rejects.toThrow(/inside the sandbox of a public seat/);
    }
  });

  test('a declared root reached through a symlink is the same root', async () => {
    const alias = join(root, 'alias');
    await symlink(keys, alias);
    await expect(resolveProviderKeyFile(provider(), workspace, 'T', {
      environment: publicEnv({ 'read-outside': [alias] }), platform: 'linux',
    })).rejects.toThrow(/move it outside .*alias/);
  });

  test('a sibling declared directory is not the key\'s', async () => {
    const other = join(root, 'other');
    await mkdir(other);
    await expect(resolveProviderKeyFile(provider(), workspace, 'T', {
      environment: publicEnv({ 'read-outside': [other, join(root, 'keys-not')] }), platform: 'linux',
    })).resolves.toBe(keyFile);
  });

  test('macOS: a key in the user\'s temp tree is outside every baseline grant', async () => {
    await expect(resolveProviderKeyFile(provider(), workspace, 'T', { environment: publicEnv(), platform: 'darwin' }))
      .resolves.toBe(keyFile);
  });

  test('a seat directory the adapter names is checked on a confined seat only', async () => {
    await expect(resolveProviderKeyFile(provider(), workspace, 'T', {
      environment: publicEnv(), platform: 'darwin', seatDirectories: [keys],
    })).rejects.toThrow(`move it outside ${keys}`);
    await expect(resolveProviderKeyFile(provider(), workspace, 'T', {
      environment: { model: 'm', provider: provider() }, platform: 'darwin', seatDirectories: [keys],
    })).resolves.toBe(keyFile);
  });

  test('a key file with a second hard link is refused, wherever the link is', async () => {
    await link(keyFile, join(workspace, 'provider-copy.key'));
    await expect(resolveProviderKeyFile(provider(), workspace, 'T')).rejects.toThrow(/exactly one link/);
  });

  test('without an environment the shared resolver behaves as before', async () => {
    await expect(resolveProviderKeyFile(provider(), workspace, 'T')).resolves.toBe(keyFile);
  });
});

describe('another spelling of the same place is the same place', () => {
  const caseInsensitive = () => existsSync(root.toUpperCase());

  test('a root spelled in other letter case, on a volume that ignores case', () => {
    if (!caseInsensitive()) return;
    expect(keyFileReadableRoot(keyFile, { subpaths: [keys.toUpperCase()] })).toBe(keys.toUpperCase());
  });

  test('a key path spelled in other letter case, against the workspace', async () => {
    if (!caseInsensitive()) return;
    const inWorkspace = join(workspace, 'provider.key');
    await writeFile(inWorkspace, 'k\n', { mode: 0o600 });
    await expect(resolveProviderKeyFile({ ...provider(), keyFile: inWorkspace.toUpperCase() }, workspace, 'T'))
      .rejects.toThrow(/must be outside the workspace/);
  });

  test('macOS: a root spelled through the /System/Volumes/Data firmlink', () => {
    const firmlinked = join('/System/Volumes/Data', keys);
    if (process.platform !== 'darwin' || !existsSync(firmlinked)) return;
    expect(keyFileReadableRoot(keyFile, { subpaths: [firmlinked] })).toBe(firmlinked);
  });

  test('a literal reached through a hard link is the same file', async () => {
    const other = join(root, 'linked.key');
    await link(keyFile, other);
    expect(keyFileReadableRoot(keyFile, { literals: [other] })).toBe(other);
  });

  test('macOS: /usr and /usr/bin stay distinct (inodes past 2^53 compared exactly)', () => {
    if (process.platform !== 'darwin' || !existsSync('/usr/share/dict/words')) return;
    expect(keyFileReadableRoot('/usr/share/dict/words', { subpaths: ['/usr/bin', '/usr/sbin', '/bin'] })).toBeNull();
    expect(keyFileReadableRoot('/usr/share/dict/words', { subpaths: ['/usr/share'] })).toBe('/usr/share');
  });

  test('a root that does not exist is compared as written', () => {
    expect(keyFileReadableRoot(join(keys, 'later', 'k'), { subpaths: [join(keys, 'later')] })).toBe(join(keys, 'later'));
    expect(keyFileReadableRoot(keyFile, { subpaths: [join(root, 'missing')], literals: [join(root, 'gone')] })).toBeNull();
  });

  test('the refusal names the root as declared, never a resolved inode path', () => {
    const declared = relative('/', keys);
    expect(keyFileReadableRoot(keyFile, { subpaths: [`/${declared}`] })).toBe(`/${declared}`);
  });
});

// The two adapters that let a public seat declare read-outside, end to end.
// That every adapter passes its environment at all is pinned in
// provider-proxy.adapter-wiring.test.mjs.
describe('qwen and opencode refuse a public key under a declared bind, on Linux', () => {
  const realPlatform = process.platform;
  afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform }));

  test.each([['qwen', qwen], ['opencode', opencode]])('%s', async (_name, adapter) => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(adapter.validateEnvironment(publicEnv({ 'read-outside': [keys] }), workspace))
      .rejects.toThrow(/inside the sandbox of a public seat/);
    const unconfined = { model: 'owner-model', provider: provider(), sandbox: { filesystem: { 'read-outside': [keys] } } };
    await expect(adapter.validateEnvironment(unconfined, workspace)).resolves.toBe(keyFile);
  });
});
