/**
 * batch-retry-hold.test.mjs — a scheduled retry fires or releases.
 *
 * Seen live on sprint-review (2026-10-25): a failed inbox batch logged "retry
 * scheduled, next probe in 11.2s", and no retry of those events ever ran. The
 * events were already claimed by `GET /events`, so the next poll could not
 * return them; they came back only through the server's requeue sweep 10–20
 * minutes later, with the process alive and idle in between.
 *
 * The rule (CTO ruling, 2026-10-25): a scheduled retry either fires,
 * re-processing the held events, or releases them. It never leaves a live
 * process idle while events stay unacked.
 *
 * The server below is modelled the way claimPage behaves: a poll returns
 * pending rows and marks them delivered, so a later poll does NOT return them
 * again. The older run-loop fixtures return the same event on every poll,
 * which is exactly why this bug passed them.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-retry-hold-test-'));

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

beforeEach(() => {
  jest.clearAllMocks();
  fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
});

const makeEvent = (id, content, overrides = {}) => ({
  _id: id,
  type: 'chat.mention',
  podId: 'pod-abc',
  agentName: 'my-stub',
  instanceId: 'default',
  payload: { content, deliveryId: `nonce-${id}` },
  ...overrides,
});

// A claim-modelling server. `pages` is what each successive poll returns; once
// they run out, polls return nothing — a claimed row never comes back on its
// own. `renewed` decides which ids /events/renew confirms (default: every id
// that has not been acked, as renewDelivery does).
const fakeServer = ({ pages, renewed } = {}) => {
  const queue = [...pages];
  const acks = [];
  const renewals = [];
  const polls = [];
  const get = jest.fn(async (route) => {
    if (route === '/api/agents/runtime/events') {
      const events = queue.length ? queue.shift() : [];
      polls.push(events.map((event) => event._id));
      return { events };
    }
    if (route.endsWith('/messages')) return { messages: [] };
    if (route.endsWith('/memory')) return { sections: {} };
    return {};
  });
  const post = jest.fn(async (route, body) => {
    const ack = String(route).match(/\/events\/([^/]+)\/ack$/);
    if (ack) acks.push({ id: ack[1], deliveryId: body?.deliveryId ?? null, result: body?.result });
    if (String(route).endsWith('/events/renew')) {
      renewals.push(body.events.map((entry) => entry.eventId));
      const ids = body.events.map((entry) => entry.eventId)
        .filter((id) => !acks.some((a) => a.id === id))
        .filter((id) => (renewed ? renewed(id) : true));
      return { renewed: ids };
    }
    return {};
  });
  createClient.mockReturnValue({ get, post });
  return { get, post, acks, renewals, polls };
};

const startRun = ({ spawn, ...options }) => {
  const scheduled = [];
  const intervals = [];
  const errors = [];
  const logs = [];
  const clearIntervalImpl = jest.fn();
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
    setIntervalImpl: (callback, delay) => {
      const timer = { callback, delay };
      intervals.push(timer);
      return timer;
    },
    clearIntervalImpl,
    setDeadlineTimeoutImpl: () => 0,
    clearDeadlineTimeoutImpl: () => {},
    log: (line) => logs.push(line),
    onError: (error) => errors.push(error),
    ...options,
  });
  const fireNext = async (expectedDelayMs) => {
    const next = scheduled.shift();
    expect(next).toBeDefined();
    if (expectedDelayMs !== undefined) expect(next.delayMs).toBe(expectedDelayMs);
    next.callback();
    await drainMicrotasks();
  };
  return { handle, scheduled, intervals, errors, logs, clearIntervalImpl, fireNext };
};

const retryReports = (errors) => errors.filter((error) => error.code === 'agent_spawn_retry_scheduled');
const turnPostsIn = (post) => post.mock.calls.filter(([route]) => String(route).endsWith('/messages'));

describe('performRun — a failed turn is retried from the carry', () => {
  test('the retry timer re-runs the same events and acks them, with nothing new from the server', async () => {
    const server = fakeServer({
      pages: [[makeEvent('evt-a', 'first ask from the pod'), makeEvent('evt-b', 'second ask from the pod')]],
    });
    const spawn = jest.fn()
      .mockRejectedValueOnce(new Error('claude exited with code 1:'))
      .mockResolvedValueOnce({ text: 'both handled' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(server.acks).toEqual([]);
      const [report] = retryReports(run.errors);
      expect(report.message).toContain('retrying 2 held events in 5s');
      expect(report.message).not.toMatch(/remain unacked|next probe/);
      expect(report).toMatchObject({ heldCount: 2, releasedCount: 0, retryAfterMs: 5000 });

      await run.fireNext(5000);

      // The second poll returned nothing, and the turn still ran on both.
      expect(server.polls).toEqual([['evt-a', 'evt-b'], []]);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[1][0]).toContain('first ask from the pod');
      expect(spawn.mock.calls[1][0]).toContain('second ask from the pod');
      expect(turnPostsIn(server.post)).toHaveLength(1);
      expect(server.acks.map(({ id, deliveryId }) => ({ id, deliveryId }))).toEqual([
        { id: 'evt-a', deliveryId: 'nonce-evt-a' },
        { id: 'evt-b', deliveryId: 'nonce-evt-b' },
      ]);
    } finally { run.handle.stop(); }
  });

  test('a server requeue of a held event is processed once, under its live deliveryId', async () => {
    const held = makeEvent('evt-requeued', 'please answer exactly once');
    // While the copy is held, the requeue sweep hands the same id back under
    // a new nonce, and the next poll claims it.
    const requeued = { ...held, payload: { ...held.payload, deliveryId: 'nonce-after-requeue' } };
    const server = fakeServer({ pages: [[held], [requeued]] });
    const spawn = jest.fn()
      .mockRejectedValueOnce(new Error('claude exited with code 1:'))
      .mockResolvedValueOnce({ text: 'answered' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      await run.fireNext(5000);

      expect(spawn).toHaveBeenCalledTimes(2);
      const prompt = spawn.mock.calls[1][0];
      expect(prompt.split('please answer exactly once')).toHaveLength(2);
      expect(turnPostsIn(server.post)).toHaveLength(1);
      // One ack, carrying the requeued delivery's nonce: the carried copy's
      // nonce was cleared by the requeue and would be refused as stale.
      expect(server.acks.map(({ id, deliveryId }) => ({ id, deliveryId }))).toEqual([
        { id: 'evt-requeued', deliveryId: 'nonce-after-requeue' },
      ]);
    } finally { run.handle.stop(); }
  });

  test('an event the server no longer holds for this runner is dropped from the carry, not re-run', async () => {
    // e.g. the child checkpointed evt-done before the turn failed.
    const server = fakeServer({
      pages: [[makeEvent('evt-done', 'already checkpointed'), makeEvent('evt-open', 'still open')]],
      renewed: (id) => id !== 'evt-done',
    });
    const spawn = jest.fn()
      .mockRejectedValueOnce(new Error('claude exited with code 1:'))
      .mockResolvedValueOnce({ text: 'finished' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(server.renewals).toEqual([['evt-done', 'evt-open']]);
      expect(retryReports(run.errors)[0].message).toContain('retrying 1 held event in 5s');
      expect(run.logs.some((line) => /1 event no longer held by this runner/.test(line))).toBe(true);

      await run.fireNext(5000);
      expect(spawn.mock.calls[1][0]).toContain('still open');
      expect(spawn.mock.calls[1][0]).not.toContain('already checkpointed');
      expect(server.acks.map((a) => a.id)).toEqual(['evt-open']);
    } finally { run.handle.stop(); }
  });

  test('consecutive failures keep re-running the held events every retry, then release them at the cap', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-stuck', 'keeps failing')]] });
    const spawn = jest.fn().mockRejectedValue(new Error('claude exited with code 1:'));
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(1);
      await run.fireNext(5000);
      // No new events arrived, and the retry still ran a turn: never idle.
      expect(spawn).toHaveBeenCalledTimes(2);
      await run.fireNext(10000);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(server.polls).toEqual([['evt-stuck'], [], []]);

      const reports = retryReports(run.errors);
      expect(reports.map((report) => [report.heldCount, report.releasedCount])).toEqual([
        [1, 0], [1, 0], [0, 1],
      ]);
      expect(reports[0].message).toContain('retrying 1 held event in 5s');
      expect(reports[1].message).toContain('retrying 1 held event in 10s');
      // The third failure opens the circuit and hands the event back, and the
      // report says so instead of promising a retry.
      expect(reports[2].message).toMatch(
        /circuit open; releasing 1 event after 3 failed attempts to the server's requeue .*; next poll in 1m/,
      );
      expect(server.acks).toEqual([]);

      // Released: the next poll is a poll, not a hidden re-run.
      await run.fireNext(60000);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(server.renewals.flat()).toEqual(['evt-stuck', 'evt-stuck']);
    } finally { run.handle.stop(); }
  });

  test('a long circuit-open wait keeps the held leases alive, and stop() clears the renewal', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-quota', 'wait out the quota')]] });
    const spawn = jest.fn()
      .mockRejectedValueOnce(new Error('insufficient_quota: billing limit'))
      .mockResolvedValueOnce({ text: 'back' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      const [report] = retryReports(run.errors);
      expect(report).toMatchObject({ failureClass: 'quota', circuitOpen: true, heldCount: 1 });
      expect(report.message).toContain('circuit open; retrying 1 held event in 15m');
      expect(run.scheduled[0].delayMs).toBe(15 * 60 * 1000);

      // A 15-minute wait outlives the 10-minute server lease without renewal.
      // The first 60s interval is the failed turn's own renewal, already
      // stopped; the second is the hold's.
      const minuteTimers = run.intervals.filter((timer) => timer.delay === 60_000);
      expect(minuteTimers).toHaveLength(2);
      const holdRenewal = minuteTimers[1];
      const before = server.renewals.length;
      await holdRenewal.callback();
      expect(server.renewals.slice(before)).toEqual([['evt-quota']]);

      await run.fireNext(15 * 60 * 1000);
      expect(run.clearIntervalImpl).toHaveBeenCalledWith(holdRenewal);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(server.acks.map((a) => a.id)).toEqual(['evt-quota']);
    } finally { run.handle.stop(); }
  });

  test('a failure carries the later groups of the page it stopped before they ran', async () => {
    // An older server can still return two pods in one page; the first pod's
    // failure stops the page (#782), and the second pod's claimed events must
    // not be stranded either.
    const server = fakeServer({
      pages: [[
        makeEvent('evt-pod-a', 'pod a ask'),
        makeEvent('evt-pod-b', 'pod b ask', { podId: 'pod-other' }),
      ]],
    });
    const spawn = jest.fn()
      .mockRejectedValueOnce(new Error('claude exited with code 1:'))
      .mockResolvedValue({ text: 'ok' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(retryReports(run.errors)[0].message).toContain('retrying 2 held events in 5s');

      await run.fireNext(5000);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(server.acks.map((a) => a.id).sort()).toEqual(['evt-pod-a', 'evt-pod-b']);
    } finally { run.handle.stop(); }
  });

  test('a failed private event is carried to the retry like a batch', async () => {
    const ask = makeEvent('evt-ask', 'private consult', {
      type: 'agent.ask',
      payload: {
        requestId: 'ask/1',
        fromAgent: 'planner',
        fromInstanceId: 'default',
        question: 'private consult',
        deliveryId: 'nonce-evt-ask',
      },
    });
    const server = fakeServer({ pages: [[ask]] });
    const spawn = jest.fn()
      .mockRejectedValueOnce(new Error('claude exited with code 1:'))
      .mockResolvedValueOnce({ text: 'the answer' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(retryReports(run.errors)[0].message).toContain('event evt-ask unacked; retrying 1 held event in 5s');
      await run.fireNext(5000);
      expect(server.polls).toEqual([['evt-ask'], []]);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(server.acks.map((a) => a.id)).toEqual(['evt-ask']);
    } finally { run.handle.stop(); }
  });
});
