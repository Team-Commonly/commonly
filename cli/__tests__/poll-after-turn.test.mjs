/**
 * poll-after-turn.test.mjs — TASK-343
 *
 * A turn is exactly when new events pile up: the person who typed while the
 * adapter was running is already waiting by the time it finishes. The loop
 * nonetheless slept a full poll interval after every turn before looking
 * again, so that person paid the turn plus the interval.
 *
 * Carved out of TASK-289, which traded one interval of greeting latency to put
 * a waiting mention first; this removes the interval it was trading.
 *
 * The rule is narrow on purpose: only a batch that actually spawned looks
 * again at once. An idle poll, or a batch that spawned nothing, keeps the
 * interval — otherwise the loop spins.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-poll-after-turn-'));

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

const INTERVAL = 5000;

const mention = (overrides = {}) => ({
  _id: 'evt-mention',
  type: 'chat.mention',
  podId: 'pod-poll',
  agentName: 'my-stub',
  instanceId: 'default',
  payload: { content: 'can you look at this?', messageId: 'msg-1' },
  ...overrides,
});

const DRAIN_DEPTH = 16;
const drainMicrotasks = async () => {
  for (let i = 0; i < DRAIN_DEPTH; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

// One tick, then report the delay the loop asked for before the next one.
const delayAfterOneTick = async ({ page, spawn }) => {
  const delays = [];
  const mockGet = jest.fn(async (routePath) => (
    String(routePath).includes('/events') ? page : {}
  ));
  const mockPost = jest.fn().mockResolvedValue({});
  createClient.mockReturnValue({ get: mockGet, post: mockPost });

  const { stop } = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter: { name: 'codex', detect: stubAdapter.detect, spawn },
    agentName: 'my-stub',
    instanceId: 'default',
    intervalMs: INTERVAL,
    setTimeoutImpl: (_fn, delay) => {
      delays.push(delay);
      return 0;
    },
  });
  await drainMicrotasks();
  stop();
  return { delays, spawn, mockPost };
};

describe('the loop looks again as soon as a turn ends', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('a turn that answered somebody is followed by an immediate poll', async () => {
    const spawn = jest.fn(async () => ({ text: 'looking now' }));
    const { delays } = await delayAfterOneTick({
      page: { events: [mention()], inboxCount: 1 },
      spawn,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([0]);
  });

  test('an idle poll still waits the interval', async () => {
    const spawn = jest.fn(async () => ({ text: 'unused' }));
    const { delays } = await delayAfterOneTick({
      page: { events: [], inboxCount: 0 },
      spawn,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(delays).toEqual([INTERVAL]);
  });

  test('a batch that spawned nothing still waits the interval', async () => {
    const spawn = jest.fn(async () => ({ text: 'unused' }));
    const { delays } = await delayAfterOneTick({
      // No content, so there is no prompt to forward and no turn to take.
      page: { events: [mention({ _id: 'evt-empty', payload: {} })], inboxCount: 1 },
      spawn,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(delays).toEqual([INTERVAL]);
  });
});
