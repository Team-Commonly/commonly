/**
 * A seat with no sandbox runs as its owner, so it answers only while every pod
 * it is in is confirmed private, re-read before each turn
 * (lib/unconfined-seat-guard.js). There is no confined fallback: anything else
 * refuses the turn, and a read that fails defers it.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-unconfined-guard-test-'));

await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => sessionsTmpDir },
  homedir: () => sessionsTmpDir,
}));
await jest.unstable_mockModule('../src/lib/api.js', () => ({ createClient: jest.fn(), login: jest.fn() }));
await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const {
  UNCONFINED_TURN_REFUSAL, seatRunsUnconfined, unconfinedPodRefusalReason,
} = await import('../src/lib/unconfined-seat-guard.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

afterAll(() => fs.rmSync(sessionsTmpDir, { recursive: true, force: true }));

const PRIVATE = { podId: 'pod-abc', publicRead: false, communityListed: false, joinPolicy: 'invite-only' };
const OPEN = { ...PRIVATE, joinPolicy: 'open' };
const LISTED = { ...PRIVATE, communityListed: true };

describe('the rule', () => {
  test('no sandbox, mode none and an empty block run unconfined; a declared trust or mode does not', () => {
    for (const environment of [null, undefined, {}, { sandbox: {} }, { sandbox: { mode: 'none' } }]) {
      expect(seatRunsUnconfined({ environment, adapterName: 'claude' })).toBe(true);
    }
    for (const sandbox of [{ trust: 'public' }, { trust: 'workspace' }, { trust: 'internal' }, { mode: 'read-only' }]) {
      expect(seatRunsUnconfined({ environment: { sandbox }, adapterName: 'claude' })).toBe(false);
    }
  });

  test('every adapter that runs a CLI is checked; only the test stub is not', () => {
    for (const adapterName of ['claude', 'codex', 'opencode', 'qwen', 'goose', 'pi', 'dsh', 'hermes']) {
      expect(seatRunsUnconfined({ environment: null, adapterName })).toBe(true);
    }
    expect(seatRunsUnconfined({ environment: null, adapterName: 'stub' })).toBe(false);
  });

  test('only a list of confirmed-private pods runs; an empty, open, listed or unreadable one does not', () => {
    expect(unconfinedPodRefusalReason([PRIVATE])).toBeNull();
    expect(unconfinedPodRefusalReason(null)).toMatch(/could not be read/);
    for (const pods of [[], [PRIVATE, OPEN], [LISTED], [{ podId: 'legacy', publicRead: false, communityListed: false }]]) {
      expect(unconfinedPodRefusalReason(pods)).toMatch(/not confirmed private/);
    }
  });
});

const DRAIN_DEPTH = 24;
const drain = async () => {
  for (let i = 0; i < DRAIN_DEPTH; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

let runs = 0;
// Serves one event per entry in `podsPerTurn`, and answers each
// /installations read with the next entry (an Error throws).
const setup = ({ environment = null, podsPerTurn }) => {
  runs += 1;
  const reads = [...podsPerTurn];
  let served = 0;
  let polls = 0;
  const get = jest.fn(async (url) => {
    if (url === '/api/agents/runtime/installations') {
      const next = reads.length > 1 ? reads.shift() : reads[0];
      if (next instanceof Error) throw next;
      return { installations: next, outsiderGrantNarrowed: false };
    }
    // One event per poll, so each is its own turn.
    if (url === '/api/agents/runtime/events') {
      if (served >= podsPerTurn.length) return { events: [] };
      served += 1;
      return {
        events: [{
          _id: `evt-${runs}-${served}`, type: 'chat.mention', podId: 'pod-abc', agentName: 'quill', instanceId: 'default',
          payload: { content: `hello ${served}`, deliveryId: `delivery-${runs}-${served}` },
        }],
      };
    }
    return {};
  });
  const post = jest.fn().mockResolvedValue({});
  createClient.mockReturnValue({ get, post, del: jest.fn().mockResolvedValue({}) });
  const spawn = jest.fn(async () => ({ text: 'ok' }));
  const logs = [];
  const handle = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter: { name: 'claude', detect: stubAdapter.detect, spawn },
    agentName: 'quill',
    instanceId: 'default',
    podId: 'pod-abc',
    environment,
    readGrantBrokers: false,
    claimYieldDelayMs: 0,
    sleepImpl: async () => {},
    log: (line) => logs.push(line),
    // The next poll runs at once, a few times, so a later turn re-reads the pods.
    setTimeoutImpl: (fn) => {
      polls += 1;
      if (polls <= podsPerTurn.length + 1) setImmediate(fn);
      return 0;
    },
  });
  const acked = (n) => post.mock.calls.some(([url]) => url.endsWith(`/events/evt-${runs}-${n}/ack`));
  const reply = () => post.mock.calls.filter(([url]) => /\/messages$/.test(url));
  return { handle, spawn, logs, acked, reply, get };
};

describe('before each turn of a seat with no sandbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('runs while every pod is confirmed private', async () => {
    const run = setup({ podsPerTurn: [[PRIVATE]] });
    await drain();
    run.handle.stop?.();
    expect(run.spawn).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['open to join', [OPEN]],
    ['listed in Community', [LISTED]],
    ['a legacy pod with no joinPolicy', [{ podId: 'pod-abc', publicRead: false, communityListed: false }]],
    ['private beside an open one', [PRIVATE, OPEN]],
  ])('refuses a turn in a pod %s: nothing spawns and nothing is posted', async (_label, pods) => {
    const run = setup({ podsPerTurn: [pods] });
    await drain();
    run.handle.stop?.();
    expect(run.spawn).not.toHaveBeenCalled();
    expect(run.reply()).toHaveLength(0);
    expect(run.logs.join('\n')).toContain(UNCONFINED_TURN_REFUSAL);
  });

  test('a failed read defers the turn: nothing spawns and the event is not acked', async () => {
    const run = setup({ podsPerTurn: [Object.assign(new Error('socket hang up'), { status: 503 })] });
    await drain();
    run.handle.stop?.();
    expect(run.spawn).not.toHaveBeenCalled();
    expect(run.acked(1)).toBe(false);
  });

  test('re-reads every turn: a pod made joinable after the first turn refuses the second', async () => {
    const run = setup({ podsPerTurn: [[PRIVATE], [OPEN]] });
    await drain();
    await drain();
    run.handle.stop?.();
    expect(run.spawn).toHaveBeenCalledTimes(1);
    expect(run.logs.join('\n')).toContain(UNCONFINED_TURN_REFUSAL);
    const reads = run.get.mock.calls.filter(([url]) => url === '/api/agents/runtime/installations');
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  test('a seat that declares a sandbox is not refused by this check', async () => {
    const run = setup({ environment: { model: 'm', sandbox: { trust: 'public' } }, podsPerTurn: [[OPEN]] });
    await drain();
    run.handle.stop?.();
    expect(run.logs.join('\n')).not.toContain(UNCONFINED_TURN_REFUSAL);
  });
});
