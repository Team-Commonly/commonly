/**
 * poll-after-turn.test.mjs — TASK-343
 *
 * A turn is when new events pile up. Poll shortly after it ends, while
 * collecting notices that arrive mid-turn into one inbox read.
 *
 * A successful turn waits three seconds before reading again so notices that
 * arrived mid-turn can be collected in one inbox read. An idle poll, or a
 * batch that spawned nothing, keeps the normal interval.
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
const POST_TURN_BATCH_MS = 3000;

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

describe('the loop batches notices after a turn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('a turn that answered somebody waits three seconds before polling', async () => {
    const spawn = jest.fn(async () => ({ text: 'looking now' }));
    const { delays } = await delayAfterOneTick({
      page: { events: [mention()], inboxCount: 1 },
      spawn,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([POST_TURN_BATCH_MS]);
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
