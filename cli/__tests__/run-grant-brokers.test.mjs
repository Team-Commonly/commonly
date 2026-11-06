/**
 * F150: a seat run with `commonly agent run` and no daemon reads its live grant
 * brokers from GET /api/agents/runtime/grant-brokers before each turn, merges
 * them into the environment the turn spawns with, and THEN applies
 * `withholdGrantBroker` — so the client-side refusal still holds (pi gets
 * nothing), and a grant revoked between turns is gone from the next turn.
 *
 * The daemon path (`readGrantBrokers: false`) never reads it: the daemon's
 * /assigned already merges the same projection into the seat's record.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-grant-brokers-test-'));

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
const { mergeGrantBrokers } = await import('../src/lib/grant-broker-guard.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

const DRAIN_DEPTH = 16;
const drainMicrotasks = async () => {
  for (let i = 0; i < DRAIN_DEPTH; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

afterAll(() => fs.rmSync(sessionsTmpDir, { recursive: true, force: true }));

const INSTANCE = 'http://localhost:5000';
const GRANTS_PATH = '/api/agents/runtime/grant-brokers';
const namedBroker = (grantId = 'grant_named') => ({
  name: 'commonly-grant-broker',
  transport: 'http',
  url: `\${COMMONLY_API_URL}/api/mcp/grants/${grantId}`,
  headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
  byoNamed: true,
});

let eventSeq = 0;
const nextEvent = () => {
  eventSeq += 1;
  return {
    _id: `evt-${eventSeq}`,
    type: 'chat.mention',
    podId: 'pod-abc',
    agentName: 'quill',
    instanceId: 'default',
    payload: { content: `hello ${eventSeq}` },
  };
};

/**
 * One seat; `grantReads` is the sequence of /grant-brokers answers, one per
 * read. Each poll returns one fresh event, so each scheduled cycle is one turn.
 */
const setup = ({
  adapterName = 'claude', environment = null, readGrantBrokers = true, grantReads = [],
} = {}) => {
  const reads = [...grantReads];
  const mockGet = jest.fn(async (url) => {
    if (url === GRANTS_PATH) return reads.length > 1 ? reads.shift() : reads[0];
    if (url === '/api/agents/runtime/installations') return { installations: [] };
    return { events: [nextEvent()] };
  });
  const mockPost = jest.fn().mockResolvedValue({});
  createClient.mockReturnValue({ get: mockGet, post: mockPost, del: jest.fn().mockResolvedValue({}) });
  const spawn = jest.fn(async () => ({ text: 'ok' }));
  const scheduled = [];
  const logs = [];
  const handle = performRun({
    instanceUrl: INSTANCE,
    token: 'cm_agent_test',
    adapter: { name: adapterName, detect: stubAdapter.detect, spawn },
    agentName: 'quill',
    instanceId: 'default',
    podId: 'pod-abc',
    environment,
    readGrantBrokers,
    claimYieldDelayMs: 0,
    sleepImpl: async () => {},
    log: (line) => logs.push(line),
    setTimeoutImpl: (callback) => { scheduled.push(callback); return 0; },
  });
  const nextCycle = async () => {
    const callback = scheduled.shift();
    if (callback) callback();
    await drainMicrotasks();
  };
  const spawnedMcp = (call) => (spawn.mock.calls[call]?.[1]?.environment?.mcp || []).map((server) => server.name);
  return { handle, mockGet, spawn, logs, nextCycle, spawnedMcp };
};

