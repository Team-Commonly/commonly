/**
 * held-events-redeliver.test.mjs — F189 / F182.
 *
 * Seen on prod (a walk on 2026-11-05): a codex seat's turn failed with
 * a configuration error, the circuit opened for 17.6 minutes, and the claimed
 * mention was carried in memory. The seat was stopped and restarted five
 * times; each restart's first poll could not see the carried mention, because
 * the server still had it `delivered` to the dead process, and only the
 * requeue sweep (10–20 min, one attempt per lap) could hand it back. The same
 * holds for a mention claimed during a daemon reload (F182).
 *
 * The rule: whatever a stopping run holds but will not run goes back to the
 * server as pending, so the next run answers it on its first poll, once.
 *
 * The server below keeps state across runs the way claimPage, ack, renew and
 * release do: a poll claims pending rows under a fresh nonce, an ack needs the
 * live nonce, and a release returns a row to pending.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-held-redeliver-test-'));

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

// Event ids as the server sends them: 24-hex ObjectId strings, which the real
// release route requires.
const ID = {
  wake_a: 'aa00000000000000000000b1',
  wake_b: 'aa00000000000000000000b2',
  batch_digest: 'aa00000000000000000000b3',
  other_digest: 'aa00000000000000000000b4',
  wake_c: 'aa00000000000000000000b5',
  stale_ask: 'aa00000000000000000000b6',
  third: 'aa00000000000000000000a1',
  ask: 'aa00000000000000000000a2',
  digest: 'aa00000000000000000000a3',
  e1: 'aa0000000000000000000001',
  e2: 'aa0000000000000000000002',
  fine: 'aa0000000000000000000003',
  held: 'aa0000000000000000000004',
  hello: 'aa0000000000000000000005',
  mid: 'aa0000000000000000000006',
  new: 'aa0000000000000000000007',
  old: 'aa0000000000000000000008',
  poison: 'aa0000000000000000000009',
  reload: 'aa000000000000000000000a',
  wait: 'aa000000000000000000000b',
};

// QUOTA for the circuit, with no allowance wording: these tests count turn posts,
// and insufficient_quota would add the pod's notice (F235) once per cause per hour.
const QUOTA = () => new Error('billing limit reached');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// One inbox shared by every run in a test, as the real server is.
const inbox = ({ releaseRoute = true, atCeiling = [], staleAcks = [] } = {}) => {
  const rows = new Map();
  let nonceSeq = 0;
  const acks = [];
  const releases = [];
  const polls = [];
  let pollGate = null;
  let releaseGate = null;
  let renewGate = null;
  const add = (id, content, overrides = {}) => {
    rows.set(id, {
      event: {
        _id: id, type: 'chat.mention', podId: 'pod-abc', agentName: 'my-stub', instanceId: 'default',
        payload: { content }, ...overrides,
      },
      status: 'pending',
      nonce: null,
    });
  };
  const get = jest.fn(async (route) => {
    if (route === '/api/agents/runtime/events') {
      if (pollGate) {
        const gate = pollGate;
        pollGate = null;
        await gate;
      }
      const claimed = [];
      for (const row of rows.values()) {
        if (row.status === 'pending') {
          nonceSeq += 1;
          row.status = 'delivered';
          row.nonce = `nonce-${nonceSeq}`;
          claimed.push({ ...row.event, payload: { ...row.event.payload, deliveryId: row.nonce } });
        }
      }
      polls.push(claimed.map((event) => event._id));
      return { events: claimed };
    }
    if (route.endsWith('/messages')) return { messages: [] };
    if (route.endsWith('/memory')) return { sections: {} };
    return {};
  });
  const post = jest.fn(async (route, body) => {
    const ack = String(route).match(/\/events\/([^/]+)\/ack$/);
    if (ack) {
      const row = rows.get(ack[1]);
      acks.push({ id: ack[1], deliveryId: body?.deliveryId ?? null });
      if (staleAcks.includes(ack[1])) {
        throw Object.assign(new Error('superseded'), { status: 409, body: { code: 'stale_delivery' } });
      }
      if (!row || row.status !== 'delivered' || row.nonce !== body?.deliveryId) {
        throw Object.assign(new Error('stale'), { status: 409, code: 'stale_delivery' });
      }
      row.status = 'acked';
      row.nonce = null;
      return { success: true };
    }
    if (String(route).endsWith('/events/renew')) {
      if (renewGate) await renewGate;
      return {
        renewed: body.events.filter(({ eventId, deliveryId }) => (
          rows.get(eventId)?.status === 'delivered' && rows.get(eventId)?.nonce === deliveryId
        )).map(({ eventId }) => eventId),
      };
    }
    if (String(route).endsWith('/events/release')) {
      if (!releaseRoute) throw Object.assign(new Error('Not Found'), { status: 404 });
      // The same check as isDeliveryPairList in backend/routes/agentsRuntime.ts.
      const valid = Array.isArray(body?.events) && body.events.length >= 1 && body.events.length <= 50
        && body.events.every((entry) => entry && typeof entry.eventId === 'string'
          && /^[a-fA-F0-9]{24}$/.test(entry.eventId) && typeof entry.deliveryId === 'string' && entry.deliveryId);
      if (!valid) {
        throw Object.assign(new Error('events requires 1–50 eventId/deliveryId pairs'), { status: 400 });
      }
      if (releaseGate) await releaseGate;
      const released = [];
      const refused = [];
      for (const { eventId, deliveryId } of body.events) {
        const row = rows.get(eventId);
        if (atCeiling.includes(eventId)) {
          refused.push(eventId);
        } else if (row?.status === 'delivered' && row.nonce === deliveryId) {
          row.status = 'pending';
          row.nonce = null;
          released.push(eventId);
        }
      }
      releases.push(released);
      return { released, atCeiling: refused };
    }
    return {};
  });
  createClient.mockReturnValue({ get, post });
  return {
    add,
    get,
    post,
    acks,
    releases,
    polls,
    status: (id) => rows.get(id)?.status,
    holdRenews: () => {
      const gate = deferred();
      renewGate = gate.promise;
      return gate.resolve;
    },
    holdReleases: () => {
      const gate = deferred();
      releaseGate = gate.promise;
      return gate.resolve;
    },
    holdNextPoll: () => {
      const gate = deferred();
      pollGate = gate.promise;
      return gate.resolve;
    },
  };
};

const startRun = ({ spawn, ...options }) => {
  const scheduled = [];
  const cleared = [];
  const errors = [];
  const logs = [];
  const handle = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
    agentName: 'my-stub',
    retryJitterRatio: 0,
    setTimeoutImpl: (callback, delayMs) => {
      const timer = { callback, delayMs };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => cleared.push(timer),
    setIntervalImpl: () => ({}),
    clearIntervalImpl: () => {},
    setDeadlineTimeoutImpl: () => 0,
    clearDeadlineTimeoutImpl: () => {},
    log: (line) => logs.push(line),
    onError: (error) => errors.push(error),
    ...options,
  });
  const fireNext = async () => {
    const next = scheduled.shift();
    expect(next).toBeDefined();
    next.callback();
    await drainMicrotasks();
    return next;
  };
  return { handle, scheduled, cleared, errors, logs, fireNext };
};

const turnPosts = (post) => post.mock.calls.filter(([route]) => String(route).endsWith('/messages'));
const ackedIds = (server) => server.acks.map((a) => a.id).sort();

describe('F189: mentions held behind an open circuit', () => {
  test('a mention that arrives while the circuit is open is answered with the held one when it closes', async () => {
    const server = inbox();
    server.add(ID.e1, 'first ask');
    const spawn = jest.fn().mockRejectedValueOnce(QUOTA()).mockResolvedValueOnce({ text: 'both answered' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(run.scheduled[0].delayMs).toBe(15 * 60 * 1000);
      server.add(ID.e2, 'asked while the circuit was open');

      await run.fireNext();
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[1][0]).toContain('first ask');
      expect(spawn.mock.calls[1][0]).toContain('asked while the circuit was open');
      expect(turnPosts(server.post)).toHaveLength(1);
      expect(ackedIds(server)).toEqual([ID.e1, ID.e2]);
      expect(server.releases).toEqual([]);
    } finally { run.handle.stop(); }
  });

  test('stopping during the circuit wait hands the held mention back, and the next run answers it once', async () => {
    const server = inbox();
    server.add(ID.held, 'claimed before the circuit opened');
    const first = startRun({ spawn: jest.fn().mockRejectedValue(QUOTA()) });
    await drainMicrotasks();
    expect(server.status(ID.held)).toBe('delivered');
    server.add(ID.new, 'sent during the circuit wait');

    first.handle.stop();
    await drainMicrotasks();
    // The 15-minute wait no longer keeps a stopped process alive.
    expect(first.cleared).toContain(first.scheduled[0]);
    expect(server.releases).toEqual([[ID.held]]);
    expect(server.status(ID.held)).toBe('pending');
    expect(first.logs.some((line) => /handed back 1 event/.test(line))).toBe(true);

    const spawn = jest.fn().mockResolvedValue({ text: 'answered both' });
    const second = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(server.polls[1]).toEqual([ID.held, ID.new]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][0]).toContain('claimed before the circuit opened');
      expect(spawn.mock.calls[0][0]).toContain('sent during the circuit wait');
      expect(turnPosts(server.post)).toHaveLength(1);
      expect(ackedIds(server)).toEqual([ID.held, ID.new]);
      expect(second.errors).toEqual([]);
    } finally { second.handle.stop(); }
  });

  test('a turn that fails after the stop arrived hands its events back instead of dropping them', async () => {
    const server = inbox();
    server.add(ID.mid, 'in the turn when the stop came');
    const turn = deferred();
    const first = startRun({ spawn: jest.fn(() => turn.promise) });
    await drainMicrotasks();
    first.handle.stop();
    turn.reject(QUOTA());
    await drainMicrotasks();
    expect(server.releases.flat()).toEqual([ID.mid]);
    expect(server.status(ID.mid)).toBe('pending');

    const spawn = jest.fn().mockResolvedValue({ text: 'answered' });
    const second = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(ackedIds(server)).toEqual([ID.mid]);
    } finally { second.handle.stop(); }
  });
});

describe('F182: a mention claimed as the run stops (daemon reload)', () => {
  test('a page claimed by a poll in flight at the stop is handed back and answered by the next run', async () => {
    const server = inbox();
    server.add(ID.reload, 'sent during the reload');
    const releasePoll = server.holdNextPoll();
    const first = startRun({ spawn: jest.fn() });
    await drainMicrotasks();
    first.handle.stop();
    releasePoll();
    await drainMicrotasks();
    expect(server.polls[0]).toEqual([ID.reload]);
    expect(server.releases.flat()).toEqual([ID.reload]);

    const spawn = jest.fn().mockResolvedValue({ text: 'answered after the reload' });
    const second = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][0]).toContain('sent during the reload');
      expect(ackedIds(server)).toEqual([ID.reload]);
    } finally { second.handle.stop(); }
  });

  test('a carried greeting is handed back on stop', async () => {
    const server = inbox();
    server.add(ID.hello, 'hello', { type: 'first_contact' });
    const first = startRun({ spawn: jest.fn() });
    await drainMicrotasks();
    expect(first.logs.some((line) => /carrying 1 greeting/.test(line))).toBe(true);
    first.handle.stop();
    await drainMicrotasks();
    expect(server.releases.flat()).toEqual([ID.hello]);
    expect(server.status(ID.hello)).toBe('pending');
  });

  test('against a server without the release route, a stop still ends cleanly and says where the events went', async () => {
    const server = inbox({ releaseRoute: false });
    server.add(ID.old, 'older server');
    const first = startRun({ spawn: jest.fn().mockRejectedValue(QUOTA()) });
    await drainMicrotasks();
    first.handle.stop();
    await drainMicrotasks();
    expect(server.status(ID.old)).toBe('delivered');
    expect(first.logs.some((line) => /could not hand back 1 event .*requeue/.test(line))).toBe(true);
  });

  test('an event at the redelivery ceiling is left to the requeue, and the log says so', async () => {
    const server = inbox({ atCeiling: [ID.poison] });
    server.add(ID.poison, 'fails every turn');
    server.add(ID.fine, 'an ordinary ask');
    const first = startRun({ spawn: jest.fn().mockRejectedValue(QUOTA()) });
    await drainMicrotasks();
    await first.handle.stop();
    expect(server.status(ID.poison)).toBe('delivered');
    expect(server.status(ID.fine)).toBe('pending');
    expect(first.logs.some((line) => /handed back 1 event/.test(line))).toBe(true);
    expect(first.logs.some((line) => (
      /1 event left to the requeue \(at the redelivery ceiling\)/.test(line)
    ))).toBe(true);
  });
});

describe('stop() resolves after the hand-back', () => {
  test.each([
    ['idle in the circuit wait', false],
    ['with a turn in flight', true],
  ])('%s: the promise settles only once the release POST has answered', async (_label, midTurn) => {
    const server = inbox();
    server.add(ID.wait, 'held when the stop came');
    const turn = deferred();
    const spawn = midTurn ? jest.fn(() => turn.promise) : jest.fn().mockRejectedValue(QUOTA());
    const first = startRun({ spawn });
    await drainMicrotasks();
    const openReleases = server.holdReleases();
    let settled = false;
    const stopped = first.handle.stop().then(() => { settled = true; });
    if (midTurn) turn.reject(QUOTA());
    await drainMicrotasks();
    expect(server.post.mock.calls.some(([route]) => String(route).endsWith('/events/release'))).toBe(true);
    expect(settled).toBe(false);
    openReleases();
    await stopped;
    expect(server.status(ID.wait)).toBe('pending');
  });
});

describe('a stop keeps what the failure path would have let go', () => {
  const CRASH = () => new Error('claude exited with code 1:');
  // A private wake is its own group, so a same-pod digest claimed with it on
  // the same page lands in a later, digest-only group.
  const addAskAndDigest = (server) => {
    server.add(ID.ask, 'private consult', {
      type: 'agent.ask',
      payload: { requestId: 'ask/1', fromAgent: 'planner', fromInstanceId: 'default', question: 'private consult' },
    });
    server.add(ID.digest, 'ambient context', { type: 'message.posted', deliveryMode: 'digest' });
  };

  test('a stop during the third failing turn hands the event back instead of striking it out', async () => {
    const server = inbox();
    server.add(ID.third, 'fails three times');
    const third = deferred();
    const spawn = jest.fn()
      .mockRejectedValueOnce(CRASH())
      .mockRejectedValueOnce(CRASH())
      .mockImplementationOnce(() => third.promise);
    const first = startRun({ spawn });
    await drainMicrotasks();
    await first.fireNext();
    await first.fireNext();
    expect(spawn).toHaveBeenCalledTimes(3);

    const stopped = first.handle.stop();
    third.reject(CRASH());
    await stopped;
    expect(server.releases.flat()).toEqual([ID.third]);
    expect(server.status(ID.third)).toBe('pending');
    expect(first.errors.at(-1).releasedCount).toBe(0);
  });

  test('a stop before a page ran hands back a later digest-only group too, for the next run', async () => {
    const server = inbox();
    addAskAndDigest(server);
    const openPoll = server.holdNextPoll();
    const first = startRun({ spawn: jest.fn() });
    await drainMicrotasks();
    const stopped = first.handle.stop();
    openPoll();
    await stopped;
    expect(server.releases.flat().sort()).toEqual([ID.ask, ID.digest].sort());

    const second = startRun({ spawn: jest.fn().mockResolvedValue({ text: 'answered' }) });
    try {
      await drainMicrotasks();
      expect(server.polls[1]).toEqual([ID.ask, ID.digest]);
    } finally { second.handle.stop(); }
  });

  test('a turn that fails after the stop hands back a later digest-only group too', async () => {
    const server = inbox();
    addAskAndDigest(server);
    const turn = deferred();
    const first = startRun({ spawn: jest.fn(() => turn.promise) });
    await drainMicrotasks();
    const stopped = first.handle.stop();
    turn.reject(QUOTA());
    await stopped;
    expect(server.releases.flat().sort()).toEqual([ID.ask, ID.digest].sort());
  });

  test('a running failure still leaves a digest-only group out of its retry', async () => {
    const server = inbox();
    addAskAndDigest(server);
    const first = startRun({ spawn: jest.fn().mockRejectedValue(QUOTA()) });
    try {
      await drainMicrotasks();
      expect(first.errors.at(-1)).toMatchObject({ heldCount: 1, releasedCount: 0 });
      expect(server.releases).toEqual([]);
    } finally { first.handle.stop(); }
  });
});

describe('every claimed event this tick left unsettled goes back on a stop', () => {
  const refusal = () => new Error(
    'codex turn failed: This content was flagged for possible cybersecurity risk. '
    + 'If this seems wrong, try rephrasing your request.',
  );

  test('a stop during refusal isolation hands back the unreached item and the batch\'s digest', async () => {
    const server = inbox();
    server.add(ID.wake_a, 'first ask');
    server.add(ID.wake_b, 'second ask');
    server.add(ID.batch_digest, 'ambient context', { deliveryMode: 'digest' });
    const isolated = deferred();
    const spawn = jest.fn()
      .mockRejectedValueOnce(refusal())
      .mockImplementationOnce(() => isolated.promise);
    const first = startRun({ spawn });
    await drainMicrotasks();
    expect(spawn).toHaveBeenCalledTimes(2);

    const stopped = first.handle.stop();
    isolated.resolve({ text: 'first answered' });
    await stopped;
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(ackedIds(server)).toEqual([ID.wake_a]);
    expect(server.releases.flat().sort()).toEqual([ID.wake_b, ID.batch_digest].sort());
    expect(server.status(ID.batch_digest)).toBe('pending');
  });

  test('a digest-only group sorted behind a stopped turn goes back with it', async () => {
    const server = inbox();
    server.add(ID.other_digest, 'ambient elsewhere', { podId: 'pod-other', deliveryMode: 'digest' });
    server.add(ID.wake_c, 'a real ask');
    const turn = deferred();
    const first = startRun({ spawn: jest.fn(() => turn.promise) });
    await drainMicrotasks();

    const stopped = first.handle.stop();
    turn.resolve({ text: 'answered' });
    await stopped;
    expect(ackedIds(server)).toEqual([ID.wake_c]);
    expect(server.releases.flat()).toEqual([ID.other_digest]);
  });

  test('a digest-only group is still held when the tick ends, so a stop after it hands the group back', async () => {
    const server = inbox();
    server.add(ID.other_digest, 'ambient elsewhere', { podId: 'pod-other', deliveryMode: 'digest' });
    server.add(ID.wake_c, 'a real ask');
    const first = startRun({ spawn: jest.fn().mockResolvedValue({ text: 'answered' }) });
    await drainMicrotasks();
    expect(ackedIds(server)).toEqual([ID.wake_c]);
    expect(server.releases).toEqual([]);

    await first.handle.stop();
    expect(server.releases.flat()).toEqual([ID.other_digest]);
  });

  test('a stale ack that ends the run hands back the later groups of its page', async () => {
    const server = inbox({ staleAcks: [ID.stale_ask] });
    server.add(ID.stale_ask, 'private consult', {
      type: 'agent.ask',
      payload: { requestId: 'ask/2', fromAgent: 'planner', fromInstanceId: 'default', question: 'private consult' },
    });
    // A second ask, because a person's wake would be sorted ahead of the first.
    server.add(ID.wake_c, 'waits behind the ask', {
      type: 'agent.ask',
      payload: { requestId: 'ask/3', fromAgent: 'planner', fromInstanceId: 'default', question: 'waits behind the ask' },
    });
    const first = startRun({ spawn: jest.fn().mockResolvedValue({ text: 'done' }) });
    await drainMicrotasks();
    expect(first.scheduled).toHaveLength(0);
    expect(server.releases.flat()).toEqual([ID.wake_c]);
    expect(server.status(ID.wake_c)).toBe('pending');
  });

  test('a pod batch that fails after the stop hands back a later digest-only group too', async () => {
    const server = inbox();
    server.add(ID.wake_c, 'a real ask');
    server.add(ID.other_digest, 'ambient elsewhere', { podId: 'pod-other', deliveryMode: 'digest' });
    const turn = deferred();
    const first = startRun({ spawn: jest.fn(() => turn.promise) });
    await drainMicrotasks();
    const stopped = first.handle.stop();
    turn.reject(QUOTA());
    await stopped;
    expect(server.releases.flat().sort()).toEqual([ID.wake_c, ID.other_digest].sort());
  });

  test('a stop during the lease renewal keeps the event that just struck out', async () => {
    const server = inbox();
    server.add(ID.third, 'fails three times', { podId: 'pod-other' });
    server.add(ID.wake_c, 'never reached');
    const crash = () => new Error('claude exited with code 1:');
    const first = startRun({ spawn: jest.fn().mockRejectedValue(crash()) });
    await drainMicrotasks();
    await first.fireNext();
    const openRenew = server.holdRenews();
    await first.fireNext();
    const stopped = first.handle.stop();
    openRenew();
    await stopped;
    expect(server.releases.flat().sort()).toEqual([ID.third, ID.wake_c].sort());
  });
});
