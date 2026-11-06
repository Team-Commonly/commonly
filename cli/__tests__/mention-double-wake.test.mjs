/**
 * Why a person and their own agent could get two answers (ADR-018 D6.5).
 *
 * The poll loop is serial and a page is one turn, so two mentions waiting
 * together were never the bug. Two turns need the first to be running when the
 * second lands: it then comes back on a later poll. The kernel marks that row,
 * and this wrapper needs no change to carry the mark: its prompt is
 * `payload.content`, as on every wrapper already deployed.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-double-wake-'));

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

const mention = (id, content) => ({
  _id: `evt-${id}`,
  type: 'chat.mention',
  podId: 'pod-walk',
  agentName: 'target',
  instanceId: 'default',
  payload: { content, messageId: `msg-${id}` },
});

const drain = async () => {
  for (let i = 0; i < 16; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

// Each entry of `pages` is one poll. The next tick runs only when asked for.
const run = async (pages) => {
  const queue = [...pages];
  const prompts = [];
  let nextTick = null;
  createClient.mockReturnValue({
    get: jest.fn(async (route) => (
      String(route).includes('/events') ? { events: queue.shift() || [] } : {}
    )),
    post: jest.fn().mockResolvedValue({}),
  });
  const { stop } = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter: {
      name: 'codex',
      detect: stubAdapter.detect,
      spawn: jest.fn(async (prompt) => {
        prompts.push(prompt);
        return { text: 'done', sessionId: null };
      }),
    },
    agentName: 'target',
    instanceId: 'default',
    intervalMs: 5000,
    setTimeoutImpl: (fn) => { nextTick = fn; return 0; },
  });
  await drain();
  for (let i = 1; i < pages.length; i += 1) {
    nextTick();
    // eslint-disable-next-line no-await-in-loop
    await drain();
  }
  stop();
  return prompts;
};

describe('two mentions of one agent', () => {
  test('waiting together, they are one turn', async () => {
    const prompts = await run([[mention(1, 'please review'), mention(2, 'the smoke check failed')]]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('please review');
    expect(prompts[0]).toContain('the smoke check failed');
  });

  test('the second landing while the first runs is a second turn, and the kernel\'s mark reaches it', async () => {
    const marked = '[This message reached you while your turn on message 1 was running. That turn could not see it.]\nthe smoke check failed';
    const prompts = await run([[mention(3, 'please review')], [mention(4, marked)]]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('smoke check');
    expect(prompts[1]).toContain('That turn could not see it.');
  });
});
