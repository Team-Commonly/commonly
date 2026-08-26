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
// chain is currently:  get(/events) → get(/messages snapshot) → post(claim)
// → get(/memory) → adapter.spawn → get(/messages) → post(/messages) →
// del(claim) → post(/memory/sync) → post(/events/:id/ack)  — 10 await
// boundaries. Loop DRAIN_DEPTH setImmediates so each level resolves. Bump
// this if another phase extends the chain.
const DRAIN_DEPTH = 16;
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

    // The fetch IS the claim — `list()` marks every candidate `delivered`
    // and increments `attempts` before returning, while this loop starts
    // exactly one. Asking for more claims work it cannot begin, and the
    // backend's requeue sweep then reclaims the remainder at `attempts + 1`
    // until the poison cap retires them unread. Pinned as its own assertion
    // because the previous value (10) looked like a harmless batch size.
    expect(mockGet.mock.calls[0][1].limit).toBe(1);
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

  test('a normal-return run-cap refusal is acked as a refusal, not a posted reply', async () => {
    // The post route deliberately responds 200 with { refused: true }. This
    // is terminal guidance — retrying the same event would duplicate the two
    // chunks that did land — so the wrapper must expose it locally and ack the
    // event as no_action rather than throw into at-least-once redelivery.
    const guidance = 'Wait for someone else to speak; do not retry unchanged.';
    let messagePosts = 0;
    const mockGet = jest.fn().mockResolvedValue({ events: [makeEvent({ _id: 'evt-run-cap' })] });
    const mockPost = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/pods/pod-abc/messages') {
        messagePosts += 1;
        return messagePosts < 3
          ? { success: true }
          : {
            success: false,
            refused: true,
            reason: 'consecutive_run_cap',
            consecutive: 3,
            guidance,
          };
      }
      return {};
    });
    createClient.mockReturnValue({ get: mockGet, post: mockPost });
    const onError = jest.fn();
    const text = `${'a'.repeat(390)}\n\n${'b'.repeat(390)}\n\n${'c'.repeat(390)}`;
    const spawn = jest.fn(async () => ({ text }));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      onError,
      setTimeoutImpl: noopTimeout,
    });
    await drainMicrotasks();
    stop();

    expect(mockPost.mock.calls.filter(([route]) => route === '/api/agents/runtime/pods/pod-abc/messages'))
      .toHaveLength(3);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-run-cap/ack',
      {
        result: {
          outcome: 'no_action',
          reason: 'consecutive_run_cap',
          details: {
            mode: 'refused',
            postedMessages: 2,
            attemptedMessages: 3,
            consecutive: 3,
            guidance,
          },
        },
      },
    );
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'agent_delivery_refused',
      reason: 'consecutive_run_cap',
      postedMessages: 2,
      attemptedMessages: 3,
    }));
    expect(onError.mock.calls[0][0].message).toContain(guidance);
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

  test('heartbeat event spawns the CLI but keeps HEARTBEAT_OK out of chat', async () => {
    const events = [makeEvent({
      _id: 'evt-hb',
      type: 'heartbeat',
      payload: { content: 'Run your heartbeat checklist.' },
    })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'HEARTBEAT_OK' }));
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
      'Run your heartbeat checklist.',
      expect.objectContaining({ metadata: { event: events[0] } }),
    );
    expect(mockPost).not.toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      expect.anything(),
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-hb/ack',
      { result: { outcome: 'no_action' } },
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test('heartbeat event posts substantive output before acking', async () => {
    const events = [makeEvent({
      _id: 'evt-hb-update',
      type: 'heartbeat',
      payload: { content: 'Check for a decision that needs a human.' },
    })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'The release owner needs to choose a date.' }));
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
      { content: 'The release owner needs to choose a date.' },
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-hb-update/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('heartbeat control word with substantive output is not silently swallowed', async () => {
    const events = [makeEvent({
      _id: 'evt-hb-prefixed-update',
      type: 'heartbeat',
      payload: { content: 'Check for a decision that needs a human.' },
    })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const content = 'HEARTBEAT_OK — nothing urgent, but the release owner still needs to choose a date';
    const spawn = jest.fn(async () => ({ text: content }));
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
      { content },
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-hb-prefixed-update/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('manual heartbeat without content still runs with a safe fallback prompt', async () => {
    const events = [makeEvent({
      _id: 'evt-hb-manual',
      type: 'heartbeat',
      payload: { trigger: 'admin-manual' },
    })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'HEARTBEAT_NOOP' }));
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

    expect(spawn.mock.calls[0][0]).toContain('Heartbeat tick.');
    expect(mockPost).not.toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      expect.anything(),
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-hb-manual/ack',
      { result: { outcome: 'no_action' } },
    );
  });

  test('agent.ask routes the CLI final answer privately back to the requester', async () => {
    const events = [makeEvent({
      _id: 'evt-ask',
      type: 'agent.ask',
      payload: {
        requestId: 'ask/123',
        fromAgent: 'planner',
        fromInstanceId: 'default',
        question: 'What is the riskiest edge case?',
      },
    })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'An expired request racing the response.' }));
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

    expect(spawn.mock.calls[0][0]).toContain('@planner asks:');
    expect(spawn.mock.calls[0][0]).toContain('What is the riskiest edge case?');
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/asks/ask%2F123/respond',
      { content: 'An expired request racing the response.' },
    );
    expect(mockPost).not.toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      expect.anything(),
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-ask/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('agent.ask re-acks when the agent already responded through its MCP tool', async () => {
    const events = [makeEvent({
      _id: 'evt-ask-already-responded',
      type: 'agent.ask',
      payload: {
        requestId: 'ask-responded',
        fromAgent: 'planner',
        question: 'Ready?',
      },
    })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn(async (route) => {
      if (route.endsWith('/asks/ask-responded/respond')) {
        const err = new Error('ask has already been responded to');
        err.status = 409;
        err.body = { code: 'already_responded' };
        throw err;
      }
      return {};
    });
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'Yes.' }));
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
      '/api/agents/runtime/events/evt-ask-already-responded/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('agent.ask.response reaches the requester without forcing pod chat noise', async () => {
    const events = [makeEvent({
      _id: 'evt-ask-response',
      type: 'agent.ask.response',
      payload: {
        requestId: 'ask-123',
        fromAgent: 'reviewer',
        fromInstanceId: 'opus',
        question: 'What is the riskiest edge case?',
        response: 'An expired request racing the response.',
      },
    })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn(async () => ({ text: 'NO_REPLY' }));
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

    expect(spawn.mock.calls[0][0]).toContain('@reviewer:opus answered:');
    expect(spawn.mock.calls[0][0]).toContain('An expired request racing the response.');
    expect(mockPost).not.toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      expect.anything(),
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-ask-response/ack',
      { result: { outcome: 'no_action' } },
    );
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
      { result: { outcome: 'no_action', reason: 'no-prompt' } },
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
    const logs = [];

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
      log: (line) => logs.push(line),
      onError: (err) => errors.push(err),
    });
    await drainMicrotasks();
    stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/claude process died/);

    // #993 fallout: this failure used to be emitted through BOTH sinks with
    // identical text, into one file under `nohup … > log 2>&1`. Counting hits
    // per event id then returned 2, which reads as two deliveries and made the
    // requeue cap look like the cause. One emission per failure, always.
    expect(logs.filter((l) => /claude process died/.test(l))).toHaveLength(0);
  });

  test('a caller with no onError still sees the spawn failure, in the log', async () => {
    // The other half of the contract. Collapsing the double emission must not
    // silence the failure for an embedder that passes no error channel — that
    // would trade a counting artifact for a swallowed wake, which is the #896
    // ambiguity the surrounding code exists to prevent.
    const events = [makeEvent({ _id: 'evt-no-onerror' })];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn().mockRejectedValue(new Error('claude process died'));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };
    const logs = [];

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      setTimeoutImpl: noopTimeout,
      log: (line) => logs.push(line),
      // deliberately no onError
    });
    await drainMicrotasks();
    stop();

    expect(logs.filter((l) => /claude process died/.test(l))).toHaveLength(1);

    // CRITICAL: no message post, no ack — kernel MUST re-deliver.
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('first processing failure stops the fetched batch before another model launch', async () => {
    const events = [
      makeEvent({ _id: 'evt-fail-first' }),
      makeEvent({ _id: 'evt-must-wait' }),
    ];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn().mockRejectedValue(new Error('provider unavailable'));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };
    const scheduled = [];

    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      retryJitterRatio: 0,
      setTimeoutImpl: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return 0;
      },
    });
    await drainMicrotasks();
    stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(mockPost).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(5000);
  });

  test('unknown repeated failures open the circuit on the third probe', async () => {
    const event = makeEvent({ _id: 'evt-circuit' });
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') return { events: [event] };
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages: [] };
      return {};
    });
    createClient.mockReturnValue({ get: mockGet, post: jest.fn().mockResolvedValue({}) });

    const spawn = jest.fn().mockRejectedValue(new Error('claude exited with code 1:'));
    const adapter = { name: 'stub', detect: stubAdapter.detect, spawn };
    const scheduled = [];
    const errors = [];
    const handle = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'my-stub',
      retryJitterRatio: 0,
      setTimeoutImpl: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return 0;
      },
      onError: (error) => errors.push(error),
    });

    await drainMicrotasks();
    expect(scheduled[0].delayMs).toBe(5000);
    scheduled.shift().callback();
    await drainMicrotasks();
    expect(scheduled[0].delayMs).toBe(10000);
    scheduled.shift().callback();
    await drainMicrotasks();

    handle.stop();
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(scheduled[0].delayMs).toBe(60000);
    expect(errors[2]).toMatchObject({
      code: 'agent_spawn_retry_scheduled',
      failureClass: 'runtime',
      consecutiveFailures: 3,
      retryAfterMs: 60000,
      circuitOpen: true,
      eventId: event._id,
    });
    expect(errors[2].message).toMatch(/circuit open, next probe in 1m/);
  });

  test('recognized quota failure opens the long circuit on the first attempt', async () => {
    const event = makeEvent({ _id: 'evt-quota' });
    const mockGet = jest.fn().mockResolvedValue({ events: [event] });
    createClient.mockReturnValue({ get: mockGet, post: jest.fn().mockResolvedValue({}) });

    const spawn = jest.fn().mockRejectedValue(new Error('insufficient_quota: billing limit'));
    const scheduled = [];
    const errors = [];
    const handle = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
      agentName: 'my-stub',
      retryJitterRatio: 0,
      setTimeoutImpl: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return 0;
      },
      onError: (error) => errors.push(error),
    });
    await drainMicrotasks();
    handle.stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(scheduled[0].delayMs).toBe(15 * 60 * 1000);
    expect(errors[0]).toMatchObject({ failureClass: 'quota', circuitOpen: true });
  });

  test('a no-op event does not erase the model failure streak', async () => {
    let poll = 0;
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') {
        poll += 1;
        if (poll === 1) return { events: [makeEvent({ _id: 'evt-streak-1' })] };
        return {
          events: [
            makeEvent({ _id: 'evt-no-prompt', payload: {} }),
            makeEvent({ _id: 'evt-streak-2' }),
          ],
        };
      }
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages: [] };
      return {};
    });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const spawn = jest.fn().mockRejectedValue(new Error('runtime unavailable'));
    const scheduled = [];
    const handle = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
      agentName: 'my-stub',
      retryJitterRatio: 0,
      setTimeoutImpl: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return 0;
      },
    });

    await drainMicrotasks();
    expect(scheduled[0].delayMs).toBe(5000);
    scheduled.shift().callback();
    await drainMicrotasks();
    handle.stop();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(scheduled[0].delayMs).toBe(10000);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-no-prompt/ack',
      { result: { outcome: 'no_action', reason: 'no-prompt' } },
    );
  });

  test('successful processing resets the failure streak', async () => {
    let poll = 0;
    const mockGet = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') {
        poll += 1;
        return { events: [makeEvent({ _id: `evt-reset-${poll}` })] };
      }
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages: [] };
      return {};
    });
    createClient.mockReturnValue({ get: mockGet, post: jest.fn().mockResolvedValue({}) });

    const spawn = jest.fn()
      .mockRejectedValueOnce(new Error('runtime unavailable'))
      .mockRejectedValueOnce(new Error('runtime unavailable'))
      .mockResolvedValueOnce({ text: 'recovered' })
      .mockRejectedValueOnce(new Error('runtime unavailable'));
    const scheduled = [];
    const handle = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
      agentName: 'my-stub',
      retryJitterRatio: 0,
      setTimeoutImpl: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return 0;
      },
    });

    await drainMicrotasks();
    const runNext = async (expectedDelayMs) => {
      const next = scheduled.shift();
      expect(next.delayMs).toBe(expectedDelayMs);
      next.callback();
      await drainMicrotasks();
    };
    await runNext(5000); // first failure → second probe
    await runNext(10000); // second failure → recovery probe
    await runNext(5000); // success → normal poll interval

    handle.stop();
    expect(spawn).toHaveBeenCalledTimes(4);
    // The post-recovery failure is a fresh streak, so it gets the first retry
    // delay rather than continuing at the one-minute circuit delay.
    expect(scheduled[0].delayMs).toBe(5000);
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

