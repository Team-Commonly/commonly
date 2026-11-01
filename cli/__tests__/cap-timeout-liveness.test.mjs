/**
 * TASK-338: one CAP request that never settles used to wedge the inbox loop for
 * good. On 10-31 nib and folio each got an HTTP 504, then a request the network
 * accepted and never answered, and sat alive and idle for 8+ hours, because
 * their keepalives act only on exit.
 *
 * These run against a real HTTP server, not a mocked client, because the defect
 * lives in the fetch call itself: a mocked `get` can't hang the way a socket does.
 */
import { jest } from '@jest/globals';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cap-timeout-'));

await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => homeDir },
  homedir: () => homeDir,
}));

await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const { startPoller } = await import('../src/lib/poller.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

const GATEWAY_PAGE = '<!DOCTYPE html><html><head><title>504 Gateway Time-out</title></head><body>…</body></html>';

// `script(n)` decides what the n-th inbox poll gets: 'gateway' (504), 'hang'
// (accepted, never answered) or a page object. Everything else answers 200 {}.
// `other(req)` may return 'hang' for a non-poll request (an ack, say).
const startStub = async (script, { other = () => null, delayMs = 0 } = {}) => {
  const polls = [];
  const answered = [];
  const others = [];
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/api/agents/runtime/events' || req.method !== 'GET') {
      others.push(`${req.method} ${req.url.split('?')[0]}`);
      if (other(req) === 'hang') return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const n = polls.push(Date.now());
    const step = script(n);
    if (step === 'hang') return;
    if (step === 'gateway') {
      res.writeHead(504, { 'Content-Type': 'text/html' });
      res.end(GATEWAY_PAGE);
      return;
    }
    const answer = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(step));
      answered.push(n);
    };
    if (delayMs) setTimeout(answer, delayMs); else answer();
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    polls,
    answered,
    others,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
};

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
};

const EMPTY = { events: [], inboxCount: 0 };
// The loop records handled event ids on disk, so each test needs its own id or
// it reads as a duplicate delivery and skips the turn.
const mentionFor = (id) => ({
  _id: id,
  type: 'chat.mention',
  podId: 'pod-338',
  agentName: 'my-stub',
  instanceId: 'default',
  payload: { content: 'take your time on this one', messageId: `msg-${id}` },
});

let stub;
let stopLoop;
const savedTimeout = process.env.COMMONLY_CAP_TIMEOUT_MS;

afterEach(async () => {
  stopLoop?.();
  stopLoop = null;
  await stub?.close();
  stub = null;
  if (savedTimeout === undefined) delete process.env.COMMONLY_CAP_TIMEOUT_MS;
  else process.env.COMMONLY_CAP_TIMEOUT_MS = savedTimeout;
});

afterAll(() => { fs.rmSync(homeDir, { recursive: true, force: true }); });

const run = (overrides = {}) => {
  const errors = [];
  const onPollStalled = jest.fn();
  const { stop } = performRun({
    instanceUrl: stub.url,
    token: 'cm_agent_test',
    adapter: { name: 'codex', detect: stubAdapter.detect, spawn: jest.fn(async () => ({ text: '' })) },
    agentName: 'my-stub',
    instanceId: 'default',
    intervalMs: 20,
    retryJitterRatio: 0,
    superviseRuns: false,
    revokeOrphansImpl: async () => {},
    onError: (err) => errors.push(err),
    onPollStalled,
    ...overrides,
  });
  stopLoop = stop;
  return { errors, onPollStalled };
};

