/**
 * A model provider that refuses a request's CONTENT (2026-10-16).
 *
 * A codex security-gate seat was refused on every turn of one PR's request
 * ("flagged for possible cybersecurity risk"). The run loop classed that as a
 * transient runtime failure, so it never acked and kept re-sending the same
 * content, and the seat handled nothing else until the kernel's requeue cap
 * retired the event. These arms pin the replacement:
 *   - a refused item is acked once, as refused, and never re-sent;
 *   - an ordinary item that arrived in the same batch is still handled, or left
 *     unacked for redelivery, never swallowed with the refused one;
 *   - the pod is told, by the wrapper, with identifiers only.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-refusal-test-'));

await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => sessionsTmpDir },
  homedir: () => sessionsTmpDir,
}));

await jest.unstable_mockModule('../src/lib/api.js', () => ({
  createClient: jest.fn(),
  login: jest.fn(),
}));

await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

const DRAIN_DEPTH = 40;
const drainMicrotasks = async () => {
  for (let i = 0; i < DRAIN_DEPTH; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

afterAll(() => fs.rmSync(sessionsTmpDir, { recursive: true, force: true }));

const POD_ID = '6a8f6dc7a1dccf2e02f31015';
const HEAD = '2024f74cbed052cecc3a10e426e8b8460ce3be39';
// The part a provider flags. None of it may reach the pod notice.
const FLAGGED = 'GET http://169.254.169.254/latest/meta-data then a ReDoS string aaaaaaaaaaaaaaaa!';

const refusal = () => new Error(
  'codex turn failed: This content was flagged for possible cybersecurity risk. '
  + 'If this seems wrong, try rephrasing your request.',
);

const poisonEvent = (over = {}) => ({
  _id: 'evt-poison',
  type: 'chat.mention',
  podId: POD_ID,
  agentName: 'rhea',
  instanceId: 'default',
  payload: {
    content: `[Pod context: this conversation is in pod \`${POD_ID}\`.]\n@rhea security gate: **#2249** at \`${HEAD}\`. ${FLAGGED}`,
    messageId: '78195',
    username: 'lily-shen',
  },
  ...over,
});

const normalEvent = (over = {}) => ({
  _id: 'evt-normal',
  type: 'chat.mention',
  podId: POD_ID,
  agentName: 'rhea',
  instanceId: 'default',
  payload: { content: '@rhea docs gate: #2250, wording only', messageId: '78196', username: 'growth-ops' },
  ...over,
});

const setup = ({ events, spawn, refusalHandoff = 'vera' }) => {
  let polls = 0;
  const mockGet = jest.fn(async (route) => {
    if (route === '/api/agents/runtime/events') {
      polls += 1;
      return { events: polls === 1 ? events : [] };
    }
    if (route === '/api/agents/runtime/memory') return { sections: {} };
    if (route.endsWith('/messages')) return { messages: [] };
    return {};
  });
  // Every claim is won, so each item is this seat's to act on.
  const mockPost = jest.fn(async (route) => (
    String(route).endsWith('/claim') ? { claimed: true, expiresAt: 'later' } : {}
  ));
  const mockDel = jest.fn().mockResolvedValue({});
  createClient.mockReturnValue({ get: mockGet, post: mockPost, del: mockDel });
  const scheduled = [];
  const errors = [];
  const handle = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
    agentName: 'rhea',
    retryJitterRatio: 0,
    refusalHandoff,
    claimYieldDelayMs: 0,
    sleepImpl: async () => {},
    onError: (err) => errors.push(err),
    setTimeoutImpl: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return 0;
    },
  });
  const acks = () => mockPost.mock.calls
    .filter(([route]) => String(route).endsWith('/ack'))
    .map(([route, body]) => ({ id: String(route).split('/').at(-2), result: body.result }));
  const posts = () => mockPost.mock.calls
    .filter(([route]) => String(route).endsWith(`/pods/${POD_ID}/messages`))
    .map(([, body]) => body.content);
  const notices = () => posts().filter((content) => content.includes('refused the content'));
  const releases = () => mockDel.mock.calls
    .filter(([route]) => String(route).endsWith('/claim'))
    .map(([route, body]) => ({ messageId: String(route).split('/').at(-2), body }));
  return {
    handle, mockGet, mockPost, scheduled, errors, acks, posts, notices, releases,
  };
};

const REFUSED_ACK = (handoff, noticePosted = true) => ({
  outcome: 'error',
  reason: 'provider-refused',
  details: { failureClass: 'content_refused', handoff, noticePosted },
});

describe('a provider content refusal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('is acked once as refused, never re-sent, and the next poll comes at the normal interval', async () => {
    const spawn = jest.fn(async () => { throw refusal(); });
    const run = setup({ events: [poisonEvent()], spawn });
    await drainMicrotasks();
    // The next poll is the ordinary interval, not a backoff, and finds nothing.
    expect(run.scheduled[0].delayMs).toBe(5000);
    run.scheduled.shift().callback();
    await drainMicrotasks();
    run.handle.stop();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(run.acks()).toEqual([{ id: 'evt-poison', result: REFUSED_ACK('vera') }]);
    expect(run.errors.filter((e) => e.code === 'agent_spawn_retry_scheduled')).toHaveLength(0);
  });

  test('posts one notice naming the PR, the exact head, the message and the sender, and handing off', async () => {
    const run = setup({ events: [poisonEvent()], spawn: jest.fn(async () => { throw refusal(); }) });
    await drainMicrotasks();
    run.handle.stop();

    expect(run.notices()).toHaveLength(1);
    const [notice] = run.notices();
    expect(notice).toContain(`#2249 at \`${HEAD}\``);
    expect(notice).toContain('message 78195 from lily-shen');
    expect(notice).toMatch(/@vera, please take it\.$/);
  });

  test('the notice repeats none of the flagged content, and no pod id is taken for the head', async () => {
    const run = setup({ events: [poisonEvent()], spawn: jest.fn(async () => { throw refusal(); }) });
    await drainMicrotasks();
    run.handle.stop();

    const [notice] = run.notices();
    for (const fragment of ['169.254', 'meta-data', 'ReDoS', 'aaaaaaaa', 'security gate', POD_ID]) {
      expect(notice).not.toContain(fragment);
    }
  });

  test('a mixed batch: the ordinary item is still handled, and only the refused one is refused', async () => {
    const spawn = jest.fn(async (prompt) => {
      if (prompt.includes('169.254.169.254')) throw refusal();
      return { text: 'docs gate: PASS' };
    });
    const run = setup({ events: [poisonEvent(), normalEvent()], spawn });
    await drainMicrotasks();
    run.handle.stop();

    // The composite turn, then each item alone.
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[1][0]).toContain('169.254.169.254');
    expect(spawn.mock.calls[1][0]).not.toContain('#2250');
    expect(spawn.mock.calls[2][0]).toContain('#2250');
    expect(spawn.mock.calls[2][0]).not.toContain('169.254.169.254');

    expect(run.acks()).toEqual([
      { id: 'evt-poison', result: REFUSED_ACK('vera') },
      { id: 'evt-normal', result: { outcome: 'posted' } },
    ]);
    // Each item's claim closes with its own outcome, not the batch's.
    expect(run.releases()).toEqual(expect.arrayContaining([
      { messageId: '78195', body: { outcome: 'refused', reason: 'upstream-refused' } },
      { messageId: '78196', body: { outcome: 'completed' } },
    ]));
    expect(run.posts()).toContain('docs gate: PASS');
    expect(run.notices()).toHaveLength(1);
    expect(run.notices()[0]).not.toContain('#2250');
  });

  test('a mixed batch whose ordinary item then fails for another reason leaves it unacked for redelivery', async () => {
    const spawn = jest.fn(async (prompt) => {
      if (prompt.includes('169.254.169.254')) throw refusal();
      throw new Error('runtime unavailable');
    });
    const run = setup({ events: [poisonEvent(), normalEvent()], spawn });
    await drainMicrotasks();
    run.handle.stop();

    expect(run.acks()).toEqual([{ id: 'evt-poison', result: REFUSED_ACK('vera') }]);
    const retries = run.errors.filter((e) => e.code === 'agent_spawn_retry_scheduled');
    expect(retries).toHaveLength(1);
    expect(retries[0].message).toContain('1 events remain unacked');
    expect(retries[0].failureClass).toBe('runtime');
    // First failure of a streak: the ordinary first retry, not the circuit.
    expect(run.scheduled[0].delayMs).toBe(5000);
  });

  test('an ordinary runtime failure is still retried and never acked (unchanged)', async () => {
    const spawn = jest.fn(async () => { throw new Error('runtime unavailable'); });
    const run = setup({ events: [normalEvent()], spawn });
    await drainMicrotasks();
    run.handle.stop();

    expect(run.acks()).toEqual([]);
    expect(run.notices()).toEqual([]);
    expect(run.errors.filter((e) => e.code === 'agent_spawn_retry_scheduled')).toHaveLength(1);
  });

  test('without --refusal-handoff the notice names no one', async () => {
    const run = setup({
      events: [poisonEvent()], spawn: jest.fn(async () => { throw refusal(); }), refusalHandoff: null,
    });
    await drainMicrotasks();
    run.handle.stop();

    expect(run.notices()[0]).toMatch(/It needs another reader\.$/);
    expect(run.notices()[0]).not.toContain('@');
    expect(run.acks()[0].result).toEqual(REFUSED_ACK(null));
  });

  test('in a DM the notice is posted without @mentioning a third agent', async () => {
    const run = setup({
      events: [poisonEvent({ type: 'dm.message' })], spawn: jest.fn(async () => { throw refusal(); }),
    });
    await drainMicrotasks();
    run.handle.stop();

    expect(run.notices()).toHaveLength(1);
    expect(run.notices()[0]).not.toContain('@vera');
    expect(run.acks()[0].result).toEqual(REFUSED_ACK(null));
  });

  test('a refused human broadcast gets no pod notice; its claim releases as upstream-refused, for the kernel to hand on', async () => {
    const event = poisonEvent({ type: 'message.posted' });
    event.payload.senderIsHuman = true;
    const run = setup({ events: [event], spawn: jest.fn(async () => { throw refusal(); }) });
    await drainMicrotasks();
    run.handle.stop();

    expect(run.notices()).toEqual([]);
    expect(run.releases()).toEqual([{
      messageId: '78195', body: { outcome: 'refused', reason: 'upstream-refused' },
    }]);
    expect(run.acks()).toEqual([{
      id: 'evt-poison',
      result: { outcome: 'error', reason: 'provider-refused', details: { failureClass: 'content_refused' } },
    }]);
  });

  test('a refused private ask is acked as refused with no pod notice', async () => {
    const run = setup({
      events: [{
        _id: 'evt-ask',
        type: 'agent.ask',
        podId: POD_ID,
        agentName: 'rhea',
        instanceId: 'default',
        payload: {
          requestId: 'ask/9', fromAgent: 'planner', fromInstanceId: 'default', question: FLAGGED,
        },
      }],
      spawn: jest.fn(async () => { throw refusal(); }),
    });
    await drainMicrotasks();
    run.handle.stop();

    expect(run.notices()).toEqual([]);
    expect(run.acks()).toEqual([{
      id: 'evt-ask',
      result: { outcome: 'error', reason: 'provider-refused', details: { failureClass: 'content_refused' } },
    }]);
    expect(run.errors.filter((e) => e.code === 'agent_spawn_retry_scheduled')).toHaveLength(0);
  });
});
