/**
 * seatbelt.host-read.smoke.test.mjs
 *
 * F122: a workspace seat's read-outside folder, under real sandbox-exec. The
 * seat reads the folder it named and nothing beside it, cannot write the
 * folder, and a link inside it that leads elsewhere reaches nothing. The
 * positive control keeps the denials from passing vacuously.
 */

import { spawnSync } from 'child_process';
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import { buildSeatbeltProfile, wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const macTest = process.platform === 'darwin' ? test : test.skip;

describe('a workspace seat reading a host folder, under Seatbelt', () => {
  let root;
  let workspace;
  let state;
  let logs;
  let beside;
  const attempt = (op) => {
    const argv = wrapArgvWithSeatbelt([
      process.execPath, '-e',
      `try { ${op}; console.log('ALLOWED') } catch (e) { console.log('DENIED ' + e.code) }`,
    ], {
      workspacePath: workspace,
      workspaceAccess: 'read',
      executablePath: process.execPath,
      statePath: state,
      hostReadDirectories: [logs],
    });
    const run = spawnSync(argv[0], argv.slice(1), { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
    return (run.stdout || '').trim();
  };
  const read = (path) => `require('fs').readFileSync(${JSON.stringify(path)}, 'utf8')`;
  const write = (path) => `require('fs').writeFileSync(${JSON.stringify(path)}, 'x')`;

  beforeEach(() => {
    if (process.platform !== 'darwin') return;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'commonly-host-read-seatbelt-')));
    workspace = join(root, 'workspace');
    state = join(root, 'state');
    logs = join(root, 'host', 'logs');
    beside = join(root, 'host', 'secrets');
    for (const dir of [workspace, state, logs, beside]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(logs, 'seat.log'), 'polling\n');
    writeFileSync(join(beside, 'token'), 'not-for-the-seat\n');
    symlinkSync(join(beside, 'token'), join(logs, 'token-link'));
  });
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  macTest('reads a file in the folder it named', () => {
    expect(attempt(read(join(logs, 'seat.log')))).toBe('ALLOWED');
  });

  macTest('cannot write in that folder', () => {
    expect(attempt(write(join(logs, 'seat.log')))).toBe('DENIED EPERM');
    expect(attempt(write(join(logs, 'new.log')))).toBe('DENIED EPERM');
  });

  macTest('cannot read the folder beside it, directly or through a link inside the named one', () => {
    expect(attempt(read(join(beside, 'token')))).toBe('DENIED EPERM');
    expect(attempt(read(join(logs, 'token-link')))).toBe('DENIED EPERM');
  });

  test('a named folder that is a link into a credential store is refused by its target', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'commonly-host-read-link-')));
    try {
      const link = join(tmp, 'looks-harmless');
      symlinkSync(homedir(), link);
      expect(() => buildSeatbeltProfile({
        workspacePath: tmp,
        executablePath: process.execPath,
        statePath: tmp,
        hostReadDirectories: [link],
      })).toThrow(/overlaps .* holds credentials/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
