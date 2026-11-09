/**
 * A public Codex seat refuses a workspace whose repository is set up to run
 * programs, since Codex runs git there outside the seat's sandbox. Real git,
 * real repositories: each hostile setup is written the way a copied or
 * unpacked folder would carry it.
 */
import { jest } from '@jest/globals';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import {
  chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import codex from '../src/lib/adapters/codex.js';
import {
  codeRunningGitSetup, codeRunningKey, refuseCodeRunningGitSetup,
} from '../src/lib/sandbox/workspace-git-config.js';

const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

let root;
const commit = (dir, message) => git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message);
const repo = (name = 'repo') => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  commit(dir, 'first');
  return dir;
};
// A repository at <top>/<path> recorded in <top>'s index as a submodule.
const embed = (top, path = 'sub') => {
  const dir = repo(join(top.slice(root.length + 1), path));
  git(top, 'add', path);
  commit(top, `add ${path}`);
  return dir;
};
const keys = (dir) => codeRunningGitSetup(dir, { env: ENV }).map((f) => f.key || f.hook);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ws-git-config-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('which keys run a program', () => {
  test.each([
    ['filter.probe.clean', 'sh -c x'],
    ['filter.probe.smudge', 'x'],
    ['filter.probe.process', 'x'],
    ['core.fsmonitor', '/tmp/x'],
    ['core.sshCommand', 'x'],
    ['core.pager', 'x'],
    ['core.editor', 'x'],
    ['core.hooksPath', '.husky'],
    ['core.worktree', '/elsewhere'],
    ['diff.external', 'x'],
    ['diff.probe.textconv', 'x'],
    ['diff.probe.command', 'x'],
    ['merge.probe.driver', 'x'],
    ['pager.log', 'x'],
    ['gpg.program', 'x'],
    ['credential.helper', 'x'],
    ['include.path', '../other'],
    ['includeIf.gitdir:/.path', '../other'],
    ['alias.st', '!sh -c x'],
    ['remote.origin.url', 'ext::sh -c x'],
    ['submodule.lib.update', '!x'],
    ['uploadpack.packObjectsHook', 'x'],
    ['hook.probe.command', 'x'],
    ['gc.recentObjectsHook', 'x'],
    ['gpg.ssh.defaultKeyCommand', 'x'],
    ['sendemail.sendmailCmd', 'x'],
    ['sendemail.headerCmd', 'x'],
    ['imap.tunnel', 'x'],
    ['guitool.probe.cmd', 'x'],
    ['instaweb.httpd', 'x'],
    ['protocol.allow', 'always'],
    ['submodule.lib.url', 'ext::sh -c x'],
    ['lfs.extension.probe.clean', 'x'],
    ['lfs.customtransfer.probe.path', 'x'],
  ])('%s is refused', (key, value) => {
    const dir = repo();
    git(dir, 'config', key, value);
    const findings = codeRunningGitSetup(dir);
    expect(findings.map((f) => f.key.toLowerCase())).toContain(key.toLowerCase());
  });

  test.each([
    ['user.name', 'T'],
    ['core.autocrlf', 'input'],
    ['core.fsmonitor', 'false'],
    ['core.fsmonitor', 'true'],
    ['remote.origin.url', 'https://github.com/x/y.git'],
    ['alias.st', 'status'],
    ['submodule.lib.update', 'rebase'],
  ])('%s = %s is allowed', (key, value) => {
    const dir = repo();
    git(dir, 'config', key, value);
    expect(codeRunningGitSetup(dir)).toEqual([]);
  });

  test('key matching is case-insensitive where git is', () => {
    expect(codeRunningKey('Filter.X.Clean', 'y')).toBe(true);
    expect(codeRunningKey('url.ext::sh.insteadOf', 'https://x/')).toBe(true);
    expect(codeRunningKey('url.https://mirror/.insteadOf', 'https://x/')).toBe(false);
  });
});

