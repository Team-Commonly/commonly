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

import {
  buildSeatbeltProfile, resolveHostReadDirectories, wrapArgvWithSeatbelt,
} from '../src/lib/sandbox/seatbelt.js';

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
      // A temp folder stands in for home; the logs folder is an ordinary
      // folder inside it, which the rules admit.
      hostReadHome: join(root, 'host'),
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
    // A project tree holds other repos' credentials too.
    mkdirSync(join(logs, 'repo', '.commonly'), { recursive: true });
    mkdirSync(join(logs, 'repo', '.codex'), { recursive: true });
    writeFileSync(join(logs, 'repo', '.env'), 'KEY=1\n');
    writeFileSync(join(logs, 'repo', '.env.local'), 'KEY=1\n');
    writeFileSync(join(logs, 'repo', '.npmrc'), '//r/:_authToken=1\n');
    writeFileSync(join(logs, 'repo', '.commonly', 'token'), 't\n');
    writeFileSync(join(logs, 'repo', '.codex', 'auth.json'), '{}\n');
    writeFileSync(join(logs, 'repo', 'README.md'), 'hi\n');
    // And other dot folders: keys, cloud credentials, a keyring (CodeRabbit on #4129).
    for (const dir of ['.ssh', '.aws', '.gnupg', '.config/gh']) mkdirSync(join(logs, 'repo', dir), { recursive: true });
    writeFileSync(join(logs, 'repo', '.ssh', 'id_rsa'), 'fake-key\n');
    writeFileSync(join(logs, 'repo', '.aws', 'credentials'), '[default]\n');
    writeFileSync(join(logs, 'repo', '.gnupg', 'pubring.kbx'), 'x\n');
    writeFileSync(join(logs, 'repo', '.config', 'gh', 'hosts.yml'), 'x\n');
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

  macTest('cannot read the credential files a project tree under it holds', () => {
    expect(attempt(read(join(logs, 'repo', 'README.md')))).toBe('ALLOWED');
    for (const file of ['.env', '.env.local', '.npmrc', '.commonly/token', '.codex/auth.json']) {
      expect(attempt(read(join(logs, 'repo', file)))).toBe('DENIED EPERM');
    }
  });

  // A request for a dot folder is refused; one beneath a granted folder is
  // denied by the same rule, whatever its name or case.
  macTest('cannot read any dot folder or dotfile a project tree under it holds', () => {
    for (const file of ['.ssh/id_rsa', '.SSH/id_rsa', '.aws/credentials', '.gnupg/pubring.kbx', '.config/gh/hosts.yml']) {
      expect(attempt(read(join(logs, 'repo', file)))).toBe('DENIED EPERM');
    }
    expect(attempt(read(join(logs, 'repo', 'README.md')))).toBe('ALLOWED');
  });

  // CodeRabbit on #4111: a grant that holds the seat's own workspace must not
  // hide the workspace's .git or dotfiles, and the workspace's own credential
  // denies still hold.
  macTest('a grant that holds the workspace leaves the workspace\'s own view as it was', () => {
    const own = join(logs, 'mine');
    for (const dir of [join(own, '.git'), join(own, '.github')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(own, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(own, '.github', 'ci.yml'), 'on: push\n');
    writeFileSync(join(own, '.env'), 'KEY=1\n');
    const argv = (op) => wrapArgvWithSeatbelt([
      process.execPath, '-e',
      `try { ${op}; console.log('ALLOWED') } catch (e) { console.log('DENIED ' + e.code) }`,
    ], {
      workspacePath: own,
      workspaceAccess: 'read',
      executablePath: process.execPath,
      statePath: state,
      hostReadDirectories: [logs],
      hostReadHome: join(root, 'host'),
    });
    const run = (op) => {
      const a = argv(op);
      return (spawnSync(a[0], a.slice(1), { cwd: own, encoding: 'utf8', timeout: 20_000 }).stdout || '').trim();
    };
    expect(run(read(join(own, '.git', 'HEAD')))).toBe('ALLOWED');
    expect(run(read(join(own, '.github', 'ci.yml')))).toBe('ALLOWED');
    expect(run(read(join(own, '.env')))).toBe('DENIED EPERM');
    expect(run(read(join(logs, 'repo', '.ssh', 'id_rsa')))).toBe('DENIED EPERM');
  });

  // The Opus review's case bypass, against a home that has a .ssh: on a
  // case-insensitive volume `.SSH` is the same folder, and is refused as one.
  test('a case change does not get past the check', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'commonly-host-read-home-')));
    try {
      mkdirSync(join(home, '.ssh'));
      mkdirSync(join(home, 'project'));
      for (const entry of ['.SSH', '.Ssh/id_rsa', 'LIBRARY/Keychains', '.ssh']) {
        expect(() => resolveHostReadDirectories([join(home, entry)], home))
          .toThrow(/refusing sandbox\.filesystem\.read-outside/);
      }
      expect(resolveHostReadDirectories([join(home, 'project')], home)).toEqual([join(home, 'project')]);
      expect(resolveHostReadDirectories([join(home, '.commonly', 'logs')], home))
        .toEqual([join(home, '.commonly', 'logs')]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
      })).toThrow(/refusing sandbox\.filesystem\.read-outside/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
