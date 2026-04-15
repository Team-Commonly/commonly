/**
 * run-loop.test.mjs — ADR-005 Phase 1a
 *
 * Covers performRun, the local-CLI wrapper's poll/spawn/post/ack loop.
 *
 * Verifies:
 *  - Happy path: event → adapter.spawn → post to pod → ack
 *  - No-prompt event: no spawn, still acked as 'no_action'
 *  - Adapter failure: no post, no ack (kernel re-delivers — ADR-005)
 *  - Session continuity: newSessionId persists; next event sees it
 *  - stop() halts further polling
 *
 * Mocks `createClient` from api.js so no HTTP is ever issued. A no-op
 * setTimeout is injected so the loop runs exactly one cycle per test.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-test-'));

await jest.unstable_mockModule('os', () => {
  const actual = os;
  return {
    ...actual,
    default: { ...actual, homedir: () => sessionsTmpDir },
    homedir: () => sessionsTmpDir,
  };
});

await jest.unstable_mockModule('../src/lib/api.js', () => ({
  createClient: jest.fn(),
  login: jest.fn(),
}));

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const { getSession, setSession, clearSessions } = await import('../src/lib/session-store.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

const makeEvent = (overrides = {}) => ({
  _id: 'evt-1',
  type: 'chat.mention',
  podId: 'pod-abc',
  agentName: 'my-stub',
  instanceId: 'default',
  payload: { content: 'hello from tester' },
  ...overrides,
});

// setTimeout that never fires — ensures performRun executes exactly one cycle.
const noopTimeout = () => 0;

// Let the initial tick() promise chain drain before stopping. The longest
// chain is currently:  get(/events) → get(/memory) → adapter.spawn →
// post(/messages) → post(/memory/sync) → post(/events/:id/ack)  — 6 await
// boundaries. Loop DRAIN_DEPTH setImmediates so each level resolves. Bump
// this if another phase extends the chain.
const DRAIN_DEPTH = 10;
const drainMicrotasks = async () => {
  for (let i = 0; i < DRAIN_DEPTH; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

describe('performRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('event with content → adapter.spawn → message posted → event acked', async () => {
    const events = [makeEvent()];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'hello back' }));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      instanceId: 'default',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    stop();

    expect(mockGet).toHaveBeenCalledWith(
      '/api/agents/runtime/events',
      expect.objectContaining({ agentName: 'my-stub', instanceId: 'default' }),
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe('hello from tester');

    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      { content: 'hello back' },
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-1/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('heartbeat event with payload.content is suppressed — chat-only events spawn', async () => {
    // Regression: a heartbeat with a stray `content` field must NOT trigger
    // a spawn. Only CHAT_EVENT_TYPES are forwarded to the CLI.
    const events = [makeEvent({
      _id: 'evt-hb',
      type: 'heartbeat',
      payload: { content: 'do not spawn me' },
    })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn();
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    stop();

    expect(spawn).not.toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-hb/ack',
      { result: { outcome: 'no_action' } },
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test('chat event with no podId → no spawn, no message, acked as no_action', async () => {
    const events = [makeEvent({ _id: 'evt-nopod', podId: null })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn();
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    stop();

    // No destination → skip spawn entirely, don't burn a CLI turn.
    expect(spawn).not.toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-nopod/ack',
      { result: { outcome: 'no_action' } },
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test('adapter.spawn throws → no post, no ack (re-delivery path)', async () => {
    const events = [makeEvent({ _id: 'evt-boom' })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn().mockRejectedValue(new Error('claude process died'));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };
    const errors = [];

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
      onError: (err) => errors.push(err),
    });
    await drainMicrotasks();
    stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/claude process died/);

    // CRITICAL: no message post, no ack — kernel MUST re-deliver.
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('newSessionId from spawn is persisted and reused on the next turn', async () => {
    // Route-aware mock: /events yields a fresh event each call, /memory
    // returns an empty envelope. `mockResolvedValueOnce` chaining broke once
    // the memory bridge landed because `/memory` began consuming the queue.
    let eventTurn = 0;
    const eventIds = ['turn-1', 'turn-2'];
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      const id = eventIds[eventTurn];
      eventTurn += 1;
      return { events: id ? [makeEvent({ _id: id })] : [] };
    });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const seenSessionIds = [];
    const spawn = jest.fn(async (_prompt, ctx) => {
      seenSessionIds.push(ctx.sessionId);
      return { text: 'ok', newSessionId: 'claude-sid-42' };
    });
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    // Cycle 1 — no session yet.
    const run1 = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    run1.stop();

    // Disk state: newSessionId should be persisted.
    expect(getSession('my-stub', 'pod-abc')).toBe('claude-sid-42');

    // Cycle 2 — should see the persisted session id injected into ctx.
    const run2 = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    run2.stop();

    expect(seenSessionIds).toEqual([null, 'claude-sid-42']);
  });

  test('clearSessions removes persisted session ids for an agent', async () => {
    setSession('my-stub', 'pod-a', 'sid-a');
    setSession('my-stub', 'pod-b', 'sid-b');
    setSession('other', 'pod-a', 'sid-other');
    expect(getSession('my-stub', 'pod-a')).toBe('sid-a');

    clearSessions('my-stub');

    expect(getSession('my-stub', 'pod-a')).toBeNull();
    expect(getSession('my-stub', 'pod-b')).toBeNull();
    // Other agents' sessions are untouched (per-agent file isolation).
    expect(getSession('other', 'pod-a')).toBe('sid-other');
  });

  test('memory bridge: reads /memory before spawn, injects into ctx.memoryLongTerm', async () => {
    const events = [makeEvent({ _id: 'mem-1' })];
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') {
        return { sections: { long_term: { content: 'remembered: likes dark mode' } } };
      }
      return { events };
    });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    let seenCtx;
    const spawn = jest.fn(async (_p, ctx) => {
      seenCtx = ctx;
      return { text: 'ok' };
    });
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    stop();

    expect(mockGet).toHaveBeenCalledWith('/api/agents/runtime/memory');
    expect(seenCtx.memoryLongTerm).toBe('remembered: likes dark mode');
  });

  test('memory bridge: syncs back when adapter returns memorySummary', async () => {
    const events = [makeEvent({ _id: 'sum-1' })];
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      return { events };
    });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({
      text: 'response',
      memorySummary: 'user complained about loading spinner',
    }));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    stop();

    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/memory/sync',
      expect.objectContaining({
        mode: 'patch',
        sourceRuntime: 'local-cli',
        sections: {
          long_term: {
            content: 'user complained about loading spinner',
            visibility: 'private',
          },
        },
      }),
    );
  });

  test('memory bridge: does NOT sync back when adapter omits memorySummary', async () => {
    const events = [makeEvent({ _id: 'no-sum' })];
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      return { events };
    });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'just a reply' }));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    stop();

    const syncCalls = mockPost.mock.calls.filter(
      ([route]) => route === '/api/agents/runtime/memory/sync',
    );
    expect(syncCalls).toHaveLength(0);
  });

  test('memory bridge: sync failure is non-fatal — message still posted, event still acked', async () => {
    const events = [makeEvent({ _id: 'sync-fail' })];
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      return { events };
    });
    const mockPost = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory/sync') throw new Error('500 sync down');
      return { ok: true };
    });
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'reply', memorySummary: 'summary' }));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };
    const errors = [];

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
      onError: (err) => errors.push(err),
    });
    await drainMicrotasks();
    stop();

    // Pod message still posted; event still acked as posted.
    const msgPosts = mockPost.mock.calls.filter(([r]) => r.includes('/messages'));
    const ackPosts = mockPost.mock.calls.filter(([r]) => r.endsWith('/ack'));
    expect(msgPosts).toHaveLength(1);
    expect(ackPosts).toHaveLength(1);
    expect(ackPosts[0][1]).toEqual({ result: { outcome: 'posted' } });
    // Sync failure surfaced via onError but didn't throw out of processEvent.
    expect(errors.some((e) => /memory sync failed/.test(e.message))).toBe(true);
  });

  test('stop() prevents subsequent events within the same cycle from being processed', async () => {
    const events = [makeEvent({ _id: 'e1' }), makeEvent({ _id: 'e2' })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    let handle;
    const spawn = jest.fn(async () => {
      // After the first spawn, stop the loop.
      handle?.stop();
      return { text: 'only-one' };
    });
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    handle = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();

    // Only the first event was processed; the second skipped due to stop().
    expect(spawn).toHaveBeenCalledTimes(1);
    const ackCalls = mockPost.mock.calls.filter(
      ([route]) => route.includes('/events/') && route.endsWith('/ack'),
    );
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0][0]).toContain('/events/e1/ack');
  });
});
