/**
 * seatbelt.env-files.smoke.test.mjs
 *
 * Every .env and .env.* file under a confined seat's folder is out of reach at
 * any depth, and so is everything inside a directory of that name, under real
 * sandbox-exec (TASK-294): a workspace seat reads a real project, which keeps
 * one beside each package, not only at its root. The
 * folder's name carries regex metacharacters, so a missed escape shows up as a
 * readable .env. The positive controls keep the denials from passing
 * vacuously.
 */

import { spawnSync } from 'child_process';
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const macTest = process.platform === 'darwin' ? test : test.skip;
const FILES = [
  '.env', '.env.local', 'packages/api/.env', 'packages/api/.env.production',
  'packages/api/config.js', '.envrc', 'env.txt', 'notes.env',
  'packages/web/.env/secrets.json', 'packages/web/.env/deep/key.json', 'packages/web/.envoy/config.json',
];
// A second folder, whose root holds a .env directory instead of a .env file.
const DIR_FILES = ['.env/secrets.json', '.envoy/config.json'];

describe('a confined seat\'s .env files, under Seatbelt', () => {
  let root;
  let workspace;
  let dirWorkspace;
  let state;
  const read = (relative, folder = workspace) => {
    const argv = wrapArgvWithSeatbelt([
      process.execPath, '-e',
      `try { require('fs').readFileSync(${JSON.stringify(join(folder, relative))}); console.log('READ') } catch (e) { console.log('DENIED ' + e.code) }`,
    ], {
      workspacePath: folder,
      workspaceAccess: 'read',
      executablePath: process.execPath,
      statePath: state,
    });
    const run = spawnSync(argv[0], argv.slice(1), { cwd: folder, encoding: 'utf8', timeout: 20_000 });
    return (run.stdout || '').trim();
  };

  beforeAll(() => {
    if (process.platform !== 'darwin') return;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'commonly-env-files-seatbelt-')));
    workspace = join(root, 'my.project (v2)+');
    dirWorkspace = join(root, 'dir.project');
    state = join(root, 'state');
    mkdirSync(state);
    const write = (folder, file) => {
      mkdirSync(dirname(join(folder, file)), { recursive: true });
      writeFileSync(join(folder, file), 'x');
    };
    for (const file of FILES) write(workspace, file);
    for (const file of DIR_FILES) write(dirWorkspace, file);
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  macTest.each([
    '.env', '.env.local', 'packages/api/.env', 'packages/api/.env.production',
    'packages/web/.env/secrets.json', 'packages/web/.env/deep/key.json',
  ])(
    'cannot read %s',
    (file) => { expect(read(file)).toBe('DENIED EPERM'); },
  );

  macTest.each(['packages/api/config.js', '.envrc', 'env.txt', 'notes.env', 'packages/web/.envoy/config.json'])(
    'still reads %s',
    (file) => { expect(read(file)).toBe('READ'); },
  );

  macTest('cannot read what a .env directory at the folder root holds, and still reads its neighbour', () => {
    expect(read('.env/secrets.json', dirWorkspace)).toBe('DENIED EPERM');
    expect(read('.envoy/config.json', dirWorkspace)).toBe('READ');
  });
});