// ── ADR-018 wrapper enforcement (claim-before-act, cascade cap, length gate) ─
//
// The 2026-08-11 pilot showed advisory guidance does not bind: zero claims
// taken, 3,614-char median, a mention cascade killed by hand. These tests pin
// the deterministic wrapper behavior that replaced it.
describe('performRun — ADR-018 enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  const CLAIM_PATH = '/api/agents/runtime/messages/msg-1/claim';

  const makeClaimEvent = (overrides = {}) => makeEvent({
    payload: { content: 'please look at this', messageId: 'msg-1' },
    ...overrides,
  });

  // Route-aware client mock: events/messages/memory GETs, claim-aware POSTs.
  const makeClient = ({
    events,
    messages = [{ _id: 'msg-1', isBot: false, self: false }],
    claimResult = { claimed: true, expiresAt: 'later' },
  }) => {
    const post = jest.fn(async (route) => {
      if (route.endsWith('/claim')) {
        if (claimResult instanceof Error) throw claimResult;
        return typeof claimResult === 'function' ? claimResult() : claimResult;
      }
      return {};
    });
    const del = jest.fn(async () => ({ released: true }));
    const get = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages };
      return { events };
    });
    createClient.mockReturnValue({ get, post, del });
    return { get, post, del };
  };

  const run = (adapter, opts = {}) => performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter,
    agentName: 'my-stub',
    setTimeoutImpl: noopTimeout,
    ...opts,
  });

  test('claims the trigger message before spawning, then releases after posting', async () => {
    const { post, del } = makeClient({ events: [makeClaimEvent()] });
    const spawn = jest.fn(async () => {
      // The claim must already be held when the CLI turn starts.
      expect(post.mock.calls.filter(([r]) => r.endsWith('/claim'))).toHaveLength(1);
      return { text: 'on it' };
    });
    const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn });
    await drainMicrotasks();
    stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(CLAIM_PATH, { podId: 'pod-abc', leaseSeconds: 90 });
    expect(post).toHaveBeenCalledWith('/api/agents/runtime/pods/pod-abc/messages', { content: 'on it' });
    expect(del).toHaveBeenCalledWith(CLAIM_PATH);
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-1/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('a lost claim on a BROADCAST wake stands the turn down: no spawn, no post, acked no_action', async () => {
    // Was a chat.mention event before the fairness ruling (Sam, 2026-08-12:
    // "loser may never get a chance to speak") — addressed losses now proceed
    // peer-aware (own test below); the hard stand-down contract continues to
    // hold for broadcast wakes, asserted here.
    const { post, del } = makeClient({
      events: [makeClaimEvent({ type: 'message.posted' })],
      claimResult: { claimed: false, claimedBy: 'nova', expiresAt: 'later' },
    });
    const spawn = jest.fn();
    const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn });
    await drainMicrotasks();
    stop();

    expect(spawn).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      expect.anything(),
    );
    expect(del).not.toHaveBeenCalled(); // nothing held, nothing to release
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-1/ack',
      { result: { outcome: 'no_action', reason: 'claim-held' } },
    );
  });

  test('a claim-route failure fails OPEN: the turn proceeds unguarded (#887 rule)', async () => {
    const { post } = makeClient({
      events: [makeClaimEvent()],
      claimResult: Object.assign(new Error('Not found'), { status: 404 }),
    });
    const spawn = jest.fn(async () => ({ text: 'still answering' }));
    const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn });
    await drainMicrotasks();
    stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      { content: 'still answering' },
    );
  });

  test('a claim lost mid-turn suppresses the wrapper post (stand down at post time)', async () => {
    let claimCalls = 0;
    const { post, del } = makeClient({
      events: [makeClaimEvent()],
      claimResult: () => {
        claimCalls += 1;
        return claimCalls === 1
          ? { claimed: true, expiresAt: 'later' } // acquire
          : { claimed: false, claimedBy: 'nova' }; // renewal — a peer re-won
      },
    });
    let renew = null;
    const spawn = jest.fn(async () => {
      await renew(); // the lease lapses while the CLI is still running
      return { text: 'a reply the pod must not see twice' };
    });
    const { stop } = run(
      { name: 'stub', detect: stubAdapter.detect, spawn },
      { setIntervalImpl: (fn) => { renew = fn; return 7; }, clearIntervalImpl: () => {} },
    );
    await drainMicrotasks();
    stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      expect.anything(),
    );
    expect(del).not.toHaveBeenCalled(); // lost claims are not released
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-1/ack',
      { result: { outcome: 'no_action' } },
    );
  });

  test('events without a messageId are never claimed', async () => {
    const { post } = makeClient({ events: [makeEvent({ type: 'heartbeat', payload: {} })] });
    const spawn = jest.fn(async () => ({ text: 'HEARTBEAT_OK' }));
    const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn });
    await drainMicrotasks();
    stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.some(([r]) => r.endsWith('/claim'))).toBe(false);
  });

  test('cascade cap: agent-DM chat.mentions beyond the cap are declined without a spawn or a claim', async () => {
    const { post } = makeClient({
      events: [
        makeClaimEvent({ _id: 'evt-a', payload: { content: 'hello', messageId: 'msg-1', dmKind: 'agent-agent' } }),
        makeClaimEvent({ _id: 'evt-b', payload: { content: 'again', messageId: 'msg-2', dmKind: 'agent-agent' } }),
      ],
      // Both are agent-DM events, which use chat.mention but carry dmKind.
      messages: [
        { _id: 'msg-1', isBot: true, self: false },
        { _id: 'msg-2', isBot: true, self: false },
      ],
    });
    const spawn = jest.fn(async () => ({ text: 'NO_REPLY' }));
    // DM-backed chat.mentions stay locally bounded when grace is disabled.
    const { stop } = run(
      { name: 'stub', detect: stubAdapter.detect, spawn },
      { cascadeCap: 1, cascadeAddressedGrace: 0 },
    );
    await drainMicrotasks();
    stop();

    // First agent-triggered turn runs; the second hits the cap.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-b/ack',
      {
        result: {
          outcome: 'no_action',
          reason: 'cascade-cap',
          details: {
            messageId: 'msg-2',
            streak: 1,
            cap: 1,
            addressedGrace: 0,
            resetMs: 600000,
            addressed: true,
            graceApplied: false,
          },
        },
      },
    );
    // The declined event never reached the claim step.
    expect(post.mock.calls.filter(([r]) => r.endsWith('/claim'))).toHaveLength(1);
  });

  test('cascade cap: the env vars reach the governor, not just the run() params', async () => {
    // Pins the DELIVERY, not the constant. Extracting the literals into a
    // resolver is worth nothing if the run loop keeps its own copy — and a
    // resolver-only unit test cannot tell the difference. Same scenario as the
    // test above, with the two values arriving from the environment instead.
    const prior = {
      cap: process.env.COMMONLY_CASCADE_CAP,
      grace: process.env.COMMONLY_CASCADE_ADDRESSED_GRACE,
    };
    process.env.COMMONLY_CASCADE_CAP = '1';
    process.env.COMMONLY_CASCADE_ADDRESSED_GRACE = '0';
    try {
      const { post } = makeClient({
        events: [
          makeClaimEvent({ _id: 'evt-a', type: 'dm.message' }),
          makeClaimEvent({ _id: 'evt-b', type: 'dm.message', payload: { content: 'again', messageId: 'msg-2' } }),
        ],
        messages: [
          { _id: 'msg-1', isBot: true, self: false },
          { _id: 'msg-2', isBot: true, self: false },
        ],
      });
      const spawn = jest.fn(async () => ({ text: 'NO_REPLY' }));
      const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn });
      await drainMicrotasks();
      stop();

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(
        '/api/agents/runtime/events/evt-b/ack',
        {
          result: {
            outcome: 'no_action',
            reason: 'cascade-cap',
            details: {
              messageId: 'msg-2',
              streak: 1,
              cap: 1,
              addressedGrace: 0,
              resetMs: 600000,
              addressed: true,
              graceApplied: false,
            },
          },
        },
      );
    } finally {
      if (prior.cap === undefined) delete process.env.COMMONLY_CASCADE_CAP;
      else process.env.COMMONLY_CASCADE_CAP = prior.cap;
      if (prior.grace === undefined) delete process.env.COMMONLY_CASCADE_ADDRESSED_GRACE;
      else process.env.COMMONLY_CASCADE_ADDRESSED_GRACE = prior.grace;
    }
  });

  test('cascade cap: a legacy direct-address event gets a bounded grace, then is capped too', async () => {
    // Mention types are producer-dampened and exempted separately. Legacy
    // direct-address vocabulary remains on the local bounded-grace path.
    const { post } = makeClient({
      events: [
        makeClaimEvent({ _id: 'evt-a', type: 'dm.message' }),
        makeClaimEvent({ _id: 'evt-b', type: 'dm.message', payload: { content: 'again', messageId: 'msg-2' } }),
        makeClaimEvent({ _id: 'evt-c', type: 'dm.message', payload: { content: 'and again', messageId: 'msg-3' } }),
      ],
      messages: [
        { _id: 'msg-1', isBot: true, self: false },
        { _id: 'msg-2', isBot: true, self: false },
        { _id: 'msg-3', isBot: true, self: false },
      ],
    });
    const spawn = jest.fn(async () => ({ text: 'NO_REPLY' }));
    const { stop } = run(
      { name: 'stub', detect: stubAdapter.detect, spawn },
      { cascadeCap: 1, cascadeAddressedGrace: 1 },
    );
    await drainMicrotasks();
    stop();

    // cap 1 + grace 1 = two addressed turns admitted, the third declined.
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-c/ack',
      {
        result: {
          outcome: 'no_action',
          reason: 'cascade-cap',
          details: {
            messageId: 'msg-3',
            streak: 2,
            cap: 1,
            addressedGrace: 1,
            resetMs: 600000,
            addressed: true,
            graceApplied: true,
          },
        },
      },
    );
  });

  test('cascade: a kernel-dampened mention bypasses the cap but still spends broadcast liveness', async () => {
    const { post } = makeClient({
      events: [
        // First broadcast fills the local cap without entering a claim race.
        makeEvent({
          _id: 'evt-broadcast-before',
          type: 'message.posted',
          payload: { content: 'ambient work', dmKind: 'agent-agent' },
        }),
        // The named bot-to-bot mention remains live even though the cap is
        // full. Its completed turn must still record before the next wake.
        makeClaimEvent({
          _id: 'evt-mentioned',
          payload: { content: '@my-stub please weigh in', messageId: 'msg-mentioned' },
        }),
        makeEvent({
          _id: 'evt-broadcast-after',
          type: 'message.posted',
          payload: { content: 'ambient work again', dmKind: 'agent-agent' },
        }),
      ],
      messages: [{ _id: 'msg-mentioned', isBot: true, self: false }],
    });
    const spawn = jest.fn(async () => ({ text: 'NO_REPLY' }));
    const { stop } = run(
      { name: 'stub', detect: stubAdapter.detect, spawn },
      { cascadeCap: 1, cascadeAddressedGrace: 0 },
    );
    await drainMicrotasks();
    stop();

    // The mention is the second spawn. Before the exemption it was refused at
    // the cap; without the completion-time record the final broadcast would
    // instead be admitted.
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-broadcast-after/ack',
      expect.objectContaining({
        result: expect.objectContaining({ outcome: 'no_action', reason: 'cascade-cap' }),
      }),
    );
  });

  test('losing a claim on a HUMAN message still resets the cascade streak', async () => {
    // Regression for the starvation bug: `record()` lives at the end of
    // runTurn, and the claim stand-down returns before runTurn — so the seat
    // that lost the race never recorded the human turn that clears its
    // streak, and stayed capped through every following broadcast.
    //
    // dmKind drives classifyTrigger directly, so the trigger of each event is
    // unambiguous without depending on the message snapshot.
    const agentEvt = (id) => makeEvent({
      _id: id,
      type: 'message.posted',
      payload: { content: 'peer chatter', dmKind: 'agent-agent' },
    });

    const { post } = makeClient({
      events: [
        // 1. agent-triggered, no messageId so no claim is attempted → streak 1
        agentEvt('evt-a'),
        // 2. HUMAN-triggered and claimable, but the claim is lost → stand down.
        //    This is the turn whose reset used to be dropped on the floor.
        makeEvent({
          _id: 'evt-b',
          type: 'message.posted',
          payload: { content: 'a human speaks', messageId: 'msg-1', dmKind: 'user-agent' },
        }),
        // 3. agent-triggered again — admitted only if evt-b cleared the streak
        agentEvt('evt-c'),
      ],
      claimResult: { claimed: false, holder: 'peer-seat' },
    });

    const spawn = jest.fn(async () => ({ text: 'NO_REPLY' }));
    const { stop } = run(
      { name: 'stub', detect: stubAdapter.detect, spawn },
      { cascadeCap: 1, cascadeAddressedGrace: 0 },
    );
    await drainMicrotasks();
    stop();

    // Two agent turns run: the first builds the streak, the third is admitted
    // because the lost-claim human turn in between reset it. Before the fix
    // the third was refused and this was 1.
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-c/ack',
      { result: { outcome: 'no_action', reason: 'cascade-cap' } },
    );
  });

  test('cascade: a grace=0 seat is not told a grace was spent', async () => {
    // Pins the DELIVERY of the fix, not just the governor field: the log line
    // and the governor are in different files and only the log is read by a
    // human trying to explain a silent seat.
    const { post } = makeClient({
      events: [
        makeClaimEvent({ _id: 'evt-a', type: 'dm.message' }),
        makeClaimEvent({ _id: 'evt-b', type: 'dm.message', payload: { content: 'again', messageId: 'msg-2' } }),
      ],
      messages: [
        { _id: 'msg-1', isBot: true, self: false },
        { _id: 'msg-2', isBot: true, self: false },
      ],
    });
    const log = jest.fn();
    const spawn = jest.fn(async () => ({ text: 'NO_REPLY' }));
    const { stop } = run(
      { name: 'stub', detect: stubAdapter.detect, spawn },
      { log, cascadeCap: 1, cascadeAddressedGrace: 0 },
    );
    await drainMicrotasks();
    stop();

    // The refusal happened — without this the assertion below passes vacuously
    // on a run where nothing was ever capped.
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-b/ack',
      {
        result: {
          outcome: 'no_action',
          reason: 'cascade-cap',
          details: {
            messageId: 'msg-2',
            streak: 1,
            cap: 1,
            addressedGrace: 0,
            resetMs: 600000,
            addressed: true,
            graceApplied: false,
          },
        },
      },
    );
    const refusal = log.mock.calls.map(([l]) => l).find((l) => l.includes('cascade cap:'));
    expect(refusal).toBeDefined();
    expect(refusal).not.toContain('addressed grace');
  });

  test('cascade: the resolved triple is logged at boot, marked as defaults', async () => {
    // Without this line the log of a retuned seat is byte-identical to the log
    // of a default one — and an env var, unlike the source edit it replaces,
    // leaves no git evidence of which seat diverged. The other cascade log on
    // this path is the warn callback, which fires only on a BAD value, so a
    // cleanly-booted seat had no record of what it resolved at all.
    makeClient({ events: [] });
    const log = jest.fn();
    const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn: jest.fn() }, { log });
    await drainMicrotasks();
    stop();

    const line = log.mock.calls.map(([l]) => l).find((l) => l.startsWith('cascade:'));
    expect(line).toBe('cascade: cap=3 grace=2 reset=600000ms (defaults)');
  });

  test('cascade: a retuned seat says so, and the marker is what distinguishes it', async () => {
    const prior = process.env.COMMONLY_CASCADE_CAP;
    process.env.COMMONLY_CASCADE_CAP = '8';
    try {
      makeClient({ events: [] });
      const log = jest.fn();
      const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn: jest.fn() }, { log });
      await drainMicrotasks();
      stop();

      const line = log.mock.calls.map(([l]) => l).find((l) => l.startsWith('cascade:'));
      expect(line).toContain('cap=8');
      // Asserted separately from the value: a marker that never appears would
      // pass a value-only assertion while making every seat look retuned.
      expect(line).not.toContain('(defaults)');
    } finally {
      if (prior === undefined) delete process.env.COMMONLY_CASCADE_CAP;
      else process.env.COMMONLY_CASCADE_CAP = prior;
    }
  });

  test('cascade: a bad flag value is quoted back as typed, and the seat keeps the default', async () => {
    // The flag path used to coerce with Number() before the resolver saw it,
    // so `--cascade-cap abc` warned `--cascade-cap='NaN'` — naming a value the
    // operator never typed, on the one line whose job is to name their typo.
    // Raw strings arrive here now, which is why this passes one in.
    makeClient({ events: [] });
    const log = jest.fn();
    const { stop } = run(
      { name: 'stub', detect: stubAdapter.detect, spawn: jest.fn() },
      { log, cascadeCap: 'abc' },
    );
    await drainMicrotasks();
    stop();

    const lines = log.mock.calls.map(([l]) => l);
    const warning = lines.find((l) => l.startsWith('cascade config:'));
    expect(warning).toContain("'abc'");
    expect(warning).not.toContain('NaN');
    expect(lines.find((l) => l.startsWith('cascade:'))).toContain('cap=3');
  });

  test('human-triggered turns are never cascade-capped', async () => {
    const { post } = makeClient({
      events: [
        makeClaimEvent({ _id: 'evt-a' }),
        makeClaimEvent({ _id: 'evt-b', payload: { content: 'again', messageId: 'msg-2' } }),
      ],
      messages: [
        { _id: 'msg-1', isBot: true, self: false },
        { _id: 'msg-2', isBot: false, self: false }, // a human spoke
      ],
    });
    const spawn = jest.fn(async () => ({ text: 'NO_REPLY' }));
    const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn }, { cascadeCap: 1 });
    await drainMicrotasks();
    stop();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-b/ack',
      { result: { outcome: 'no_action' } },
    );
  });

  test('an enforcement stand-down does not reset the spawn-failure streak (#782 invariant)', async () => {
    // Failure → stand-down (claim held) → failure. The stand-down never
    // exercised the model, so the second failure must report streak 2, not 1.
    let scheduled = 0;
    const boundedTimeout = (cb) => {
      scheduled += 1;
      if (scheduled > 6) return 0;
      setImmediate(cb);
      return 0;
    };
    const wait = async () => {
      for (let i = 0; i < 60; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
      }
    };

    const batches = [
      [makeEvent({ _id: 'evt-fail-1' })],
      // Broadcast wake, post-fairness: addressed claim-losses now spawn
      // peer-aware, so the stand-down under test must ride message.posted.
      [makeClaimEvent({ _id: 'evt-held', type: 'message.posted' })],
      [makeEvent({ _id: 'evt-fail-2' })],
      [],
    ];
    let batch = 0;
    const post = jest.fn(async (route) => {
      if (route.endsWith('/claim')) return { claimed: false, claimedBy: 'nova' };
      return {};
    });
    const get = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/memory') return { sections: {} };
      if (route.endsWith('/messages')) return { messages: [{ _id: 'msg-1', isBot: false, self: false }] };
      const events = batches[Math.min(batch, batches.length - 1)];
      batch += 1;
      return { events };
    });
    createClient.mockReturnValue({ get, post, del: jest.fn() });

    const errors = [];
    const spawn = jest.fn(async () => { throw new Error('model down'); });
    const { stop } = run(
      { name: 'stub', detect: stubAdapter.detect, spawn },
      { setTimeoutImpl: boundedTimeout, onError: (e) => errors.push(e) },
    );
    await wait();
    stop();

    const streaks = errors
      .filter((e) => e.code === 'agent_spawn_retry_scheduled')
      .map((e) => e.consecutiveFailures);
    expect(streaks).toEqual([1, 2]);
  });

  test('fairness: a claim LOSS on a direct mention proceeds peer-aware instead of standing down', async () => {
    const { post, del } = makeClient({
      events: [makeClaimEvent()], // chat.mention — the seat was addressed
      claimResult: { claimed: false, claimedBy: 'nova' },
    });
    const spawn = jest.fn(async () => ({ text: 'a materially different take' }));
    const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn });
    await drainMicrotasks();
    stop();

    // The addressed seat still spoke — peer-aware, not silenced.
    expect(spawn).toHaveBeenCalledTimes(1);
    const prompt = spawn.mock.calls[0][0];
    expect(prompt).toContain('@nova');
    expect(prompt).toContain('materially different');
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      { content: 'a materially different take' },
    );
    expect(del).not.toHaveBeenCalled(); // nothing was held
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-1/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('fairness: a claim LOSS on a broadcast wake still stands down hard', async () => {
    const { post } = makeClient({
      events: [makeClaimEvent({ type: 'message.posted' })],
      claimResult: { claimed: false, claimedBy: 'nova' },
    });
    const spawn = jest.fn();
    const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn });
    await drainMicrotasks();
    stop();

    expect(spawn).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-1/ack',
      { result: { outcome: 'no_action', reason: 'claim-held' } },
    );
  });

  test('reply evidence: a broadcast wake that replies to THIS seat proceeds peer-aware past a lost claim', async () => {
    // Interim for TASK-058: the backend stamps repliesToYourMessage when the
    // woken message replies to (or threads on) a message this seat authored.
    // Without honoring it, a peer's claim on its own reply ordered the
    // replied-to author out of its own conversation (Sage stood down twice
    // on Anvil's thread replies, 2026-08-24). Deliberately NOT a widening of
    // ADDRESSED_EVENT_TYPES — the flag is per-event evidence.
    const { post, del } = makeClient({
      events: [makeClaimEvent({
        type: 'message.posted',
        payload: {
          content: 'a follow-up on your point', messageId: 'msg-1', repliesToYourMessage: true,
        },
      })],
      claimResult: { claimed: false, claimedBy: 'anvil' },
    });
    const spawn = jest.fn(async () => ({ text: 'glad you picked that up — one addition' }));
    const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn });
    await drainMicrotasks();
    stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled(); // nothing was held
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-abc/messages',
      { content: 'glad you picked that up — one addition' },
    );
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-1/ack',
      { result: { outcome: 'posted' } },
    );
  });

  test('fairness: winning a broadcast race handicaps the NEXT race in that pod', async () => {
    const sleeps = [];
    const { post } = makeClient({
      events: [
        makeClaimEvent({ _id: 'evt-w1', type: 'message.posted' }),
        makeClaimEvent({ _id: 'evt-w2', type: 'message.posted', payload: { content: 'again', messageId: 'msg-2' } }),
      ],
    });
    const spawn = jest.fn(async () => ({ text: 'NO_REPLY' }));
    const { stop } = run(
      { name: 'stub', detect: stubAdapter.detect, spawn },
      { sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve(); } },
    );
    await drainMicrotasks();
    stop();

    // First race: no handicap. Second race, same pod, after a win: yielded.
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(3000);
    expect(post.mock.calls.filter(([r]) => r.endsWith('/claim'))).toHaveLength(2);
  });

  test('#896: a content-less event WITH a messageId spawns a recovery turn instead of a silent ack', async () => {
    const { post } = makeClient({
      events: [makeEvent({ _id: 'evt-bare', payload: { messageId: 'msg-1' } })],
    });
    const spawn = jest.fn(async () => ({ text: 'NO_REPLY' }));
    const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn });
    await drainMicrotasks();
    stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    const prompt = spawn.mock.calls[0][0];
    expect(prompt).toContain('Recovered wake');
    expect(prompt).toContain('msg-1');
    expect(prompt).toContain('NO_REPLY');
    // It flows through the normal enforcement path — the claim was taken.
    expect(post).toHaveBeenCalledWith(CLAIM_PATH, expect.anything());
  });

  test('#896: a truly-empty event is still acked but the skip is surfaced through onError', async () => {
    const errors = [];
    const { post } = makeClient({
      events: [makeEvent({ _id: 'evt-empty', payload: {} })],
    });
    const spawn = jest.fn();
    const { stop } = run(
      { name: 'stub', detect: stubAdapter.detect, spawn },
      { onError: (e) => errors.push(e) },
    );
    await drainMicrotasks();
    stop();

    expect(spawn).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-empty/ack',
      { result: { outcome: 'no_action', reason: 'no-prompt' } },
    );
    const skip = errors.find((e) => e.code === 'agent_event_skipped_no_prompt');
    expect(skip).toBeTruthy();
    expect(skip.message).toContain('evt-empty');
  });

  test('length gate: an over-limit reply is split into ordered messages at post time', async () => {
    const chunkA = `alpha ${'a'.repeat(380)}`;
    const chunkB = `beta ${'b'.repeat(380)}`;
    const { post } = makeClient({ events: [makeEvent()] }); // no messageId — gate is claim-independent
    const spawn = jest.fn(async () => ({ text: `${chunkA}\n\n${chunkB}` }));
    const { stop } = run({ name: 'stub', detect: stubAdapter.detect, spawn });
    await drainMicrotasks();
    stop();

    const posts = post.mock.calls.filter(([r]) => r === '/api/agents/runtime/pods/pod-abc/messages');
    expect(posts).toHaveLength(2);
    expect(posts[0][1].content).toBe(chunkA);
    expect(posts[1][1].content).toBe(chunkB);
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/events/evt-1/ack',
      { result: { outcome: 'posted' } },
    );
  });
});
