import { jest } from '@jest/globals';
import {
  execFileSync as execFileSyncWithEnv,
  spawnSync,
} from 'node:child_process';
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareCommitAttribution } from '../src/lib/commit-attribution.js';

// A developer's global or system core.hooksPath would move every expected
// hooks directory, so the fixtures read only repository config. An inherited
// GIT_CONFIG would also send each fixture `git config` write to that file.
const isolateGitConfig = (env) => ({
  ...Object.fromEntries(Object.entries(env).filter(([name]) => (
    name !== 'GIT_CONFIG'
      && !name.startsWith('GIT_CONFIG_')
      && !name.startsWith('COMMONLY_AGENT_')
  ))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});
const fixtureEnv = isolateGitConfig(process.env);
const execFileSync = (command, args, options = {}) => execFileSyncWithEnv(command, args, {
  env: fixtureEnv,
  ...options,
});

const makeExecutable = (path, content) => {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o700 });
  accessSync(path, constants.X_OK);
};

// A git that refuses the repository at once, as on a "dubious ownership" error.
const FAILING_GIT = '#!/bin/sh\necho "fatal: detected dubious ownership" >&2\nexit 128\n';

describe('prepareCommitAttribution', () => {
  test('adds both trailers, preserves Git identity and delegates the repository hooks', () => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-commit-attribution-'));
    const repo = join(root, 'repo');
    const originalHooks = join(root, 'existing-hooks');
    const marker = join(root, 'pre-commit-ran');
    mkdirSync(repo);
    mkdirSync(originalHooks);
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Fixture Author'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: repo });
    execFileSync('git', ['config', 'core.hooksPath', originalHooks], { cwd: repo });
    makeExecutable(
      join(originalHooks, 'prepare-commit-msg'),
      '#!/bin/sh\n'
        + 'message_tmp="$1.existing-hook"\n'
        + 'subject=$(head -n 1 "$1")\n'
        + '{ printf "%s\\n\\nExisting-Hook: ran\\n" "$subject"; tail -n +2 "$1"; '
        + 'printf "\\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\\n"; } '
        + '> "$message_tmp"\n'
        + 'mv "$message_tmp" "$1"\n',
    );
    makeExecutable(
      join(originalHooks, 'pre-commit'),
      '#!/bin/sh\nprintf ran > "$COMMONLY_TEST_PRE_COMMIT_MARKER"\n',
    );

    const env = {
      ...fixtureEnv,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: originalHooks,
      GIT_CONFIG_KEY_1: 'advice.detachedHead',
      GIT_CONFIG_VALUE_1: 'false',
      COMMONLY_TEST_PRE_COMMIT_MARKER: marker,
    };
    const attribution = prepareCommitAttribution({
      cwd: repo,
      env,
      agentName: 'sprint-impl',
      displayName: 'Sprint Impl',
      instanceId: 'seat/1',
      adapter: 'codex',
      model: 'openai/gpt-5.4',
      effort: 'high',
    });

    try {
      expect(attribution.env.GIT_CONFIG_COUNT).toBe('3');
      expect(attribution.env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
      expect(attribution.env.GIT_CONFIG_VALUE_0).toBe(originalHooks);
      expect(attribution.env.GIT_CONFIG_KEY_1).toBe('advice.detachedHead');
      expect(attribution.env.GIT_CONFIG_VALUE_1).toBe('false');
      expect(attribution.env.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH).toBe(realpathSync(originalHooks));
      expect(execFileSync('git', ['config', '--get', 'advice.detachedHead'], {
        cwd: repo, env: attribution.env, encoding: 'utf8',
      }).trim()).toBe('false');
      expect(attribution.sandboxEnv.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH)
        .toBe(realpathSync(originalHooks));
      expect(execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: repo, env: attribution.env, encoding: 'utf8',
      }).trim()).toBe(attribution.hooksDirectory);

      writeFileSync(join(repo, 'change.txt'), 'seat change\n');
      execFileSync('git', ['add', 'change.txt'], { cwd: repo, env: attribution.env });
      execFileSync('git', ['commit', '-m', 'seat change'], { cwd: repo, env: attribution.env });

      const message = execFileSync('git', ['show', '-s', '--format=%B', 'HEAD'], {
        cwd: repo, env: attribution.env, encoding: 'utf8',
      });
      expect(message).toContain('Existing-Hook: ran');
      expect(message).toContain('Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>');
      expect(message).toContain(
        'Co-authored-by: Sprint Impl <WyJzcHJpbnQtaW1wbCIsInNlYXQvMSJd@agents.commonly.invalid>',
      );
      expect(message).toContain('Agent-Model: codex/openai/gpt-5.4/high');
      expect(message.split(/\r?\n/)).toContain('Agent-Model: codex/openai/gpt-5.4/high');
      expect(message.match(/^Co-authored-by: Sprint Impl /gm)).toHaveLength(1);
      expect(message.match(/^Agent-Model: codex\//gm)).toHaveLength(1);
      const parsedTrailers = execFileSync('git', ['interpret-trailers', '--parse'], {
        cwd: repo,
        env: attribution.env,
        input: message,
        encoding: 'utf8',
      });
      expect(parsedTrailers).toContain(
        'Co-authored-by: Sprint Impl <WyJzcHJpbnQtaW1wbCIsInNlYXQvMSJd@agents.commonly.invalid>',
      );
      expect(existsSync(marker)).toBe(true);
      expect(execFileSync('git', ['show', '-s', '--format=%an <%ae>', 'HEAD'], {
        cwd: repo, env: attribution.env, encoding: 'utf8',
      }).trim()).toBe('Fixture Author <fixture@example.test>');

      const messageFile = join(root, 'repeat-message');
      writeFileSync(messageFile, `${message}\n`);
      // Match the original path to the proxy directory so the recursion guard
      // skips delegation while this test checks trailer idempotence.
      const hook = spawnSync(join(attribution.hooksDirectory, 'prepare-commit-msg'), [messageFile, 'message'], {
        cwd: repo,
        env: { ...attribution.env, COMMONLY_AGENT_HOOKS_PATH: originalHooks },
        encoding: 'utf8',
      });
      expect(hook.status).toBe(0);
      const repeated = readFileSync(messageFile, 'utf8');
      expect(repeated.match(/^Co-authored-by: Sprint Impl /gm)).toHaveLength(1);
      expect(repeated.match(/^Agent-Model: codex\//gm)).toHaveLength(1);
    } finally {
      attribution.cleanup();
      expect(existsSync(attribution.hooksDirectory)).toBe(false);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: 'the target default hooks directory',
      workspaceHooksPath: null,
      targetHooksPath: null,
      targetHook: 'target',
    },
    {
      name: 'the target relative core.hooksPath',
      workspaceHooksPath: '.husky/_',
      targetHooksPath: '.husky/_',
      targetHook: 'target',
    },
    {
      name: 'the target default hooks directory despite the workspace hooksPath overlay',
      workspaceHooksPath: '.husky/_',
      targetHooksPath: null,
      targetHook: 'target',
    },
    {
      name: 'no hooks in a second repo despite the workspace hooksPath',
      workspaceHooksPath: '.husky/_',
      targetHooksPath: null,
      targetHook: null,
    },
    {
      name: 'the effective global hooksPath instead of the workspace env overlay',
      workspaceHooksPath: '.husky/_',
      targetHooksPath: null,
      targetHook: 'global',
    },
  ])('uses $name and still adds seat attribution', ({ workspaceHooksPath, targetHooksPath, targetHook }) => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-commit-attribution-other-repo-'));
    const workspace = join(root, 'workspace');
    const target = join(root, 'target');
    const workspaceHooks = workspaceHooksPath
      ? join(workspace, ...workspaceHooksPath.split('/'))
      : null;
    const targetHooks = targetHooksPath
      ? join(target, ...targetHooksPath.split('/'))
      : join(target, '.git', 'hooks');
    const globalHooks = join(root, 'global-hooks');
    const globalConfig = join(root, 'gitconfig');
    const workspaceMarker = join(root, 'workspace-hook-ran');
    const targetMarker = join(root, 'target-hook-ran');
    const globalMarker = join(root, 'global-hook-ran');
    mkdirSync(workspace);
    mkdirSync(target);
    for (const repo of [workspace, target]) {
      execFileSync('git', ['init', '--quiet'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Fixture Author'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: repo });
    }
    if (targetHook === 'target') mkdirSync(targetHooks, { recursive: true });

    if (workspaceHooksPath) {
      mkdirSync(workspaceHooks, { recursive: true });
      execFileSync('git', ['config', 'core.hooksPath', workspaceHooksPath], { cwd: workspace });
      makeExecutable(
        join(workspaceHooks, 'pre-commit'),
        '#!/bin/sh\nprintf workspace > "$COMMONLY_TEST_WORKSPACE_HOOK_MARKER"\n',
      );
    }
    if (targetHooksPath) {
      execFileSync('git', ['config', 'core.hooksPath', targetHooksPath], { cwd: target });
    }
    if (targetHook === 'target') {
      makeExecutable(
        join(targetHooks, 'pre-commit'),
        '#!/bin/sh\nprintf target > "$COMMONLY_TEST_TARGET_HOOK_MARKER"\n',
      );
    }
    if (targetHook === 'global') {
      mkdirSync(globalHooks, { recursive: true });
      writeFileSync(globalConfig, `[core]\n\thooksPath = ${globalHooks}\n`);
      makeExecutable(
        join(globalHooks, 'pre-commit'),
        '#!/bin/sh\nprintf global > "$COMMONLY_TEST_GLOBAL_HOOK_MARKER"\n',
      );
    }

    let attribution;
    try {
      attribution = prepareCommitAttribution({
        cwd: workspace,
        env: {
          ...fixtureEnv,
          ...(workspaceHooksPath ? {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.hooksPath',
            GIT_CONFIG_VALUE_0: workspaceHooksPath,
          } : {}),
          ...(targetHook === 'global' ? { GIT_CONFIG_GLOBAL: globalConfig } : {}),
          COMMONLY_TEST_TARGET_HOOK_MARKER: targetMarker,
          COMMONLY_TEST_WORKSPACE_HOOK_MARKER: workspaceMarker,
          COMMONLY_TEST_GLOBAL_HOOK_MARKER: globalMarker,
        },
        agentName: 'forge',
        displayName: 'Forge',
        instanceId: 'task-240',
        adapter: 'codex',
        model: 'test-model',
        effort: 'high',
      });

      writeFileSync(join(target, 'change.txt'), 'target repo change\n');
      execFileSync('git', ['add', 'change.txt'], { cwd: target, env: attribution.env });
      execFileSync('git', ['commit', '-m', 'target repo change'], {
        cwd: target,
        env: attribution.env,
      });

      expect(existsSync(targetMarker)).toBe(targetHook === 'target');
      if (targetHook === 'target') expect(readFileSync(targetMarker, 'utf8')).toBe('target');
      expect(existsSync(globalMarker)).toBe(targetHook === 'global');
      if (targetHook === 'global') expect(readFileSync(globalMarker, 'utf8')).toBe('global');
      expect(existsSync(workspaceMarker)).toBe(false);
      expect(execFileSync('git', ['show', '-s', '--format=%B', 'HEAD'], {
        cwd: target,
        env: attribution.env,
        encoding: 'utf8',
      })).toContain('Co-authored-by: Forge ');
    } finally {
      attribution?.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses an invalid pre-existing GIT_CONFIG_COUNT without creating hooks', () => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-commit-attribution-invalid-'));
    try {
      expect(() => prepareCommitAttribution({
        cwd: root,
        env: { ...fixtureEnv, GIT_CONFIG_COUNT: 'nope' },
        agentName: 'sprint-impl',
        adapter: 'codex',
      })).toThrow(/GIT_CONFIG_COUNT is invalid/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fixture git config writes land in the repository, not an inherited GIT_CONFIG file', () => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-commit-attribution-git-config-'));
    const repo = join(root, 'repo');
    const outside = join(root, 'outside.gitconfig');
    try {
      mkdirSync(repo);
      writeFileSync(outside, '[user]\n\tname = Outside\n');
      const env = isolateGitConfig({ ...process.env, GIT_CONFIG: outside });
      execFileSync('git', ['init', '--quiet'], { cwd: repo, env });
      execFileSync('git', ['config', 'core.hooksPath', 'team-hooks'], { cwd: repo, env });
      expect(readFileSync(outside, 'utf8')).toBe('[user]\n\tname = Outside\n');
      expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toContain('hooksPath = team-hooks');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a git child that never exits cannot block the turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-commit-attribution-hung-git-'));
    const stubBin = join(root, 'bin');
    mkdirSync(stubBin);
    // A repository whose hooks a fallback would find, so an absent path below
    // shows that a timed-out probe reads nothing.
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    // Stands in for a git whose open() never returns, as on a seat whose
    // gitdir sits under a consent-protected folder. It ignores SIGTERM, so
    // only the SIGKILL the probe sends can end it.
    makeExecutable(join(stubBin, 'git'), '#!/bin/sh\ntrap "" TERM\nexec sleep 60\n');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let attribution;
    try {
      const startedAt = Date.now();
      attribution = prepareCommitAttribution({
        cwd: root,
        env: { ...fixtureEnv, PATH: `${stubBin}:${fixtureEnv.PATH}` },
        agentName: 'quire',
        adapter: 'claude',
      });
      expect(Date.now() - startedAt).toBeLessThan(15000);
      expect(attribution.env.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH).toBeUndefined();
      expect(attribution.env.GIT_CONFIG_VALUE_0).toBe(attribution.hooksDirectory);
      expect(existsSync(join(attribution.hooksDirectory, 'prepare-commit-msg'))).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('did not answer in 5s');
    } finally {
      warn.mockRestore();
      attribution?.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test.each([
    {
      name: 'the default hooks folder',
      setup: (repo) => {
        mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
        return { cwd: repo, expected: join(repo, '.git', 'hooks') };
      },
    },
    {
      name: 'a relative core.hooksPath, resolved from the top of the tree',
      setup: (repo) => {
        mkdirSync(join(repo, '.husky', '_'), { recursive: true });
        mkdirSync(join(repo, 'src'));
        execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: repo });
        return { cwd: join(repo, 'src'), expected: join(repo, '.husky', '_') };
      },
    },
    {
      name: 'a quoted core.hooksPath that ends in a space, with a trailing comment',
      setup: (repo, root) => {
        const hooks = join(root, 'shared hooks ');
        mkdirSync(hooks);
        appendFileSync(join(repo, '.git', 'config'), `[core]\n\thooksPath = "${hooks}" ; set by hand\n`);
        return { cwd: repo, expected: hooks };
      },
    },
    {
      name: "a linked worktree's main repository hooks",
      setup: (repo, root) => {
        mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
        execFileSync('git', ['commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
        const worktree = join(root, 'worktree');
        execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'side', worktree], { cwd: repo });
        return { cwd: worktree, expected: join(repo, '.git', 'hooks') };
      },
    },
    {
      name: 'the hooks of a gitdir: pointer relative to the .git file',
      setup: (repo, root) => {
        // Submodules write a relative pointer, and git worktree add does not.
        const store = join(root, 'store');
        renameSync(join(repo, '.git'), store);
        writeFileSync(join(repo, '.git'), 'gitdir: ../store\n');
        mkdirSync(join(store, 'hooks'), { recursive: true });
        mkdirSync(join(repo, 'src'));
        return { cwd: join(repo, 'src'), expected: join(store, 'hooks') };
      },
    },
    {
      name: "a ~/ core.hooksPath under the probe's HOME",
      setup: (repo, root) => {
        const home = join(root, 'home');
        mkdirSync(join(home, 'team-hooks'), { recursive: true });
        execFileSync('git', ['config', 'core.hooksPath', '~/team-hooks'], { cwd: repo });
        return { cwd: repo, expected: join(home, 'team-hooks'), env: { HOME: home } };
      },
    },
  ])('a git that fails at once still yields $name', ({ setup }) => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-commit-attribution-fallback-'));
    const repo = join(root, 'repo');
    const stubBin = join(root, 'bin');
    mkdirSync(repo);
    mkdirSync(stubBin);
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Fixture Author'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: repo });
    const { cwd, expected, env = {} } = setup(repo, root);
    // The fallback stands in for the probe, so real git checks the fixture
    // and the probe's reading of git's answer.
    const reported = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], {
      cwd, env: { ...fixtureEnv, ...env }, encoding: 'utf8',
    }).replace(/\n$/, '');
    expect(realpathSync(reported)).toBe(realpathSync(expected));
    const probed = prepareCommitAttribution({
      cwd, env: { ...fixtureEnv, ...env }, agentName: 'forge', adapter: 'claude',
    });
    probed.cleanup();
    expect(realpathSync(probed.env.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH)).toBe(realpathSync(expected));
    makeExecutable(join(stubBin, 'git'), FAILING_GIT);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let attribution;
    try {
      attribution = prepareCommitAttribution({
        cwd,
        env: { ...fixtureEnv, ...env, PATH: `${stubBin}:${fixtureEnv.PATH}` },
        agentName: 'forge',
        adapter: 'claude',
      });
      expect(realpathSync(attribution.env.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH))
        .toBe(realpathSync(expected));
      expect(attribution.sandboxEnv.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH)
        .toBe(attribution.env.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('(exit 128)');
      expect(warn.mock.calls[0][0]).toContain('read from the repository');
    } finally {
      warn.mockRestore();
      attribution?.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a git that fails at once outside any repository grants nothing and says nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-commit-attribution-no-repo-'));
    const stubBin = join(root, 'bin');
    mkdirSync(stubBin);
    makeExecutable(join(stubBin, 'git'), FAILING_GIT);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let attribution;
    try {
      attribution = prepareCommitAttribution({
        cwd: root,
        env: { ...fixtureEnv, PATH: `${stubBin}:${fixtureEnv.PATH}` },
        agentName: 'forge',
        adapter: 'claude',
      });
      expect(attribution.env.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      attribution?.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps long seat IDs inside the email local-part limit with a stable hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-commit-attribution-long-seat-'));
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    let first;
    let second;
    try {
      const identity = {
        cwd: root,
        env: fixtureEnv,
        agentName: 'a'.repeat(31),
        displayName: 'Long Seat',
        instanceId: 'b'.repeat(31),
        adapter: 'codex',
        model: 'gpt-test',
        effort: 'high',
      };
      first = prepareCommitAttribution(identity);
      second = prepareCommitAttribution(identity);

      const seatId = first.env.COMMONLY_AGENT_SEAT_ID;
      expect(seatId).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/);
      expect(seatId.length).toBeLessThanOrEqual(64);
      expect(second.env.COMMONLY_AGENT_SEAT_ID).toBe(seatId);
    } finally {
      first?.cleanup();
      second?.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('public sandboxes receive only the Commonly hook config, not caller Git config values', () => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-commit-attribution-sandbox-'));
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const originalHooks = join(root, 'existing-hooks');
    mkdirSync(originalHooks);
    const attribution = prepareCommitAttribution({
      cwd: root,
      env: {
        ...fixtureEnv,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: originalHooks,
        GIT_CONFIG_KEY_1: 'http.extraHeader',
        GIT_CONFIG_VALUE_1: 'Authorization: Bearer private-value',
      },
      agentName: 'sprint-impl',
      displayName: 'Sprint Impl',
      instanceId: 'default',
      adapter: 'codex',
      model: 'gpt-test',
      effort: 'high',
    });

    try {
      expect(attribution.env.GIT_CONFIG_COUNT).toBe('3');
      expect(attribution.env.GIT_CONFIG_KEY_1).toBe('http.extraHeader');
      expect(attribution.env.GIT_CONFIG_VALUE_1).toContain('private-value');
      expect(attribution.sandboxEnv).toMatchObject({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: attribution.hooksDirectory,
        COMMONLY_AGENT_GIT_CONFIG_INDEX: '0',
        COMMONLY_AGENT_GIT_CONFIG_BASE_COUNT: '0',
        COMMONLY_AGENT_ORIGINAL_HOOKS_PATH: realpathSync(originalHooks),
      });
      expect(JSON.stringify(attribution.sandboxEnv)).not.toContain('private-value');
    } finally {
      attribution.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
