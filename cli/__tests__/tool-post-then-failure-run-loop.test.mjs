/**
 * F336. A pi turn answered through a tool (commonly_post_message), then failed
 * with no status ("fetch failed") and exited 0. The adapter can't see the post,
 * so it hands the failure to the run loop on the result. These arms pin what
 * the run loop does with it:
 *   - the agent posted: the turn delivered, and it is not re-run (a retry would
 *     answer the same message twice);
 *   - it did not: the failure is thrown like a spawn failure, so it is retried.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-f336-test-'));

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

const POD_ID = '6a8f6dc7a1dccf2e02f31016';

const mention = () => ({
  _id: 'evt-1',
  type: 'chat.mention',
  podId: POD_ID,
  agentName: 'rhea',
  instanceId: 'default',
  payload: { content: '@rhea what changed in the last deploy?', messageId: '90001', username: 'team-member' },
});

const failedAfterTools = () => ({
  text: '',
  upstream: null,
  failure: new Error('pi exited with code 0: fetch failed'),
});

const setup = ({ postsDuringSpawn }) => {
  let polls = 0;
  let spawned = false;
  const before = [{ _id: 'm-before', isBot: false, self: false, username: 'team-member' }];
  const mockGet = jest.fn(async (route) => {
    if (route === '/api/agents/runtime/events') {
      polls += 1;
      return { events: polls === 1 ? [mention()] : [] };
    }
    if (route === '/api/agents/runtime/memory') return { sections: {} };
    if (route.endsWith('/messages')) {
      const own = { _id: 'm-own', isBot: true, self: true, username: 'rhea' };
      return { messages: spawned && postsDuringSpawn ? [own, ...before] : before };
    }
    return {};
  });
  const mockPost = jest.fn(async (route) => (
    String(route).endsWith('/claim') ? { claimed: true, expiresAt: 'later' } : {}
  ));
  createClient.mockReturnValue({ get: mockGet, post: mockPost, del: jest.fn().mockResolvedValue({}) });
  const spawn = jest.fn(async () => { spawned = true; return failedAfterTools(); });
  const errors = [];
  const logs = [];
  const handle = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
    agentName: 'rhea',
    retryJitterRatio: 0,
    claimYieldDelayMs: 0,
    sleepImpl: async () => {},
    log: (line) => logs.push(line),
    onError: (err) => errors.push(err),
    setTimeoutImpl: () => 0,
  });
  const acks = () => mockPost.mock.calls
    .filter(([route]) => String(route).endsWith('/ack'))
    .map(([route, body]) => ({ id: String(route).split('/').at(-2), result: body.result }));
  const echoes = () => mockPost.mock.calls
    .filter(([route]) => String(route).endsWith(`/pods/${POD_ID}/messages`));
  const retries = () => errors.filter((error) => error.code === 'agent_spawn_retry_scheduled');
  return {
    handle, spawn, acks, echoes, retries, logs,
  };
};

describe('a turn that fails after tool-only output (F336)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('that posted through a tool is delivered and not re-run', async () => {
    const run = setup({ postsDuringSpawn: true });
    await drainMicrotasks();
    run.handle.stop();

    expect(run.spawn).toHaveBeenCalledTimes(1);
    expect(run.retries()).toHaveLength(0);
    expect(run.acks()).toEqual([{ id: 'evt-1', result: expect.objectContaining({ outcome: 'posted' }) }]);
    expect(run.echoes()).toHaveLength(0);
    expect(run.logs.some((line) => /failed after a post of its own, so it is not retried: pi exited with code 0: fetch failed/.test(line))).toBe(true);
  });

  test('that posted nothing is failed like a spawn failure, so it is retried', async () => {
    const run = setup({ postsDuringSpawn: false });
    await drainMicrotasks();
    run.handle.stop();

    expect(run.retries()).toHaveLength(1);
    expect(run.acks()).toEqual([]);
    expect(run.echoes()).toHaveLength(0);
  });
});
