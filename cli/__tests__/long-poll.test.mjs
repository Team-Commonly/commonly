/**
 * long-poll.test.mjs — F597: an idle BYO agent costs almost nothing.
 *
 * The events poll asks the server to hold an empty answer (`waitMs`). After a
 * held empty answer the loop polls again at once; against a server that
 * answers at once (an older one that ignores waitMs) it keeps its ordinary
 * interval and never spins; errors back off as before; and stop() ends a held
 * poll instead of waiting it out. Covered for both CAP polls: `agent run`
 * (performRun) and `agent connect` (startPoller).
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-long-poll-test-'));

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
const { startPoller } = await import('../src/lib/poller.js');
const { longPollWaitMs, wasHeld, LONG_POLL_MAX_WAIT_MS } = await import('../src/lib/long-poll.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

const EVENTS = '/api/agents/runtime/events';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const drainMicrotasks = async () => {
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

afterAll(() => fs.rmSync(sessionsTmpDir, { recursive: true, force: true }));
beforeEach(() => {
  jest.clearAllMocks();
  fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
});

// A server whose events poll answers after `holdMs` (a held long-poll) or at
// once (holdMs 0, an old server), always empty unless `pages` say otherwise.
// An aborted poll rejects the way fetch does.
const fakeServer = ({ holdMs = 0, pages = [], failWith = null } = {}) => {
  const queue = [...pages];
  const polls = [];
  const get = jest.fn((route, params, options) => {
    if (route !== EVENTS) {
      if (route.endsWith('/messages')) return Promise.resolve({ messages: [] });
      if (route.endsWith('/memory')) return Promise.resolve({ sections: {} });
      return Promise.resolve({});
    }
    polls.push(params);
    if (failWith) return Promise.reject(failWith);
    const events = queue.length ? queue.shift() : [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ events, inboxCount: events.length }), events.length ? 0 : holdMs);
      options?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      }, { once: true });
    });
  });
  const post = jest.fn(async () => ({}));
  createClient.mockReturnValue({ get, post });
  return { get, post, polls };
};

describe('long-poll helpers', () => {
  test('the wait is 25s by default and always leaves room inside the read timeout', () => {
    expect(longPollWaitMs({ env: {} })).toBe(LONG_POLL_MAX_WAIT_MS);
    expect(LONG_POLL_MAX_WAIT_MS).toBe(25_000);
    expect(longPollWaitMs({ env: { COMMONLY_CAP_TIMEOUT_MS: '12000' } })).toBe(7000);
    // No room for a meaningful hold: off.
    expect(longPollWaitMs({ env: { COMMONLY_CAP_TIMEOUT_MS: '5500' } })).toBe(0);
  });

  test('held means the answer took at least half the requested wait', () => {
    expect(wasHeld({ requestedMs: 25000, elapsedMs: 24990 })).toBe(true);
    expect(wasHeld({ requestedMs: 25000, elapsedMs: 40 })).toBe(false);
    expect(wasHeld({ requestedMs: 0, elapsedMs: 99999 })).toBe(false);
  });
});

describe('agent run (performRun)', () => {
  const startRun = (options = {}) => {
    const scheduled = [];
    const errors = [];
    const handle = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter: { name: 'stub', detect: stubAdapter.detect, spawn: jest.fn(async () => ({ text: 'ok' })) },
      agentName: 'my-stub',
      retryJitterRatio: 0,
      intervalMs: 5000,
      setTimeoutImpl: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return 0; },
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {},
      setDeadlineTimeoutImpl: () => 0,
      clearDeadlineTimeoutImpl: () => {},
      onError: (error) => errors.push(error),
      ...options,
    });
    return { handle, scheduled, errors };
  };
  const untilScheduled = async (run) => {
    for (let i = 0; i < 100 && run.scheduled.length === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(10);
      // eslint-disable-next-line no-await-in-loop
      await drainMicrotasks();
    }
    expect(run.scheduled.length).toBeGreaterThan(0);
  };

  test('the inbox poll sends waitMs', async () => {
    const server = fakeServer();
    const run = startRun({ longPollWaitMs: 25_000 });
    try {
      await untilScheduled(run);
      expect(server.polls[0]).toMatchObject({ agentName: 'my-stub', waitMs: 25_000 });
    } finally { await run.handle.stop(); }
  });

  test('after a held empty answer the next poll is scheduled at once, with no sleep', async () => {
    const server = fakeServer({ holdMs: 80 });
    const run = startRun({ longPollWaitMs: 80 });
    try {
      await untilScheduled(run);
      expect(server.polls).toHaveLength(1);
      expect(run.scheduled[0].delayMs).toBe(0);
    } finally { await run.handle.stop(); }
  });

  test('against a server that answers at once, the ordinary interval is kept', async () => {
    const server = fakeServer({ holdMs: 0 });
    const run = startRun({ longPollWaitMs: 25_000 });
    try {
      await untilScheduled(run);
      expect(server.polls[0].waitMs).toBe(25_000);
      expect(run.scheduled[0].delayMs).toBe(5000);
    } finally { await run.handle.stop(); }
  });

  test('a failed poll backs off as before', async () => {
    fakeServer({ failWith: Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }) });
    const run = startRun({ longPollWaitMs: 25_000 });
    try {
      await untilScheduled(run);
      expect(run.scheduled[0].delayMs).toBeGreaterThanOrEqual(5000);
      expect(run.errors.map((e) => e.message)).toContain('fetch failed');
    } finally { await run.handle.stop(); }
  });

  test('longPollWaitMs 0 turns the long-poll off: no waitMs is sent', async () => {
    const server = fakeServer({ holdMs: 0 });
    const run = startRun({ longPollWaitMs: 0 });
    try {
      await untilScheduled(run);
      expect(server.polls[0].waitMs).toBeUndefined();
    } finally { await run.handle.stop(); }
  });

  test('stop() ends a held poll at once, with no error', async () => {
    fakeServer({ holdMs: 20_000 });
    const run = startRun({ longPollWaitMs: 20_000 });
    await sleep(30);
    const started = Date.now();
    await run.handle.stop();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(run.errors).toEqual([]);
    expect(run.scheduled).toEqual([]);
  });
});

describe('agent connect (startPoller)', () => {
  const poller = (options = {}) => {
    const errors = [];
    const handle = startPoller({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_test',
      agentName: 'my-agent',
      intervalMs: 100_000,
      onEvent: async () => ({ outcome: 'acknowledged' }),
      onError: (err) => errors.push(err),
      ...options,
    });
    return { handle, errors };
  };

  test('sends waitMs, and polls again at once after a held empty answer', async () => {
    const server = fakeServer({ holdMs: 60 });
    const { handle } = poller({ longPollWaitMs: 60 });
    await sleep(400);
    handle.stop();
    // With a 100s interval, more than one poll in 400ms means no sleep after a hold.
    expect(server.polls.length).toBeGreaterThanOrEqual(3);
    expect(server.polls[0]).toMatchObject({ agentName: 'my-agent', waitMs: 60 });
  });

  test('keeps its interval against a server that answers at once', async () => {
    const server = fakeServer({ holdMs: 0 });
    const { handle } = poller({ longPollWaitMs: 25_000, intervalMs: 200 });
    await sleep(500);
    handle.stop();
    expect(server.polls.length).toBeGreaterThanOrEqual(2);
    expect(server.polls.length).toBeLessThanOrEqual(4);
  });

  test('backs off on error as before', async () => {
    const server = fakeServer({ failWith: new Error('fetch failed') });
    const { handle, errors } = poller({ longPollWaitMs: 25_000, intervalMs: 100 });
    await sleep(450);
    handle.stop();
    // 100ms, then a 100ms backoff + 100ms, then 200ms + 100ms: about 3 polls, not dozens.
    expect(server.polls.length).toBeGreaterThanOrEqual(2);
    expect(server.polls.length).toBeLessThanOrEqual(4);
    expect(errors.every((e) => e.message === 'fetch failed')).toBe(true);
  });

  test('stop() ends a held poll with no error', async () => {
    fakeServer({ holdMs: 20_000 });
    const { handle, errors } = poller({ longPollWaitMs: 20_000 });
    await sleep(30);
    handle.stop();
    await sleep(30);
    expect(errors).toEqual([]);
  });
});
