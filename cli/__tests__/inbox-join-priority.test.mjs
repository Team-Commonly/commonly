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
 * These tests pin (1): the greeting is held one interval, and when a mention
 * lands in that window it leads the same turn. (2) is a separate change to a
 * contract this suite does not own, measured and filed on its own row.
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

// Runs the loop for a bounded number of ticks and records the delay the loop
// asked for after each one, which is the latency a waiting person pays.
const runTicks = async ({ pages, ticks = 2, spawn }) => {
  const delays = [];
  let pageIndex = 0;
  const mockGet = jest.fn(async (routePath) => {
    if (String(routePath).includes('/events')) {
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex += 1;
      return page;
    }
    return {};
  });
  const mockPost = jest.fn().mockResolvedValue({});
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
  return { delays, mockGet, mockPost };
};

describe('a waiting person outranks the seat\'s own join turn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('the held greeting waits one interval rather than spinning', async () => {
    const spawn = jest.fn(async () => ({ text: 'on it' }));
    const { delays } = await runTicks({
      pages: [
        { events: [joinEvent], inboxCount: 1 },
        { events: [], inboxCount: 0 },
        { events: [], inboxCount: 0 },
      ],
      ticks: 2,
      spawn,
    });

    // The hold is what gives a person time to type; it must not become a
    // tight loop, and it must not spawn the greeting on the held tick.
    expect(delays[0]).toBe(INTERVAL);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('holds a lone greeting one tick so a waiting mention leads the same turn', async () => {
    const spawn = jest.fn(async () => ({ text: 'on it' }));
    const { mockGet } = await runTicks({
      pages: [
        { events: [joinEvent], inboxCount: 1 },
        { events: [joinEvent, mentionEvent], inboxCount: 2 },
        { events: [], inboxCount: 0 },
      ],
      ticks: 2,
      spawn,
    });

    expect(mockGet).toHaveBeenCalledWith(
      '/api/agents/runtime/events',
      expect.objectContaining({ agentName: 'my-stub' }),
    );
    // One turn, not two: the greeting waited for the person rather than
    // spending a spawn ahead of them.
    expect(spawn).toHaveBeenCalledTimes(1);
    const prompt = spawn.mock.calls[0][0];
    expect(prompt).toContain('Event 1/2: chat.mention');
    expect(prompt).toContain('Event 2/2: first_contact');
    expect(prompt.indexOf('can you summarise this repo?'))
      .toBeLessThan(prompt.indexOf('A human just added you to this workspace.'));
  });

  test('still greets on the next tick when nobody is waiting', async () => {
    const spawn = jest.fn(async () => ({ text: 'hello' }));
    const { mockPost } = await runTicks({
      pages: [
        { events: [joinEvent], inboxCount: 1 },
        { events: [joinEvent], inboxCount: 1 },
        { events: [], inboxCount: 0 },
      ],
      ticks: 2,
      spawn,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toContain('first_contact');
    // The deferred greeting is still acked once it has been taken.
    expect(mockPost.mock.calls.some(([p]) => String(p).includes('/events/evt-join/ack'))).toBe(true);
  });
});
