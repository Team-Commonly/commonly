/**
 * seatbelt.workspace-pin.smoke.test.mjs — F200
 *
 * Under real sandbox-exec: a workspace seat granted write can remove its
 * project folder and leave a link in its place (the reason the realpath is
 * recorded), and cannot write the record of that realpath, which sits beside
 * its state folder. The positive controls keep the denials from passing
 * vacuously.
 */

import { spawnSync } from 'child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';
import { workspacePinDir, workspacePinFile } from '../src/lib/sandbox/workspace-pin.js';

const macTest = process.platform === 'darwin' ? test : test.skip;

describe('a workspace seat\'s record of its folder, under Seatbelt (F200)', () => {
  let root;
  let workspace;
  let state;
  let pinFile;
  const RECORD = '{"realpath":"/somewhere"}\n';

  const attempt = (op, { workspacePath = workspace, deny = true } = {}) => {
    const argv = wrapArgvWithSeatbelt([
      process.execPath, '-e',
      `try { ${op}; console.log('ALLOWED') } catch (e) { console.log('DENIED ' + e.code) }`,
    ], {
      workspacePath,
      workspaceAccess: 'write',
      executablePath: process.execPath,
      statePath: state,
      denyWritePaths: deny ? [workspacePinDir(state)] : [],
    });
    const run = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', timeout: 20_000 });
    return (run.stdout || '').trim();
  };
  const write = (path) => `require('fs').writeFileSync(${JSON.stringify(path)}, 'x')`;

  beforeEach(() => {
    if (process.platform !== 'darwin') return;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'commonly-workspace-pin-seatbelt-')));
    workspace = join(root, 'project');
    state = join(root, 'state');
    pinFile = workspacePinFile(state, workspace);
    mkdirSync(workspace);
    mkdirSync(state);
    mkdirSync(join(root, 'elsewhere'));
    mkdirSync(workspacePinDir(state));
    writeFileSync(pinFile, RECORD);
  });
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  macTest('the seat can replace its project folder with a link (what the record guards against)', () => {
    const fsOps = [
      `require('fs').rmSync(${JSON.stringify(workspace)}, { recursive: true })`,
      `require('fs').symlinkSync(${JSON.stringify(join(root, 'elsewhere'))}, ${JSON.stringify(workspace)})`,
    ].join('; ');
    expect(attempt(fsOps)).toBe('ALLOWED');
    expect(lstatSync(workspace).isSymbolicLink()).toBe(true);
  });

  macTest('writes its state folder and project, but not the record beside the state folder', () => {
    expect(attempt(write(join(state, 'x')))).toBe('ALLOWED');
    expect(attempt(write(join(workspace, 'x')))).toBe('ALLOWED');
    expect(attempt(write(pinFile))).toBe('DENIED EPERM');
    expect(attempt(`require('fs').rmSync(${JSON.stringify(pinFile)})`)).toBe('DENIED EPERM');
    expect(readFileSync(pinFile, 'utf8')).toBe(RECORD);
  });

  macTest('a workspace that contains the record still cannot write it', () => {
    expect(attempt(write(join(root, 'x')), { workspacePath: root })).toBe('ALLOWED');
    expect(attempt(write(pinFile), { workspacePath: root })).toBe('DENIED EPERM');
    expect(attempt(`require('fs').rmSync(${JSON.stringify(workspacePinDir(state))}, { recursive: true })`,
      { workspacePath: root })).toBe('DENIED EPERM');
    expect(existsSync(pinFile)).toBe(true);
    // Control: without the deny, that workspace could.
    expect(attempt(write(pinFile), { workspacePath: root, deny: false })).toBe('ALLOWED');
  });
});
