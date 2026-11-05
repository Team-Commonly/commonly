/**
 * inbox-join-priority.test.mjs — TASK-289
 *
 * A freshly connected seat takes a turn of its own for the `first_contact`
 * event. Measured on the published 0.1.108 Mac smoke (walk 5): the join turn
 * ran 01:44:09–01:44:23, a person's @mention landed at 01:44:10 while it was
 * running, and the answer came from the NEXT turn at 01:44:32–01:44:51 — 39.4 s
 * from mention to answer. Two of those gaps are the loop's, not the model's:
 *
 *   1. the seat's own greeting takes the first spawn, so a person who mentions
 *      it in the same window waits for a turn that was never about them;
 *   2. after any turn the loop sleeps a full poll interval before looking
 *      again, even though a turn is exactly when events pile up.
 *
 * These tests pin (1): the greeting is carried one interval, and when a mention
 * lands in that window it leads the same turn. (2) is a separate change to a
 * contract this suite does not own, measured and filed on its own row.
 *
 * The fixture models CLAIM-ONCE delivery, because that is what the kernel does:
 * claimPage reads `status: 'pending'` and marks each returned row `delivered`,
 * and later polls read only pending. An event a poll returned is therefore gone
 * from the inbox until garbageCollect requeues it ten-plus minutes later. An
 * earlier version of this fixture handed the greeting back on poll 2, which let
 * a client-side "leave it unacked" hold look like it worked (CTO review
 * 5623358693). A fixture that redelivers for free cannot test a hold.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-join-priority-'));

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

await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

const POD = 'pod-join';
const INTERVAL = 5000;

const joinEvent = {
  _id: 'evt-join',
  type: 'first_contact',
  podId: POD,
  agentName: 'my-stub',
  instanceId: 'default',
  payload: { content: 'A human just added you to this workspace.' },
};

const mentionEvent = {
  _id: 'evt-mention',
  type: 'chat.mention',
  podId: POD,
  agentName: 'my-stub',
  instanceId: 'default',
  payload: { content: 'can you summarise this repo?', messageId: 'msg-1' },
};

const DRAIN_DEPTH = 16;
const drainMicrotasks = async () => {
  for (let i = 0; i < DRAIN_DEPTH; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

// A claim-once inbox: each /events call returns everything currently pending
// and marks it taken, exactly like claimPage. `arrivals[i]` is what lands in
// the inbox before tick i.
const runTicks = async ({ arrivals, ticks = 2, spawn }) => {
  const delays = [];
  const acked = [];
  let pending = [];
  let poll = 0;
  const mockGet = jest.fn(async (routePath) => {
    if (String(routePath).includes('/events')) {
      pending = pending.concat(arrivals[poll] || []);
      poll += 1;
      const claimed = pending;
      pending = [];
      return { events: claimed, inboxCount: claimed.length };
    }
    return {};
  });
  const mockPost = jest.fn(async (routePath) => {
    const ack = String(routePath).match(/events\/([^/]+)\/ack/);
    if (ack) acked.push(ack[1]);
    return {};
  });
  createClient.mockReturnValue({ get: mockGet, post: mockPost });

  const adapter = { name: 'codex', detect: stubAdapter.detect, spawn };
  let fired = 0;
  const setTimeoutImpl = (fn, delay) => {
    delays.push(delay);
    if (fired < ticks - 1) {
      fired += 1;
      setImmediate(fn);
    }
    return 0;
  };

  const { stop } = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter,
    agentName: 'my-stub',
    instanceId: 'default',
    intervalMs: INTERVAL,
    setTimeoutImpl,
  });
  for (let i = 0; i < ticks; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await drainMicrotasks();
  }
  stop();
  return { delays, mockGet, mockPost, acked };
};

describe('a waiting person outranks the seat\'s own join turn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('the carried greeting waits one interval rather than spinning', async () => {
    const spawn = jest.fn(async () => ({ text: 'on it' }));
    const { delays, acked } = await runTicks({
      arrivals: [[joinEvent], []],
      ticks: 1,
      spawn,
    });

    // The carry is what gives a person time to type; it must not spawn on the
    // held tick, must not ack the greeting yet, and must not spin.
    expect(spawn).not.toHaveBeenCalled();
    expect(acked).toEqual([]);
    expect(delays).toEqual([INTERVAL]);
  });

  test('a mention arriving in the carry window leads the same turn', async () => {
    const spawn = jest.fn(async () => ({ text: 'on it' }));
    const { acked } = await runTicks({
      arrivals: [[joinEvent], [mentionEvent]],
      ticks: 2,
      spawn,
    });

    // One turn, not two: the greeting rode along behind the person's question.
    expect(spawn).toHaveBeenCalledTimes(1);
    const prompt = spawn.mock.calls[0][0];
    expect(prompt).toContain('Event 1/2: chat.mention');
    expect(prompt).toContain('Event 2/2: first_contact');
    expect(prompt.indexOf('can you summarise this repo?'))
      .toBeLessThan(prompt.indexOf('A human just added you to this workspace.'));
    // #3499's top-level line rides on the person's item in a shared turn too,
    // and never on the greeting, which has no message to thread under.
    const [mentionItem, greetingItem] = prompt.split('Event 2/2');
    expect(mentionItem).toContain('post your answer top-level');
    // 0.1.258 walk: the seat avoided threadRootId and threaded through
    // replyToMessageId, which the kernel files under the parent too.
    expect(mentionItem).toMatch(/threadRootId or as replyToMessageId/);
    expect(greetingItem).not.toContain('post your answer top-level');
    // Both are acked by that turn, including the one carried in memory.
    expect(acked.sort()).toEqual(['evt-join', 'evt-mention']);
  });

  // Answer first (2026-11-05, the 0.1.257 walk): a one-poll carry lost the
  // race. The mention landed 1.1 s after "polling", the greeting ran alone on
  // the next tick, and the answer waited behind it: +50.5 s, against +25.7 s on
  // a walk where the two shared a turn. The greeting is now carried for a
  // window (GREETING_HOLD_MS, 60 s: 12 polls at the default 5 s), so a person
  // who mentions a fresh seat any time in its first minute is answered first.
  const HOLD_POLLS = 60_000 / INTERVAL;

  test('a mention that lands several polls after the greeting still leads the one turn', async () => {
    const spawn = jest.fn(async () => ({ text: 'on it' }));
    const arrivals = [[joinEvent], [], [], [mentionEvent]];
    const { acked } = await runTicks({ arrivals, ticks: 4, spawn });

    expect(spawn).toHaveBeenCalledTimes(1);
    const prompt = spawn.mock.calls[0][0];
    expect(prompt).toContain('Event 1/2: chat.mention');
    expect(prompt).toContain('Event 2/2: first_contact');
    expect(acked.sort()).toEqual(['evt-join', 'evt-mention']);
  });

  test('a quiet connect does not greet inside the window, and never spins while it waits', async () => {
    const spawn = jest.fn(async () => ({ text: 'hello' }));
    const { acked, delays } = await runTicks({
      arrivals: [[joinEvent]],
      ticks: HOLD_POLLS,
      spawn,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(acked).toEqual([]);
    expect(new Set(delays)).toEqual(new Set([INTERVAL]));
  });

  test('a quiet connect greets once the window ends, with no redelivery to rely on', async () => {
    const spawn = jest.fn(async () => ({ text: 'hello' }));
    const { acked } = await runTicks({
      // Nothing arrives after the greeting, and the kernel never hands it back:
      // the only way it reaches the adapter is the in-memory carry.
      arrivals: [[joinEvent]],
      ticks: HOLD_POLLS + 1,
      spawn,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toContain('first_contact');
    expect(acked).toEqual(['evt-join']);
  });

  // Gate review of #3511: two pods' greetings carried in the same window must
  // both survive. Assigning the second group over the first dropped pod A's
  // greeting until the server's requeue, 10 to 20 minutes later.
  test('greetings for two pods carried in the same window both run, and the window is not shortened', async () => {
    const spawn = jest.fn(async () => ({ text: 'hello' }));
    const joinB = { ...joinEvent, _id: 'evt-join-b', podId: 'pod-other' };
    const { acked } = await runTicks({
      arrivals: [[joinEvent], [joinB]],
      ticks: HOLD_POLLS + 2,
      spawn,
    });

    expect(acked.sort()).toEqual(['evt-join', 'evt-join-b']);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test('a second pod\'s greeting does not spend the window early', async () => {
    const spawn = jest.fn(async () => ({ text: 'hello' }));
    const joinB = { ...joinEvent, _id: 'evt-join-b', podId: 'pod-other' };
    const { acked } = await runTicks({
      arrivals: [[joinEvent, joinB]],
      ticks: HOLD_POLLS,
      spawn,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(acked).toEqual([]);
  });

  test('only the connect-time greeting is held: once it has run, a later one is not carried', async () => {
    const spawn = jest.fn(async () => ({ text: 'hi' }));
    const later = { ...joinEvent, _id: 'evt-join-2' };
    const arrivals = [[joinEvent], [mentionEvent], [later]];
    const { acked } = await runTicks({ arrivals, ticks: 3, spawn });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][0]).toContain('first_contact');
    expect(acked.sort()).toEqual(['evt-join', 'evt-join-2', 'evt-mention']);
  });

});
