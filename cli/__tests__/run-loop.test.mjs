/**
 * run-loop.test.mjs — ADR-005 Phase 1a
 *
 * Covers performRun, the local-CLI wrapper's poll/spawn/post/ack loop.
 *
 * Verifies:
 *  - Happy path: event → adapter.spawn → post to pod → ack
 *  - No-prompt event: no spawn, still acked as 'no_action'
 *  - Adapter failure: no post, no ack (kernel re-delivers — ADR-005)
 *  - Duplicate delivery: no second spawn, duplicate is re-acked
 *  - Ack failure: handled id persists before the kernel re-delivers
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
const {
  getSession,
  setSession,
  clearSessions,
  wasEventHandled,
} = await import('../src/lib/session-store.js');
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

  test('first_contact event is forwarded to the adapter like a mention', async () => {
    const events = [makeEvent({
      _id: 'evt-first-contact',
      type: 'first_contact',
      payload: { content: 'Make a warm first impression.' },
    })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'Hi! What are you working on today?' }));
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

    expect(spawn).toHaveBeenCalledWith(
      'Make a warm first impression.',
      expect.objectContaining({ metadata: { event: events[0] } }),
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      { content: 'Hi! What are you working on today?' },
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-first-contact/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('self-post detection: a new BOT message during the spawn suppresses the echo', async () => {
    // The agent posted mid-turn via commonly_post_message (its own identity) —
    // echoing its CLI text would double-post.
    let messagesCall = 0;
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) {
        messagesCall += 1;
        return messagesCall === 1
          ? { messages: [{ _id: 'm1', isBot: false }] }
          : { messages: [{ _id: 'm1', isBot: false }, { _id: 'm2', isBot: true }] };
      }
      return { events: [makeEvent({ _id: 'evt-selfpost' })] };
    });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'narration of what I posted' }));
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

    expect(mockPost).not.toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      { content: 'narration of what I posted' },
    );
    // Turn still acks so the kernel doesn't re-deliver.
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-selfpost/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('self-post detection: a new HUMAN message during the spawn does NOT suppress the echo', async () => {
    // Regression for the 2026-07-22 as-operator attribution incident: an agent
    // posting through the operator's CLI profile lands a HUMAN-authored message
    // mid-spawn. The old id-only detection treated that as "agent posted
    // itself" and swallowed the correctly-attributed wrapper reply, so the
    // misattributed copy was the only one in the room. A human-authored new
    // message (isBot: false) must not suppress the echo.
    let messagesCall = 0;
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) {
        messagesCall += 1;
        return messagesCall === 1
          ? { messages: [{ _id: 'm1', isBot: false }] }
          : { messages: [{ _id: 'm1', isBot: false }, { _id: 'm2', isBot: false }] };
      }
      return { events: [makeEvent({ _id: 'evt-humanpost' })] };
    });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'my real reply' }));
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
      '/api/agents/runtime/pods/pod-abc/messages',
      { content: 'my real reply' },
    );
  });

  test('#757: ANOTHER agent posting during the spawn must NOT suppress this reply', async () => {
    // The multi-agent-room case. Two wrapper agents are mentioned in one
    // message and answer concurrently; the faster one lands its post inside
    // the slower one's spawn window. The old detection asked "did any bot
    // post?" and so threw away the slower agent's entire reply — silently,
    // because the event was still acked. Sam hit this hand-sequencing his
    // agents one at a time during a working session.
    let messagesCall = 0;
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) {
        messagesCall += 1;
        return messagesCall === 1
          ? { messages: [{ _id: 'm1', isBot: false, self: false }] }
          : {
            messages: [
              { _id: 'm1', isBot: false, self: false },
              // A DIFFERENT agent's post: bot-authored, but not ours.
              { _id: 'm2', isBot: true, self: false, username: 'other-agent' },
            ],
          };
      }
      return { events: [makeEvent({ _id: 'evt-otheragent' })] };
    });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'my real reply' }));
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
      '/api/agents/runtime/pods/pod-abc/messages',
      { content: 'my real reply' },
    );
  });

  test('#757: the agent OWN post (self: true) still suppresses the echo', async () => {
    // The double-post guarantee the detection exists for must survive the fix.
    let messagesCall = 0;
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) {
        messagesCall += 1;
        return messagesCall === 1
          ? { messages: [{ _id: 'm1', isBot: false, self: false }] }
          : {
            messages: [
              { _id: 'm1', isBot: false, self: false },
              { _id: 'm2', isBot: true, self: true, username: 'my-stub' },
            ],
          };
      }
      return { events: [makeEvent({ _id: 'evt-ownpost' })] };
    });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'narration of what I posted' }));
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

    expect(mockPost).not.toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      { content: 'narration of what I posted' },
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-ownpost/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('#757: our own post still suppresses even when another agent posted too', async () => {
    // Both happened in the window. Ours is what matters — suppress.
    let messagesCall = 0;
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) {
        messagesCall += 1;
        return messagesCall === 1
          ? { messages: [{ _id: 'm1', isBot: false, self: false }] }
          : {
            messages: [
              { _id: 'm1', isBot: false, self: false },
              { _id: 'm2', isBot: true, self: false, username: 'other-agent' },
              { _id: 'm3', isBot: true, self: true, username: 'my-stub' },
            ],
          };
      }
      return { events: [makeEvent({ _id: 'evt-bothposted' })] };
    });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'narration' }));
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

    expect(mockPost).not.toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      { content: 'narration' },
    );
  });

  test('ensures adapter cwd exists before spawning — avoids confusing spawn ENOENT on missing dir', async () => {
    const agentCwd = path.join(os.tmpdir(), 'commonly-agents', 'cwd-fresh-agent');
    fs.rmSync(agentCwd, { recursive: true, force: true });
    expect(fs.existsSync(agentCwd)).toBe(false);

    const mockGet = jest.fn().mockResolvedValue({ events: [] });
    const mockPost = jest.fn();
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn: jest.fn() };
    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'cwd-fresh-agent',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    stop();

    // Dir must be created at run start, NOT lazily on first spawn — otherwise
    // a run with only heartbeat events fails silently the first time a real
    // chat event lands.
    expect(fs.existsSync(agentCwd)).toBe(true);
    fs.rmSync(agentCwd, { recursive: true, force: true });
  });

  test('heartbeat event with payload.content is suppressed — chat-only events spawn', async () => {
    // Regression: a heartbeat with a stray `content` field must NOT trigger
    // a spawn. Only PROMPT_EVENT_TYPES are forwarded to the CLI.
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

  test('same event id delivered twice → spawns once and re-acks the duplicate', async () => {
    const duplicate = makeEvent({ _id: 'evt-duplicate' });
    const mockGet = jest.fn().mockResolvedValue({ events: [duplicate, duplicate] });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'handled once' }));
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

    const ackCalls = mockPost.mock.calls.filter(([route]) => route.endsWith('/ack'));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(ackCalls).toHaveLength(2);
    expect(ackCalls[0][1]).toEqual({ result: { outcome: 'posted' } });
    expect(ackCalls[1][1]).toEqual({
      result: { outcome: 'no_action', reason: 'duplicate-delivery' },
    });
  });

  test('spawn failure is not recorded, so re-delivery spawns again', async () => {
    const event = makeEvent({ _id: 'evt-retry-after-spawn-failure' });
    const mockGet = jest.fn().mockResolvedValue({ events: [event] });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn().mockRejectedValue(new Error('runtime unavailable'));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const first = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    first.stop();

    const second = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    second.stop();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(wasEventHandled('my-stub', event._id)).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('ack failure persists the handled id, so a second run skips spawn and re-acks', async () => {
    const event = makeEvent({ _id: 'evt-persisted-before-ack' });
    const mockGet = jest.fn().mockResolvedValue({ events: [event] });
    let ackAttempts = 0;
    const mockPost = jest.fn(async (route) => {
      if (route.endsWith('/ack')) {
        ackAttempts += 1;
        if (ackAttempts === 1) throw new Error('ack transport offline');
      }
      return {};
    });
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'completed before ack' }));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };
    const errors = [];

    const first = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
      onError: (err) => errors.push(err),
    });
    await drainMicrotasks();
    first.stop();

    const eventsFile = path.join(
      sessionsTmpDir, '.commonly', 'sessions', 'my-stub.events.json',
    );
    expect(JSON.parse(fs.readFileSync(eventsFile, 'utf8'))).toEqual([event._id]);

    const second = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
      onError: (err) => errors.push(err),
    });
    await drainMicrotasks();
    second.stop();

    const ackCalls = mockPost.mock.calls.filter(([route]) => route.endsWith('/ack'));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(ackCalls).toHaveLength(2);
    expect(ackCalls[1][1]).toEqual({
      result: { outcome: 'no_action', reason: 'duplicate-delivery' },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Ack failed.*ack transport offline/);
  });

  test('newSessionId from spawn is persisted and reused on the next turn', async () => {
    // Route-aware mock: /events yields a fresh event each call, /memory
    // returns an empty envelope. `mockResolvedValueOnce` chaining broke once
    // the memory bridge landed because `/memory` began consuming the queue.
    let eventTurn = 0;
    const eventIds = ['turn-1', 'turn-2'];
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      // Self-post detection snapshots pod messages before/after the spawn;
      // answer that route explicitly so it doesn't consume the event queue.
      if (route.endsWith('/messages')) return { messages: [] };
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

  test('3 consecutive 401s from /events stops the loop and surfaces a "run detach" hint', async () => {
    // Bounded multi-cycle scheduler. Uses `setImmediate` to yield to the
    // event loop between ticks (queueMicrotask starves drainMicrotasks).
    // Hard cap of 20 at the scheduler level so a regression that fails to
    // self-stop terminates the test rather than OOMing.
    let scheduledCount = 0;
    const boundedTimeout = (cb) => {
      scheduledCount += 1;
      if (scheduledCount > 20) return 0;
      setImmediate(cb);
      return 0;
    };
    const wait = async () => {
      for (let i = 0; i < 30; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
      }
    };

    const unauthorized = Object.assign(new Error('invalid token'), { status: 401 });
    const mockGet = jest.fn().mockRejectedValue(unauthorized);
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const errors = [];
    const spawn = jest.fn();
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const handle = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'stale-agent',
      setTimeoutImpl: boundedTimeout,
      onError: (err) => errors.push(err),
    });
    await wait();
    handle.stop();

    // Loop stopped at the 3rd consecutive 401. The first two surface as raw
    // onError(401); the third surfaces the "run detach" hint and halts.
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(spawn).not.toHaveBeenCalled();
    const detachHint = errors.find((e) => /detach/.test(e.message));
    expect(detachHint).toBeTruthy();
    expect(detachHint.message).toContain('stale-agent');
    // If this ever exceeds 3, the guard regressed and the scheduler's hard
    // cap is the only thing saving us from OOM.
    expect(scheduledCount).toBeLessThanOrEqual(3);
  });

  test('success after a single 401 resets the consecutive-auth counter', async () => {
    // Scenario: one 401 (e.g. race with token rotation), then 200s forever.
    // The counter must reset so sporadic failures don't accrete toward the
    // exit threshold.
    let scheduledCount = 0;
    const boundedTimeout = (cb) => {
      scheduledCount += 1;
      if (scheduledCount > 5) return 0;
      setImmediate(cb);
      return 0;
    };
    const wait = async () => {
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
      }
    };

    const unauthorized = Object.assign(new Error('rate limited'), { status: 401 });
    let call = 0;
    const mockGet = jest.fn(async () => {
      call += 1;
      if (call === 1) throw unauthorized;
      return { events: [] };
    });
    createClient.mockReturnValue({ get: mockGet, post: jest.fn().mockResolvedValue({}) });

    const errors = [];
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn: jest.fn() };

    const handle = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'flaky-agent',
      setTimeoutImpl: boundedTimeout,
      onError: (err) => errors.push(err),
    });
    await wait();
    handle.stop();

    // Flaky 401 surfaced as onError but loop kept running. No "run detach"
    // message because successful calls 2+ reset the counter.
    expect(errors.some((e) => /detach/.test(e.message))).toBe(false);
    expect(errors.some((e) => e.status === 401)).toBe(true);
    expect(call).toBeGreaterThan(1);
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

  test('runtimeToken + instanceUrl flow into adapter.spawn ctx', async () => {
    // The claude adapter uses these to substitute ${COMMONLY_AGENT_TOKEN}
    // and ${COMMONLY_API_URL} placeholders in MCP env values, so users can
    // keep their checked-in env files free of secrets.
    const events = [makeEvent()];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'ok' }));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const { stop } = performRun({
      instanceUrl: 'https://api-dev.commonly.me',
      token: 'cm_agent_specific_token',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    stop();

    const ctx = spawn.mock.calls[0][1];
    expect(ctx.runtimeToken).toBe('cm_agent_specific_token');
    expect(ctx.instanceUrl).toBe('https://api-dev.commonly.me');
  });
});
