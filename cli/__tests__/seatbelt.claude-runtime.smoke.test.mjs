/**
 * seatbelt.claude-runtime.smoke.test.mjs
 *
 * The Claude runtime rules in a public seat's Seatbelt profile, under real
 * sandbox-exec. A confined process (any one: the MCP server runs in the same
 * profile as Claude) must not reach other Claude sessions' temp files under
 * /private/tmp/claude-<uid>, nor any keychain but the login database Claude's
 * own login reads. The positive controls keep the denials from passing
 * vacuously: the same process writes and reads its own tmp, and opens the
 * login database.
 */

import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const macTest = process.platform === 'darwin' ? test : test.skip;

describe('a public Claude seat under Seatbelt', () => {
  let root;
  let workspace;
  let state;
  const confined = (code) => {
    const argv = wrapArgvWithSeatbelt([process.execPath, '-e', code], {
      workspacePath: workspace,
      executablePath: process.execPath,
      statePath: state,
      allowClaudeRuntimeAccess: true,
    });
    const run = spawnSync(argv[0], argv.slice(1), { cwd: workspace, encoding: 'utf8', timeout: 20_000 });
    return (run.stdout || '').trim();
  };
  const attempt = (op) => confined(`try { ${op}; console.log('ALLOWED') } catch (e) { console.log('DENIED ' + e.code) }`);

  beforeAll(() => {
    if (process.platform !== 'darwin') return;
    // Real seats keep their state under HOME, so the profile admits HOME's
    // metadata; a tmpdir root would deny that and make the denials vacuous.
    root = mkdtempSync(join(homedir(), '.commonly-claude-runtime-seatbelt-'));
    workspace = join(root, 'workspace');
    state = join(root, 'state');
    mkdirSync(workspace);
    mkdirSync(join(state, 'tmp'), { recursive: true });
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  macTest('cannot read another Claude session\'s temp files, and can use its own tmp', () => {
    const claudeTmp = `/private/tmp/claude-${process.getuid()}`;
    const other = join(claudeTmp, `seatbelt-probe-${randomUUID()}`);
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'tool-output.txt'), `OTHER_SESSION_${randomUUID()}`);
    try {
      expect(attempt(`require('fs').readFileSync(${JSON.stringify(join(other, 'tool-output.txt'))})`)).toBe('DENIED EPERM');
      expect(attempt(`require('fs').readdirSync(${JSON.stringify(claudeTmp)})`)).toBe('DENIED EPERM');
      const own = join(state, 'tmp', 'own.txt');
      expect(attempt(`require('fs').writeFileSync(${JSON.stringify(own)}, 'x'); require('fs').readFileSync(${JSON.stringify(own)})`)).toBe('ALLOWED');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  macTest('opens the login keychain database and nothing else in the Keychains folder', () => {
    const keychains = join(homedir(), 'Library', 'Keychains');
    const login = join(keychains, 'login.keychain-db');
    if (!existsSync(login)) return;
    // Opening is enough: the database is encrypted, and Claude's security
    // helper is what reads its one item. No item is read here.
    expect(attempt(`require('fs').closeSync(require('fs').openSync(${JSON.stringify(login)}, 'r'))`)).toBe('ALLOWED');
    expect(attempt(`require('fs').readdirSync(${JSON.stringify(keychains)})`)).toBe('DENIED EPERM');
    const sibling = readdirSync(keychains, { withFileTypes: true }).find((entry) => entry.isDirectory());
    if (sibling) {
      expect(attempt(`require('fs').readdirSync(${JSON.stringify(join(keychains, sibling.name))})`)).toBe('DENIED EPERM');
    }
  });
});
