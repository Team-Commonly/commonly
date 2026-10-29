/**
 * seatbelt.workspace-write.smoke.test.mjs
 *
 * A workspace seat granted write (TASK-294), under real sandbox-exec: it can
 * change the person's project, and the project's .git stays read-only, so
 * every change it makes is one `git status` shows. The positive controls keep
 * the denials from passing vacuously.
 */

import { spawnSync } from 'child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const macTest = process.platform === 'darwin' ? test : test.skip;

describe('a workspace seat granted write, under Seatbelt', () => {
  let root;
  let workspace;
  let state;
  const attempt = (op) => {
    const argv = wrapArgvWithSeatbelt([
      process.execPath, '-e',
      `try { ${op}; console.log('ALLOWED') } catch (e) { console.log('DENIED ' + e.code) }`,
    ], {
      workspacePath: workspace,
      workspaceAccess: 'write',
      executablePath: process.execPath,
      statePath: state,
      readOnlyWorkspaceEntries: ['.git'],
    });
    const run = spawnSync(argv[0], argv.slice(1), { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
    return (run.stdout || '').trim();
  };
  const write = (path) => `require('fs').writeFileSync(${JSON.stringify(path)}, 'x')`;

  beforeEach(() => {
    if (process.platform !== 'darwin') return;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'commonly-workspace-write-seatbelt-')));
    workspace = join(root, 'workspace');
    state = join(root, 'state');
    mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(workspace, '.git', 'config'), '[core]\n');
    writeFileSync(join(workspace, 'a.txt'), 'one\n');
    mkdirSync(state);
  });
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  macTest('changes project files', () => {
    expect(attempt(write(join(workspace, 'new.txt')))).toBe('ALLOWED');
    expect(attempt(write(join(workspace, 'a.txt')))).toBe('ALLOWED');
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('x');
  });

  macTest('cannot write into .git', () => {
    expect(attempt(write(join(workspace, '.git', 'config')))).toBe('DENIED EPERM');
    expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });

  macTest('cannot add a git hook', () => {
    expect(attempt(write(join(workspace, '.git', 'hooks', 'pre-commit')))).toBe('DENIED EPERM');
    expect(existsSync(join(workspace, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  macTest('cannot move .git aside to replace it', () => {
    const moved = join(workspace, 'moved');
    expect(attempt(`require('fs').renameSync(${JSON.stringify(join(workspace, '.git'))}, ${JSON.stringify(moved)})`))
      .toBe('DENIED EPERM');
    expect(existsSync(join(workspace, '.git', 'config'))).toBe(true);
  });

  macTest('cannot reach .git through a link it makes in the project', () => {
    const config = JSON.stringify(join(workspace, '.git', 'config'));
    expect(attempt(`require('fs').linkSync(${config}, ${JSON.stringify(join(workspace, 'hard'))})`))
      .toBe('DENIED EPERM');
    expect(attempt(`require('fs').symlinkSync(${config}, ${JSON.stringify(join(workspace, 'soft'))})`))
      .toBe('ALLOWED');
    expect(attempt(write(join(workspace, 'soft')))).toBe('DENIED EPERM');
    expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });

  macTest('cannot write outside the project', () => {
    expect(attempt(write(join(root, 'outside.txt')))).toBe('DENIED EPERM');
  });
});