describe('mergeGrantBrokers', () => {
  test('returns the same environment when there is nothing to merge', () => {
    const environment = { model: 'm', mcp: [{ name: 'commonly' }] };
    expect(mergeGrantBrokers(environment, [])).toBe(environment);
    expect(mergeGrantBrokers(null, [])).toBeNull();
  });

  test('appends the brokers, replacing a same-name entry, as /assigned does', () => {
    const environment = {
      model: 'm',
      mcp: [{ name: 'commonly' }, { name: 'commonly-grant-broker', url: '${COMMONLY_API_URL}/api/mcp/grants/${COMMONLY_GRANT_ID}' }],
    };
    expect(mergeGrantBrokers(environment, [namedBroker()])).toEqual({
      model: 'm', mcp: [{ name: 'commonly' }, namedBroker()],
    });
    expect(mergeGrantBrokers(null, [namedBroker()])).toEqual({ mcp: [namedBroker()] });
  });
});

describe('agent run without the daemon (F150)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('reads its grant brokers, naming its adapter, and spawns with the named broker', async () => {
    const run = setup({ grantReads: [{ servers: [namedBroker()], refusal: null }] });
    await drainMicrotasks();
    run.handle.stop();
    expect(run.mockGet).toHaveBeenCalledWith(GRANTS_PATH, { adapter: 'claude' }, expect.anything());
    expect(run.spawn).toHaveBeenCalledTimes(1);
    expect(run.spawnedMcp(0)).toEqual(['commonly-grant-broker']);
  });

  // F175c: a pi seat that declares no sandbox is not confined, and naming
  // (the server's byoNamed flag) does not lift pi's reason.
  test('a pi seat with no sandbox still has the broker withheld, even when the server sent a named one', async () => {
    const run = setup({ adapterName: 'pi', grantReads: [{ servers: [namedBroker()], refusal: null }] });
    await drainMicrotasks();
    run.handle.stop();
    expect(run.spawn).toHaveBeenCalledTimes(1);
    expect(run.spawnedMcp(0)).toEqual([]);
    expect(run.logs.join('\n')).toContain('adapter_confines_public_only');
  });

  test('an unnamed broker on a seat with no sandbox is withheld by the seat\'s own guard', async () => {
    const { byoNamed, ...unnamed } = namedBroker();
    const run = setup({ grantReads: [{ servers: [unnamed], refusal: null }] });
    await drainMicrotasks();
    run.handle.stop();
    expect(byoNamed).toBe(true);
    expect(run.spawnedMcp(0)).toEqual([]);
    expect(run.logs.join('\n')).toContain('sandbox_absent');
  });

  test('a grant revoked between turns is gone from the next turn', async () => {
    const run = setup({
      environment: { model: 'claude-opus-5', mcp: [{ name: 'commonly', transport: 'stdio', command: ['commonly-mcp'] }] },
      grantReads: [{ servers: [namedBroker()], refusal: null }, { servers: [], refusal: null }],
    });
    await drainMicrotasks();
    expect(run.spawnedMcp(0)).toEqual(['commonly', 'commonly-grant-broker']);
    await run.nextCycle();
    run.handle.stop();
    expect(run.spawn).toHaveBeenCalledTimes(2);
    expect(run.spawnedMcp(1)).toEqual(['commonly']);
  });

  test('a failed read keeps the last answer rather than flapping', async () => {
    const run = setup({ grantReads: [{ servers: [namedBroker()], refusal: null }] });
    await drainMicrotasks();
    run.mockGet.mockImplementation(async (url) => {
      if (url === GRANTS_PATH) throw new Error('503');
      if (url === '/api/agents/runtime/installations') return { installations: [] };
      return { events: [nextEvent()] };
    });
    await run.nextCycle();
    run.handle.stop();
    expect(run.spawnedMcp(1)).toEqual(['commonly-grant-broker']);
  });

  test('a daemon seat never reads it: the daemon merges /assigned into its record', async () => {
    const run = setup({ readGrantBrokers: false, grantReads: [{ servers: [namedBroker()], refusal: null }] });
    await drainMicrotasks();
    run.handle.stop();
    expect(run.mockGet.mock.calls.map(([url]) => url)).not.toContain(GRANTS_PATH);
    expect(run.spawnedMcp(0)).toEqual([]);
  });
});
