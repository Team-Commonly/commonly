/**
 * detach.test.mjs — ADR-005 Phase 1c (lifecycle hardening)
 *
 * Covers `performDetach`:
 *   - backend DELETE + local token file removed + session store cleared
 *   - 404 from backend is treated as "already gone" and still cleans local
 *   - skipBackend:true (--force) short-circuits to local-only cleanup
 *   - non-404 backend errors propagate (so caller can retry / report)
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-detach-test-'));

await jest.unstable_mockModule('os', () => {
  const actual = os;
  return {
    ...actual,
    default: { ...actual, homedir: () => tmp },
    homedir: () => tmp,
  };
});

const {
  performDetach,
  saveAgentToken,
  loadAgentToken,
} = await import('../src/commands/agent.js');
const { setSession, getSession } = await import('../src/lib/session-store.js');

const seedAgentState = (name) => {
  saveAgentToken(name, {
    agentName: name,
    instanceId: 'default',
    podId: 'pod-1',
    instanceUrl: 'http://localhost:5000',
    runtimeToken: 'cm_agent_abc',
    adapter: 'stub',
  });
  // Drop a session entry too so we can verify it's cleared.
  setSession(name, 'pod-1', 'session-xyz');
};

const tokenFilePath = (name) => path.join(tmp, '.commonly', 'tokens', `${name}.json`);
const sessionFilePath = (name) => path.join(tmp, '.commonly', 'sessions', `${name}.json`);

describe('performDetach', () => {
  beforeEach(() => {
    fs.rmSync(path.join(tmp, '.commonly'), { recursive: true, force: true });
  });

  test('happy path: calls DELETE, removes token file, clears session store', async () => {
    seedAgentState('my-bot');
    expect(fs.existsSync(tokenFilePath('my-bot'))).toBe(true);
    expect(getSession('my-bot', 'pod-1')).toBe('session-xyz');

    const del = jest.fn().mockResolvedValue({ success: true });
    const client = { del, get: jest.fn(), post: jest.fn() };

    const result = await performDetach({
      client, agentName: 'my-bot', podId: 'pod-1',
    });

    expect(del).toHaveBeenCalledWith('/api/registry/agents/my-bot/pods/pod-1');
    expect(result.backend.skipped).toBe(false);
    expect(result.backend.alreadyGone).toBeUndefined();
    expect(result.localCleaned).toBe(true);
    // Local state gone
    expect(loadAgentToken('my-bot')).toBeNull();
    expect(getSession('my-bot', 'pod-1')).toBeNull();
    expect(fs.existsSync(sessionFilePath('my-bot'))).toBe(false);
  });

  test('treats backend 404 as "already uninstalled" and still cleans local state', async () => {
    seedAgentState('stale-bot');

    const notFound = Object.assign(new Error('not found'), { status: 404 });
    const del = jest.fn().mockRejectedValue(notFound);
    const client = { del, get: jest.fn(), post: jest.fn() };

    const result = await performDetach({
      client, agentName: 'stale-bot', podId: 'pod-1',
    });

    expect(del).toHaveBeenCalled();
    expect(result.backend.alreadyGone).toBe(true);
    expect(loadAgentToken('stale-bot')).toBeNull();
  });

  test('skipBackend:true does not call DELETE and still cleans local state', async () => {
    seedAgentState('offline-bot');

    const del = jest.fn();
    const client = { del, get: jest.fn(), post: jest.fn() };

    const result = await performDetach({
      client, agentName: 'offline-bot', podId: 'pod-1', skipBackend: true,
    });

    expect(del).not.toHaveBeenCalled();
    expect(result.backend.skipped).toBe(true);
    expect(loadAgentToken('offline-bot')).toBeNull();
  });

  test('re-throws non-404 backend errors (caller decides what to do)', async () => {
    seedAgentState('forbidden-bot');

    const forbidden = Object.assign(new Error('access denied'), { status: 403 });
    const client = { del: jest.fn().mockRejectedValue(forbidden), get: jest.fn(), post: jest.fn() };

    await expect(performDetach({
      client, agentName: 'forbidden-bot', podId: 'pod-1',
    })).rejects.toThrow(/access denied/);

    // Local state must be UNTOUCHED if backend call errored out — the caller
    // may retry the backend call; wiping local state first would orphan the
    // backend install with no way for the user to re-detach.
    expect(loadAgentToken('forbidden-bot')).not.toBeNull();
  });

  test('throws early when agentName or podId is missing (prevents "/pods/undefined" 404 masquerade)', async () => {
    const client = { del: jest.fn(), get: jest.fn(), post: jest.fn() };

    await expect(performDetach({
      client, agentName: null, podId: 'pod-1',
    })).rejects.toThrow(/agentName/);

    await expect(performDetach({
      client, agentName: 'x', podId: undefined,
    })).rejects.toThrow(/podId/);

    // skipBackend bypass: agentName is still required, but podId is optional
    // because we never construct the DELETE URL.
    await expect(performDetach({
      client, agentName: 'x', podId: null, skipBackend: true,
    })).resolves.toBeDefined();

    expect(client.del).not.toHaveBeenCalled();
  });

  test('is idempotent: detach when no local state exists still succeeds via skipBackend', async () => {
    // No seeding — user ran attach in another shell, or state was already cleaned.
    const del = jest.fn();
    const client = { del, get: jest.fn(), post: jest.fn() };

    const result = await performDetach({
      client, agentName: 'never-existed', podId: 'pod-1', skipBackend: true,
    });
    // clearSessions / deleteAgentToken no-op when files don't exist.
    expect(result.localCleaned).toBe(true);
    expect(del).not.toHaveBeenCalled();
  });
});
