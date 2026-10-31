/**
 * seatbelt.commit-hooks.smoke.test.mjs
 *
 * A confined seat commits under real sandbox-exec (TASK-322). When git cannot
 * report the hooks directory before the turn, the seat is still granted the
 * repository's hooks from the repository's own files, so a hook that lives
 * outside the workspace runs. The control commits in a jail without that
 * grant, where the hook does not run, so the test is not vacuous.
 */

import { jest } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import {
  accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { prepareCommitAttribution, supportedGitHooks } from '../src/lib/commit-attribution.js';
import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const macTest = process.platform === 'darwin' ? test : test.skip;

const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
  !name.startsWith('GIT_') && !name.startsWith('COMMONLY_AGENT_')
)));
const git = (args, cwd) => execFileSync('git', args, { cwd, env: fixtureEnv, encoding: 'utf8' });
const makeExecutable = (path, content) => {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o700 });
};
const isExecutable = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

describe('a confined seat whose git hooks probe failed', () => {
  let root;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  macTest('still runs a repository hook that lives outside the workspace', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'commonly-commit-hooks-seatbelt-')));
    const workspace = join(root, 'workspace');
    const state = join(root, 'state');
    const hooks = join(root, 'repo-hooks');
    const stubBin = join(root, 'bin');
    for (const dir of [workspace, state, hooks, stubBin]) mkdirSync(dir);
    git(['init', '--quiet'], workspace);
    git(['config', 'user.name', 'Fixture Author'], workspace);
    git(['config', 'user.email', 'fixture@example.test'], workspace);
    git(['config', 'core.hooksPath', hooks], workspace);
    // Git runs hooks from the top of the working tree, which the jail can write.
    makeExecutable(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf ran > hook-ran\n');
    makeExecutable(join(stubBin, 'git'), '#!/bin/sh\nexit 128\n');
    // The jail runs the binary git itself runs; /usr/bin/git is an xcrun shim.
    const realGit = realpathSync(join(git(['--exec-path'], workspace).trim(), 'git'));

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const attribution = prepareCommitAttribution({
      cwd: workspace,
      env: { ...fixtureEnv, PATH: `${stubBin}:${fixtureEnv.PATH}` },
      agentName: 'forge',
      displayName: 'Forge',
      adapter: 'claude',
    });
    warn.mockRestore();
    try {
      expect(attribution.env.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH).toBe(hooks);

      // The grant both adapters build from the attribution env
      // (claude.js and codex.js): every proxy hook, plus each original hook
      // that is executable.
      const commitInJail = (originalHooksPath, message) => {
        writeFileSync(join(workspace, `${message}.txt`), `${message}\n`);
        git(['add', `${message}.txt`], workspace);
        const executablePaths = [
          realGit,
          ...supportedGitHooks().map((name) => join(attribution.hooksDirectory, name)),
          ...(originalHooksPath ? supportedGitHooks()
            .map((name) => join(originalHooksPath, name))
            .filter(isExecutable) : []),
        ];
        const argv = wrapArgvWithSeatbelt([realGit, 'commit', '--quiet', '-m', message], {
          workspacePath: workspace,
          workspaceAccess: 'write',
          executablePath: realGit,
          statePath: state,
          executablePaths,
        });
        return spawnSync(argv[0], argv.slice(1), {
          cwd: workspace,
          env: {
            ...attribution.env,
            PATH: fixtureEnv.PATH,
            HOME: state,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          },
          encoding: 'utf8',
          timeout: 30_000,
        });
      };
      const lastMessage = () => git(['show', '-s', '--format=%B', 'HEAD'], workspace);

      // The jail lets a hook under /private/var pass `[ -x ]`, because the
      // baseline admits metadata there, but not run, so this commit is refused.
      // A hook whose metadata the jail hides fails `[ -x ]` and is skipped
      // instead. The hook runs in neither case.
      const control = commitInJail(null, 'without-grant');
      expect(control.status).not.toBe(0);
      expect(control.stderr).toContain('Operation not permitted');
      expect(existsSync(join(workspace, 'hook-ran'))).toBe(false);
      git(['reset', '--quiet'], workspace);

      const granted = commitInJail(attribution.env.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH, 'with-grant');
      expect(granted.stderr).toBe('');
      expect(granted.status).toBe(0);
      expect(lastMessage()).toContain('Co-authored-by: Forge ');
      expect(existsSync(join(workspace, 'hook-ran'))).toBe(true);
    } finally {
      attribution.cleanup();
    }
  }, 60_000);
});
