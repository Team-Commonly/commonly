/**
 * `effort` is the reasoning budget a seat runs at. Sam's 2026-09-01 order:
 * "flip all fable agents into fable 5.1 with high or above effort." The
 * wrapper had no way to say it — `--effort` never left the operator's own
 * terminal — so every Fable seat ran at the CLI default while nothing
 * recorded that it did. Same shape as the model-pin gap (#774): a fact that
 * lived only in a process environment, dropped by every restart.
 *
 * Two assertions carry the weight: the retry one (a session-recovery spawn
 * must not silently run at a different effort than the turn it replaces —
 * the drifting-copy failure this codebase keeps re-learning), and the
 * validator one (a closed set fails at attach, not at first spawn).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import claude from '../src/lib/adapters/claude.js';
import { validateEnvironmentSpec } from '../src/lib/environment.js';

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

describe('claude adapter — effort passthrough', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-effort-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('passes --effort next to --model when the environment sets both', async () => {
    const { impl, calls } = makeSpawnImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      environment: { model: 'claude-fable-5-1', effort: 'high' },
      _spawnImpl: impl,
    });
    expect(flagValue(calls[0].args, '--model')).toBe('claude-fable-5-1');
    expect(flagValue(calls[0].args, '--effort')).toBe('high');
  });

  test('passes no --effort when the environment omits it', async () => {
    const { impl, calls } = makeSpawnImpl();
    await claude.spawn('hi', { sessionId: null, cwd, environment: { model: 'claude-fable-5-1' }, _spawnImpl: impl });
    expect(calls[0].args).not.toContain('--effort');
  });

  test('carries the same --effort into the session-recovery retry', async () => {
    const { impl, calls } = makeSpawnImpl(['session-conflict', 'ok']);
    await claude.spawn('hi', {
      sessionId: 'existing-session',
      cwd,
      environment: { model: 'claude-fable-5-1', effort: 'high' },
      _spawnImpl: impl,
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(flagValue(call.args, '--effort')).toBe('high');
      expect(flagValue(call.args, '--model')).toBe('claude-fable-5-1');
    }
  });
});

describe('environment spec — effort validation', () => {
  test('accepts the five documented levels', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(validateEnvironmentSpec({ version: 1, effort }).ok).toBe(true);
    }
  });

  test('rejects an unknown level at attach time, naming the set', () => {
    const result = validateEnvironmentSpec({ version: 1, effort: 'ultra' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/effort must be one of: low, medium, high, xhigh, max/);
  });
});
