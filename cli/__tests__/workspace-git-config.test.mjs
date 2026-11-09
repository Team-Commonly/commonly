/**
 * A public Codex seat refuses a workspace whose repository is set up to run
 * programs, since Codex runs git there outside the seat's sandbox. Real git,
 * real repositories: each hostile setup is written the way a copied or
 * unpacked folder would carry it.
 */
import { jest } from '@jest/globals';
import { spawnSync } from 'child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
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
const repo = (name = 'repo') => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first');
  return dir;
};

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
    expect(codeRunningGitSetup(dir)).toEqual([{ file: hook, hook: 'post-index-change' }]);
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

  test('a submodule\'s config is checked', () => {
    const dir = repo();
    const modules = join(dir, '.git', 'modules', 'lib');
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, 'config'), '[filter "x"]\n\tclean = sh -c y\n');
    expect(codeRunningGitSetup(dir).map((f) => f.key)).toEqual(['filter.x.clean']);
  });

  test('a config git cannot parse is refused, not skipped', () => {
    const dir = repo();
    writeFileSync(join(dir, '.git', 'config'), '[core\n\tbroken');
    expect(codeRunningGitSetup(dir).map((f) => f.key)).toEqual(['unreadable config']);
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