describe('every CAP request has a hard timeout', () => {
  test('a 504 is an ordinary failure, and a request that is never answered times out', async () => {
    stub = await startStub((n) => (n === 1 ? 'gateway' : 'hang'));
    const client = createClient({ instance: stub.url, token: 'cm_agent_test', timeoutMs: 150 });

    await expect(client.get('/api/agents/runtime/events')).rejects.toMatchObject({
      status: 504,
      message: 'HTTP 504: 504 Gateway Time-out',
    });

    const started = Date.now();
    await expect(client.get('/api/agents/runtime/events')).rejects.toMatchObject({
      code: 'cap_timeout',
      timeoutMs: 150,
      message: 'GET /api/agents/runtime/events got no answer in 150ms',
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('writes get twice the read timeout, and the env var sets the base', async () => {
    const silent = http.createServer(() => {});
    await new Promise((resolve) => { silent.listen(0, '127.0.0.1', resolve); });
    stub = {
      url: `http://127.0.0.1:${silent.address().port}`,
      close: () => new Promise((resolve) => { silent.closeAllConnections(); silent.close(resolve); }),
    };
    process.env.COMMONLY_CAP_TIMEOUT_MS = '100';
    const client = createClient({ instance: stub.url, token: 'cm_agent_test' });

    await expect(client.get('/api/x')).rejects.toMatchObject({ code: 'cap_timeout', timeoutMs: 100 });
    await expect(client.post('/api/agents/runtime/events/e1/ack', {})).rejects.toMatchObject({
      code: 'cap_timeout',
      timeoutMs: 200,
      message: 'POST /api/agents/runtime/events/e1/ack got no answer in 200ms',
    });
  });
});

describe('the timeout covers the whole response, and only renames its own abort', () => {
  test('headers, then silence: the body read is cut off too', async () => {
    const trickle = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"events": [');
    });
    await new Promise((resolve) => { trickle.listen(0, '127.0.0.1', resolve); });
    stub = {
      url: `http://127.0.0.1:${trickle.address().port}`,
      close: () => new Promise((resolve) => { trickle.closeAllConnections(); trickle.close(resolve); }),
    };
    const client = createClient({ instance: stub.url, token: 'cm_agent_test', timeoutMs: 150 });
    await expect(client.get('/api/agents/runtime/events')).rejects.toMatchObject({ code: 'cap_timeout' });
  });

  test("a caller's own shorter timeout keeps its own error", async () => {
    stub = await startStub(() => 'hang');
    const client = createClient({ instance: stub.url, token: 'cm_agent_test', timeoutMs: 5000 });
    const err = await client.get('/api/agents/runtime/events', {}, { signal: AbortSignal.timeout(50) })
      .catch((e) => e);
    expect(err.name).toBe('TimeoutError');
    expect(err.code).not.toBe('cap_timeout');
    expect(err.timeoutMs).toBeUndefined();
  });
});

describe('without AbortSignal.any (Node 20.0 to 20.2)', () => {
  const realAny = AbortSignal.any;
  afterEach(() => { AbortSignal.any = realAny; });

  test("a caller's longer signal does not replace the hard timeout", async () => {
    stub = await startStub(() => 'hang');
    AbortSignal.any = undefined;
    const client = createClient({ instance: stub.url, token: 'cm_agent_test', timeoutMs: 150 });
    await expect(client.get('/api/agents/runtime/events', {}, { signal: AbortSignal.timeout(5000) }))
      .rejects.toMatchObject({ code: 'cap_timeout', timeoutMs: 150 });
  });

  test("a settled request takes its listener off a caller's long-lived signal", async () => {
    stub = await startStub(() => EMPTY);
    AbortSignal.any = undefined;
    const caller = new AbortController();
    const added = jest.spyOn(caller.signal, 'addEventListener');
    const removed = jest.spyOn(caller.signal, 'removeEventListener');
    const client = createClient({ instance: stub.url, token: 'cm_agent_test', timeoutMs: 5000 });
    await client.get('/api/agents/runtime/events', {}, { signal: caller.signal });
    await client.get('/api/agents/runtime/events', {}, { signal: caller.signal });
    const ours = (spy) => spy.mock.calls.filter(([type]) => type === 'abort').map(([, fn]) => fn);
    expect(ours(removed)).toEqual(ours(added));
    expect(ours(added)).toHaveLength(2);
  });

  test("a caller's shorter timeout still keeps its own error", async () => {
    stub = await startStub(() => 'hang');
    AbortSignal.any = undefined;
    const client = createClient({ instance: stub.url, token: 'cm_agent_test', timeoutMs: 5000 });
    const err = await client.get('/api/agents/runtime/events', {}, { signal: AbortSignal.timeout(50) })
      .catch((e) => e);
    expect(err.name).toBe('TimeoutError');
    expect(err.code).not.toBe('cap_timeout');
  });
});

describe('agent run: the inbox loop survives a hung poll', () => {
  test('504, then a hang, then healthy: the loop backs off and recovers, with no stall exit', async () => {
    process.env.COMMONLY_CAP_TIMEOUT_MS = '150';
    stub = await startStub((n) => (n === 1 ? 'gateway' : n === 2 ? 'hang' : EMPTY));
    const { errors, onPollStalled } = run();

    await waitFor(() => stub.answered.length >= 2);

    expect(errors.map((e) => e.status ?? e.code).slice(0, 2)).toEqual([504, 'cap_timeout']);
    expect(onPollStalled).not.toHaveBeenCalled();
  });

  test('a poll that outlives the liveness limit stops the loop and asks for an exit', async () => {
    // A timeout longer than the liveness limit: the second net has to catch it.
    process.env.COMMONLY_CAP_TIMEOUT_MS = '60000';
    stub = await startStub(() => 'hang');
    const { errors, onPollStalled } = run({ pollLivenessMs: 200, pollLivenessCheckMs: 20 });

    await waitFor(() => onPollStalled.mock.calls.length === 1);

    expect(onPollStalled.mock.calls[0][0].stalledMs).toBeGreaterThanOrEqual(200);
    expect(errors.at(-1).message).toMatch(/^poll stalled: no inbox poll settled for 1s/);
    // Stopped: no second poll is ever sent.
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(stub.polls).toHaveLength(1);
  });

  test('a turn longer than the liveness limit is not a stall', async () => {
    process.env.COMMONLY_CAP_TIMEOUT_MS = '1000';
    stub = await startStub((n) => (n === 1 ? { events: [mentionFor('evt-long-turn')], inboxCount: 1 } : EMPTY));
    let turnEnded = 0;
    const spawn = jest.fn(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 2500); });
      turnEnded = Date.now();
      return { text: '' };
    });
    const { onPollStalled } = run({
      adapter: { name: 'codex', detect: stubAdapter.detect, spawn },
      pollLivenessMs: 1000,
      pollLivenessCheckMs: 50,
    });

    // The loop polls again after the 3s post-turn collection window.
    await waitFor(() => stub.answered.length >= 2, 10000);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(turnEnded).toBeGreaterThan(0);
    expect(onPollStalled).not.toHaveBeenCalled();
  }, 15000);
});

