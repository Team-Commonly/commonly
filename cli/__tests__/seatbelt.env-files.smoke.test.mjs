/**
 * seatbelt.env-files.smoke.test.mjs
 *
 * Every .env and .env.* file under a confined seat's folder is out of reach at
 * any depth, under real sandbox-exec (TASK-294): a workspace seat reads a real
 * project, which keeps one beside each package, not only at its root. The
 * folder's name carries regex metacharacters, so a missed escape shows up as a
 * readable .env. The positive controls keep the denials from passing
 * vacuously.
 */

import { spawnSync } from 'child_process';
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const macTest = process.platform === 'darwin' ? test : test.skip;
const FILES = [
  '.env', '.env.local', 'packages/api/.env', 'packages/api/.env.production',
  'packages/api/config.js', '.envrc', 'env.txt', 'notes.env',
];

describe('a confined seat\'s .env files, under Seatbelt', () => {
  let root;
  let workspace;
  let state;
  const read = (relative) => {
    const argv = wrapArgvWithSeatbelt([
      process.execPath, '-e',
      `try { require('fs').readFileSync(${JSON.stringify(join(workspace, relative))}); console.log('READ') } catch (e) { console.log('DENIED ' + e.code) }`,
    ], {
      workspacePath: workspace,
      workspaceAccess: 'read',
      executablePath: process.execPath,
      statePath: state,
    });
    const run = spawnSync(argv[0], argv.slice(1), { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
    return (run.stdout || '').trim();
  };

  beforeAll(() => {
    if (process.platform !== 'darwin') return;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'commonly-env-files-seatbelt-')));
    workspace = join(root, 'my.project (v2)+');
    state = join(root, 'state');
    mkdirSync(join(workspace, 'packages', 'api'), { recursive: true });
    mkdirSync(state);
    for (const file of FILES) writeFileSync(join(workspace, file), 'x');
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  macTest.each(['.env', '.env.local', 'packages/api/.env', 'packages/api/.env.production'])(
    'cannot read %s',
    (file) => { expect(read(file)).toBe('DENIED EPERM'); },
  );

  macTest.each(['packages/api/config.js', '.envrc', 'env.txt', 'notes.env'])(
    'still reads %s',
    (file) => { expect(read(file)).toBe('READ'); },
  );
});
