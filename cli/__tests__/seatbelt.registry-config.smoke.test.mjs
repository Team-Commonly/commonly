/**
 * seatbelt.registry-config.smoke.test.mjs
 *
 * With `denyRegistryConfig`, every .npmrc and .yarnrc* under a confined
 * folder is out of reach at any depth, and so is everything inside a directory
 * of that name, under real sandbox-exec. Without it they stay readable, since a
 * seat that installs packages reads its project's. The folder's name carries
 * regex metacharacters, so a missed escape shows up as a readable file. The
 * positive controls keep the denials from passing vacuously.
 */

import { spawnSync } from 'child_process';
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const macTest = process.platform === 'darwin' ? test : test.skip;
const DENIED = [
  '.npmrc', '.yarnrc', '.yarnrc.yml', 'packages/api/.npmrc', 'packages/web/.yarnrc.yml',
  'packages/odd/.npmrc/inside.json',
];
const KEPT = ['package.json', 'npmrc.txt', 'packages/api/.npmrc-notes/readme.md', 'yarnrc', 'packages/api/my.npmrc'];

describe('a confined folder\'s .npmrc and .yarnrc files, under Seatbelt', () => {
  let root;
  let workspace;
  let state;
  const read = (relative, denyRegistryConfig) => {
    const argv = wrapArgvWithSeatbelt([
      process.execPath, '-e',
      `try { require('fs').readFileSync(${JSON.stringify(join(workspace, relative))}); console.log('READ') } catch (e) { console.log('DENIED ' + e.code) }`,
    ], {
      workspacePath: workspace,
      workspaceAccess: 'read',
      executablePath: process.execPath,
      statePath: state,
      denyRegistryConfig,
    });
    const run = spawnSync(argv[0], argv.slice(1), { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
    return (run.stdout || '').trim();
  };

  beforeAll(() => {
    if (process.platform !== 'darwin') return;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'commonly-registry-config-seatbelt-')));
    workspace = join(root, 'my.project (v2)+');
    state = join(root, 'state');
    mkdirSync(state);
    for (const file of [...DENIED, ...KEPT]) {
      mkdirSync(dirname(join(workspace, file)), { recursive: true });
      writeFileSync(join(workspace, file), 'x');
    }
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  macTest.each(DENIED)('cannot read %s with denyRegistryConfig', (file) => {
    expect(read(file, true)).toBe('DENIED EPERM');
  });

  macTest.each(KEPT)('still reads %s with denyRegistryConfig', (file) => {
    expect(read(file, true)).toBe('READ');
  });

  macTest.each(DENIED)('reads %s without it', (file) => {
    expect(read(file, false)).toBe('READ');
  });
});
