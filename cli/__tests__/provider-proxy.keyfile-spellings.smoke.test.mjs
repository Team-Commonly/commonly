/**
 * F453, under real sandbox-exec. Seatbelt matches the path the kernel
 * resolves, so a jailed process reads a granted file through any spelling of
 * it: the path as written, the same path in other letter case on a volume that
 * ignores case, and the /System/Volumes/Data firmlink form. The key-file check
 * has to refuse every one of those spellings, or a key placed under a readable
 * root slips past it while the jail can still read it.
 */
import { spawnSync } from 'child_process';
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { resolveProviderKeyFile } from '../src/lib/provider-proxy.js';
import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const macTest = onMac ? test : test.skip;
const root = onMac ? realpathSync(mkdtempSync(join(homedir(), '.commonly-keyfile-spellings-'))) : null;
const workspace = root && join(root, 'workspace');
const state = root && join(root, 'state');
const keys = root && join(root, 'keys');
const keyFile = keys && join(keys, 'provider.key');
if (root) {
  for (const dir of [workspace, state, keys]) mkdirSync(dir);
  writeFileSync(keyFile, 'sk-test-not-a-real-key\n', { mode: 0o600 });
}
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

// Each spelling the host resolves to the same file; the ones it doesn't are skipped.
const spellings = () => [
  ['as written', keyFile],
  ['in upper case', keyFile.toUpperCase()],
  ['through the firmlink', join('/System/Volumes/Data', keyFile)],
].filter(([, path]) => existsSync(path));

const readInJail = (paths) => spawnSync('/usr/bin/sandbox-exec', [
  '-p', buildSeatbeltProfile({
    workspacePath: workspace, executablePath: process.execPath, statePath: state, readOnlyDirectories: [keys],
  }),
  process.execPath, '-e', `const fs = require('fs');
    for (const path of ${JSON.stringify(paths)}) {
      try { fs.readFileSync(path); console.log('READ'); } catch (error) { console.log(error.code); }
    }`,
], { cwd: workspace, encoding: 'utf8', timeout: 15_000 });

macTest('the jail reads the granted key file through every spelling', () => {
  const paths = spellings().map(([, path]) => path);
  expect(paths.length).toBeGreaterThan(1);
  const result = readInJail(paths);
  expect(result.error).toBeUndefined();
  expect(result.stdout.trim().split('\n')).toEqual(paths.map(() => 'READ'));
});

macTest('and the check refuses the key file under every spelling, root as written', async () => {
  for (const [, path] of spellings()) {
    await expect(resolveProviderKeyFile({ keyFile: path }, workspace, 'T', {}))
      .resolves.toBeTruthy();
    await expect(import('@commonlyai/seats/wire/provider-proxy').then(({ resolveProviderKeyFile: shared }) => (
      shared({ keyFile: path }, workspace, 'T', { readableRoots: { subpaths: [keys], literals: [] } })
    ))).rejects.toThrow(`move it outside ${keys}`);
  }
});

macTest('and the check refuses the key file with the root in every spelling', async () => {
  const { resolveProviderKeyFile: shared } = await import('@commonlyai/seats/wire/provider-proxy');
  const roots = [keys, keys.toUpperCase(), join('/System/Volumes/Data', keys)].filter((path) => existsSync(path));
  expect(roots.length).toBeGreaterThan(1);
  for (const root of roots) {
    await expect(shared({ keyFile }, workspace, 'T', { readableRoots: { subpaths: [root], literals: [] } }))
      .rejects.toThrow(`move it outside ${root}`);
  }
});
