/**
 * The claude adapter must pin the model when ctx.environment.model is set.
 *
 * Why this exists: without a pin, `claude` picks its own default. On 2026-08-16
 * that produced a ten-agent fleet running three different Opus versions that
 * nobody chose and nothing recorded — including a seat named `fable-lead`
 * running Opus. The platform could not answer "what is this agent running"
 * without grepping a hidden directory on one laptop.
 *
 * The retry assertion is the load-bearing one. `spawn()` builds args in TWO
 * places — the normal path and the session-recovery path — and a model present
 * in one but not the other means a retry silently runs a different model than
 * the turn it replaces. That is the drifting-copy failure this codebase keeps
 * repeating, and it would be invisible: same output shape, different engine.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import claude from '../src/lib/adapters/claude.js';

const makeSpawnImpl = (behaviours = []) => {
  const calls = [];
  let n = 0;
  const impl = (cmd, args) => {
    calls.push({ cmd, args });
    const behaviour = behaviours[n] || 'ok';
    n += 1;
    const listeners = {};
    const proc = {
      stdout: { on: (e, cb) => { if (e === 'data' && behaviour === 'ok') cb('done'); } },
      stderr: { on: (e, cb) => { if (e === 'data' && behaviour === 'session-conflict') cb('session id already in use'); } },
      on: (e, cb) => { listeners[e] = cb; },
    };
    setImmediate(() => {
      if (listeners.close) listeners.close(behaviour === 'session-conflict' ? 1 : 0);
    });
    return proc;
  };
  return { impl, calls };
};

const flagValue = (args, flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe('claude adapter — model pinning', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-model-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('passes --model when the environment specifies one', async () => {
    const { impl, calls } = makeSpawnImpl();

    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { model: 'claude-opus-5' },
      _spawnImpl: impl,
    });

    expect(calls).toHaveLength(1);
    expect(flagValue(calls[0].args, '--model')).toBe('claude-opus-5');
  });

  test('passes no --model when the environment omits it, so the CLI default stands', async () => {
    const { impl, calls } = makeSpawnImpl();

    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: {},
      _spawnImpl: impl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).not.toContain('--model');
  });

  test('is absent-safe when ctx carries no environment at all', async () => {
    const { impl, calls } = makeSpawnImpl();

    await claude.spawn('hi', { sessionId: null, cwd, _spawnImpl: impl });

    expect(calls[0].args).not.toContain('--model');
  });

  // THE one that matters: a session-recovery retry must not switch engines.
  test('carries the same --model into the session-recovery retry', async () => {
    const { impl, calls } = makeSpawnImpl(['session-conflict', 'ok']);

    await claude.spawn('hi', {
      sessionId: 'stale-session-id',
      cwd,
      environment: { model: 'claude-opus-5' },
      _spawnImpl: impl,
    });

    expect(calls.length).toBeGreaterThan(1);
    const retry = calls[calls.length - 1];
    expect(retry.args).toContain('--session-id');
    expect(flagValue(retry.args, '--model')).toBe('claude-opus-5');
  });
});
