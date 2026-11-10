// Growth's F370 hand walk: setup and doctor said all was well, and the first
// @mention then failed with "claude exited 1: Not logged in". The CLIs' own
// status commands answer by exit code, which is all that is read.
import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

import {
  LOGIN_STATUS_ARGS, runLoginStatus, signedOutAdapters, signedOutHint,
} from '../src/lib/adapter-login.js';
import { checkAdapterLogin, FAIL, PASS, SKIP } from '../src/lib/doctor.js';
import { seatProviderKeyEnv } from '../src/lib/adapters/index.js';

const installed = (names) => async (name) => (names.includes(name) ? { version: '1.0.0' } : null);

describe('which installed adapters are signed out', () => {
  test('asks each CLI its own status, and names the ones that exit non-zero', async () => {
    const runStatus = jest.fn(async (name) => (name === 'claude' ? 1 : 0));
    expect(await signedOutAdapters({ detect: installed(['claude', 'codex']), runStatus, env: {} })).toEqual(['claude']);
    expect(runStatus).toHaveBeenCalledWith('claude', LOGIN_STATUS_ARGS.claude);
    expect(runStatus).toHaveBeenCalledWith('codex', LOGIN_STATUS_ARGS.codex);
  });

  test('an adapter that is not installed is not asked', async () => {
    const runStatus = jest.fn(async () => 1);
    expect(await signedOutAdapters({ detect: installed(['codex']), runStatus, env: {} })).toEqual(['codex']);
    expect(runStatus).toHaveBeenCalledTimes(1);
  });

  test('no verdict (timeout, spawn error) is not "signed out"', async () => {
    expect(await signedOutAdapters({ detect: installed(['claude']), runStatus: async () => null, env: {} })).toEqual([]);
    expect(await signedOutAdapters({ detect: installed(['claude']), runStatus: async () => { throw new Error('x'); }, env: {} })).toEqual([]);
  });

  test('ANTHROPIC_API_KEY counts as a claude sign-in; OPENAI_API_KEY is not one for codex', async () => {
    const runStatus = jest.fn(async () => 1);
    expect(await signedOutAdapters({ detect: installed(['claude', 'codex']), runStatus, env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' } })).toEqual(['codex']);
    expect(runStatus).toHaveBeenCalledTimes(1);
  });

  test('only exit 1 means signed out: an old CLI\'s unknown-subcommand exit is no verdict', async () => {
    expect(await signedOutAdapters({ detect: installed(['codex']), runStatus: async () => 2, env: {} })).toEqual([]);
  });

  test('the hint names the fix', () => {
    expect(signedOutHint('claude')).toBe('claude is installed but not signed in; run `claude` once to log in before adding an agent');
  });

  test('runLoginStatus discards every stream and resolves the exit code', async () => {
    const spawnFn = jest.fn(() => {
      const child = new EventEmitter();
      child.kill = jest.fn();
      setImmediate(() => child.emit('exit', 1));
      return child;
    });
    await expect(runLoginStatus('codex', ['login', 'status'], { spawnFn })).resolves.toBe(1);
    expect(spawnFn.mock.calls[0][2]).toMatchObject({ stdio: 'ignore' });
  });

  test('runLoginStatus gives up on a CLI that never exits', async () => {
    const child = new EventEmitter();
    child.kill = jest.fn();
    await expect(runLoginStatus('claude', [], { spawnFn: () => child, timeoutMs: 5 })).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalled();
  });
});

describe('doctor: adapter-login', () => {
  test('fails when an agent here uses the signed-out adapter, with the fix', async () => {
    const line = await checkAdapterLogin({ agents: [{ adapter: 'claude' }], probe: async () => ['claude'] });
    expect(line.status).toBe(FAIL);
    expect(line.detail).toContain('claude is installed but not signed in');
    expect(line.fix).toBe('run `claude` once to log in');
  });

  test('passes but still says it when no agent uses it yet', async () => {
    const line = await checkAdapterLogin({ agents: [], probe: async () => ['codex'] });
    expect(line.status).toBe(PASS);
    expect(line.detail).toContain('codex is installed but not signed in');
  });

  test('passes when all are signed in, and skips with no probe', async () => {
    expect((await checkAdapterLogin({ agents: [], probe: async () => [] })).status).toBe(PASS);
    expect((await checkAdapterLogin({ agents: [] })).status).toBe(SKIP);
  });
});

describe('the provider key one seat needs', () => {
  test('claude and codex sign in through their own CLI and need none', () => {
    expect(seatProviderKeyEnv({ adapter: 'claude' })).toBeNull();
    expect(seatProviderKeyEnv({ adapter: 'codex' })).toBeNull();
    expect(seatProviderKeyEnv({})).toBeNull();
  });

  test('pi needs its declared key, or the one its provider names, and none with a keyFile', () => {
    expect(seatProviderKeyEnv({ adapter: 'pi' })).toBe('COMMONLY_LITELLM_KEY');
    expect(seatProviderKeyEnv({ adapter: 'pi', environment: { provider: { apiKeyEnv: 'MY_KEY' } } })).toBe('MY_KEY');
    expect(seatProviderKeyEnv({ adapter: 'pi', environment: { provider: { keyFile: '/k' } } })).toBeNull();
  });
});
