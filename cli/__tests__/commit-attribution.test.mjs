import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareCommitAttribution } from '../src/lib/commit-attribution.js';

const makeExecutable = (path, content) => {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o700 });
  accessSync(path, constants.X_OK);
};

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
      ...process.env,
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
      const hook = spawnSync(join(attribution.hooksDirectory, 'prepare-commit-msg'), [messageFile, 'message'], {
        cwd: repo,
        env: { ...attribution.env, COMMONLY_AGENT_ORIGINAL_HOOKS_PATH: '' },
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

  test('refuses an invalid pre-existing GIT_CONFIG_COUNT without creating hooks', () => {
    const root = mkdtempSync(join(tmpdir(), 'commonly-commit-attribution-invalid-'));
    try {
      expect(() => prepareCommitAttribution({
        cwd: root,
        env: { ...process.env, GIT_CONFIG_COUNT: 'nope' },
        agentName: 'sprint-impl',
        adapter: 'codex',
      })).toThrow(/GIT_CONFIG_COUNT is invalid/);
    } finally {
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
        env: process.env,
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
        ...process.env,
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