describe('agent run: what the liveness clock covers', () => {
  test('an ack that hangs after the turn is a stall too', async () => {
    process.env.COMMONLY_CAP_TIMEOUT_MS = '60000';
    stub = await startStub((n) => (n === 1 ? { events: [mentionFor('evt-hung-ack')], inboxCount: 1 } : EMPTY), {
      other: (req) => (req.url.includes('/ack') ? 'hang' : null),
    });
    const spawn = jest.fn(async () => ({ text: '' }));
    const { onPollStalled } = run({
      adapter: { name: 'codex', detect: stubAdapter.detect, spawn },
      pollLivenessMs: 300,
      pollLivenessCheckMs: 20,
    });

    await waitFor(() => onPollStalled.mock.calls.length === 1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(stub.others.some((line) => line.endsWith('/ack'))).toBe(true);
  });

  test('stop() during an in-flight poll is a stop, not a stall', async () => {
    process.env.COMMONLY_CAP_TIMEOUT_MS = '5000';
    stub = await startStub(() => ({ events: [mentionFor('evt-stop-race')], inboxCount: 1 }), { delayMs: 300 });
    const spawn = jest.fn(async () => ({ text: '' }));
    const { onPollStalled } = run({
      adapter: { name: 'codex', detect: stubAdapter.detect, spawn },
      pollLivenessMs: 200,
      pollLivenessCheckMs: 20,
    });
    await waitFor(() => stub.polls.length === 1);
    stopLoop();

    // Past the poll's answer and past the liveness limit.
    await new Promise((resolve) => { setTimeout(resolve, 700); });
    expect(onPollStalled).not.toHaveBeenCalled();
    // The stopped loop leaves the page to requeue, as it did before this change.
    expect(spawn).not.toHaveBeenCalled();
    expect(stub.polls).toHaveLength(1);
  });
});

describe('agent connect: the poller has the same liveness exit', () => {
  test('a hung poll stops the poller and asks for an exit', async () => {
    process.env.COMMONLY_CAP_TIMEOUT_MS = '60000';
    stub = await startStub(() => 'hang');
    const onPollStalled = jest.fn();
    const errors = [];
    const { stop } = startPoller({
      instanceUrl: stub.url,
      token: 'cm_agent_test',
      agentName: 'my-stub',
      intervalMs: 20,
      onEvent: jest.fn(),
      onError: (err) => errors.push(err),
      pollLivenessMs: 200,
      pollLivenessCheckMs: 20,
      onPollStalled,
    });
    stopLoop = stop;

    await waitFor(() => onPollStalled.mock.calls.length === 1);
    expect(errors.at(-1).message).toMatch(/^poll stalled/);
  });
});