describe('the repository git would open', () => {
  test('a fresh clone of a hostile repository carries none of it', () => {
    const origin = repo('origin');
    git(origin, 'config', 'filter.probe.clean', 'sh -c x');
    writeFileSync(join(origin, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\n', { mode: 0o755 });
    expect(codeRunningGitSetup(origin).length).toBeGreaterThan(0);
    git(root, 'clone', '-q', origin, 'clone');
    expect(codeRunningGitSetup(join(root, 'clone'))).toEqual([]);
  });

  test('an active hook is refused, a sample hook is not', () => {
    const dir = repo();
    expect(codeRunningGitSetup(dir)).toEqual([]);
    const hook = join(dir, '.git', 'hooks', 'post-index-change');
    writeFileSync(hook, '#!/bin/sh\n');
    chmodSync(hook, 0o755);
    const findings = codeRunningGitSetup(dir);
    expect(findings).toEqual([{ file: expect.stringMatching(/\/\.git\/hooks\/post-index-change$/), hook: 'post-index-change' }]);
  });

  test('a workspace below the repository root is checked against that repository', () => {
    const dir = repo();
    git(dir, 'config', 'core.fsmonitor', '/tmp/x');
    mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true });
    expect(codeRunningGitSetup(join(dir, 'sub', 'deeper')).map((f) => f.key)).toEqual(['core.fsmonitor']);
  });

  test('a linked worktree is checked against the shared config', () => {
    const dir = repo();
    git(dir, 'worktree', 'add', '-q', join(root, 'wt'));
    git(dir, 'config', 'diff.external', 'x');
    expect(codeRunningGitSetup(join(root, 'wt')).map((f) => f.key)).toEqual(['diff.external']);
  });

  test('a workspace laid out as a bare repository is read as one', () => {
    const dir = join(root, 'bare-layout');
    git(root, 'init', '-q', '--bare', 'bare-layout');
    git(root, '--git-dir', dir, 'config', 'core.bare', 'false');
    git(root, '--git-dir', dir, 'config', 'core.worktree', dir);
    git(root, '--git-dir', dir, 'config', 'core.fsmonitor', '/tmp/x');
    expect(keys(dir)).toEqual(expect.arrayContaining(['core.worktree', 'core.fsmonitor']));
  });

  test('a decoy .git git skips does not hide the repository above it', () => {
    const top = repo('top');
    git(top, 'config', 'core.fsmonitor', '/tmp/x');
    mkdirSync(join(top, 'ws', '.git'), { recursive: true });
    expect(keys(join(top, 'ws'))).toEqual(['core.fsmonitor']);
  });

  test('a submodule recorded in the index is checked, config and hooks', () => {
    const top = repo('top');
    const sub = embed(top);
    expect(keys(top)).toEqual([]);
    git(sub, 'config', 'core.fsmonitor', '/tmp/x');
    const hook = join(sub, '.git', 'hooks', 'post-index-change');
    writeFileSync(hook, '#!/bin/sh\n', { mode: 0o755 });
    expect(keys(top)).toEqual(['core.fsmonitor', 'post-index-change']);
  });

  test('a submodule whose git folder is a symlink is followed', () => {
    const top = repo('top');
    const sub = embed(top);
    const outside = join(root, 'outside-git');
    renameSync(join(sub, '.git'), outside);
    mkdirSync(join(top, '.git', 'modules'), { recursive: true });
    symlinkSync(outside, join(top, '.git', 'modules', 'sub'));
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    git(sub, 'config', 'core.worktree', sub);
    git(sub, 'config', 'diff.external', 'x');
    expect(keys(top)).toEqual(expect.arrayContaining(['diff.external']));
  });

  test('a submodule whose git folder git cannot open is refused', () => {
    const top = repo('top');
    const sub = embed(top);
    rmSync(join(sub, '.git'), { recursive: true });
    writeFileSync(join(sub, '.git'), 'gitdir: ../missing\n');
    expect(keys(top)[0]).toMatch(/^git could not read the repository/);
  });

  test('config hooks are refused', () => {
    const dir = repo();
    git(dir, 'config', 'hook.probe.event', 'post-index-change');
    git(dir, 'config', 'hook.probe.command', 'x');
    expect(keys(dir)).toEqual(['hook.probe.event', 'hook.probe.command']);
  });

  test('the repository named by GIT_DIR in the seat\'s environment is the one checked', () => {
    const elsewhere = repo('elsewhere');
    git(elsewhere, 'config', 'core.pager', 'x');
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(codeRunningGitSetup(plain, { env: { ...ENV, GIT_DIR: join(elsewhere, '.git') } }).map((f) => f.key))
      .toEqual(['core.pager']);
  });

  test('the check itself runs nothing the repository names', () => {
    const dir = repo();
    const marker = join(root, 'RAN');
    const payload = join(root, 'payload.sh');
    writeFileSync(payload, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
    git(dir, 'config', 'core.fsmonitor', payload);
    git(dir, 'config', 'hook.probe.event', 'post-index-change');
    git(dir, 'config', 'hook.probe.command', payload);
    writeFileSync(join(dir, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    expect(keys(dir).length).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);
  });

  test('a config git cannot parse is refused, not skipped', () => {
    const dir = repo();
    writeFileSync(join(dir, '.git', 'config'), '[core\n\tbroken');
    expect(keys(dir)).toEqual([expect.stringMatching(/^git could not read the repository/)]);
  });

  test('a folder in no repository has nothing to refuse', () => {
    const dir = join(root, 'plain');
    mkdirSync(dir);
    expect(codeRunningGitSetup(dir)).toEqual([]);
  });
});

describe('the refusal', () => {
  test('names the key and the file, never the value', () => {
    const dir = repo();
    git(dir, 'config', 'filter.probe.clean', 'curl https://example.invalid/SECRET-VALUE');
    let error;
    try {
      refuseCodeRunningGitSetup(dir, { seat: 'This seat' });
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe('workspace_git_runs_programs');
    expect(error.message).toContain('filter.probe.clean');
    expect(error.message).not.toContain('SECRET-VALUE');
  });

  test('a public codex seat refuses the turn before Codex runs', async () => {
    const dir = repo();
    git(dir, 'config', 'filter.probe.clean', 'sh -c x');
    const spawnImpl = jest.fn();
    await expect(codex.spawn('hi', {
      cwd: dir,
      environment: { model: 'test-model', sandbox: { trust: 'public', mode: 'workspace' } },
      env: { ...process.env, CODEX_HOME: join(root, 'operator') },
      agentName: 'refusal-test',
      _codexVersion: '0.162.1',
      _publicCodexHome: join(root, 'public'),
      _spawnImpl: spawnImpl,
    })).rejects.toMatchObject({ code: 'workspace_git_runs_programs' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test('a private codex seat is not checked: it runs git as its operator anyway', async () => {
    const dir = repo();
    git(dir, 'config', 'filter.probe.clean', 'sh -c x');
    const check = jest.fn();
    await codex.spawn('hi', {
      cwd: dir,
      environment: { model: 'test-model' },
      env: { ...process.env, CODEX_HOME: join(root, 'operator') },
      agentName: 'refusal-test',
      _codexVersion: '0.162.1',
      _refuseCodeRunningGitSetup: check,
      _spawnImpl: () => { throw new Error('stop after the check'); },
    }).catch(() => {});
    expect(check).not.toHaveBeenCalled();
  });
});
