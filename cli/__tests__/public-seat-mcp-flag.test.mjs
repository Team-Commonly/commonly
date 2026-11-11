/**
 * A public seat's Commonly MCP server is told it serves a public seat, so it
 * writes nothing once Commonly is unreachable in its process
 * (lib/public-seat-mcp-flag.js, commonly-mcp/src/public-seat-gate.js).
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-public-seat-flag-test-'));

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
const { PUBLIC_SEAT_MCP_ENV, withPublicSeatMcpFlag } = await import('../src/lib/public-seat-mcp-flag.js');
const { ANSWERABLE_API_STATUSES } = await import('../src/lib/public-tool-error.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

afterAll(() => fs.rmSync(sessionsTmpDir, { recursive: true, force: true }));

const INSTANCE = 'http://localhost:5000';
const COMMONLY = {
  name: 'commonly',
  command: ['npx', '-y', '@commonlyai/mcp@latest'],
  env: { COMMONLY_API_URL: '${COMMONLY_API_URL}', COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
};
const BROKER = {
  name: 'commonly-grant-broker',
  transport: 'http',
  url: '${COMMONLY_API_URL}/api/mcp/grants/grant_1',
  headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
};

describe('withPublicSeatMcpFlag', () => {
  test('flags the shipped Commonly server on a copy, and nothing else', () => {
    const environment = { model: 'm', sandbox: { trust: 'public' }, mcp: [COMMONLY, BROKER] };
    const flagged = withPublicSeatMcpFlag(environment);
    expect(flagged.mcp[0].env).toEqual({ ...COMMONLY.env, [PUBLIC_SEAT_MCP_ENV]: '1' });
    expect(flagged.mcp[1]).toBe(BROKER);
    expect(environment.mcp[0].env[PUBLIC_SEAT_MCP_ENV]).toBeUndefined();
  });

  test('a recorded local checkout of the Commonly server is flagged too', () => {
    const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../commonly-mcp/src/index.js');
    const local = { name: 'commonly', command: ['node', entry], env: { COMMONLY_API_URL: '${COMMONLY_API_URL}' } };
    const other = { name: 'notes', command: ['node', path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js')] };
    const flagged = withPublicSeatMcpFlag({ sandbox: { trust: 'public' }, mcp: [local, other] });
    expect(flagged.mcp[0].env[PUBLIC_SEAT_MCP_ENV]).toBe('1');
    expect(flagged.mcp[1]).toBe(other);
  });

  test('an environment with no Commonly server comes back as it was', () => {
    for (const environment of [null, { model: 'm' }, { mcp: [BROKER] }]) {
      expect(withPublicSeatMcpFlag(environment)).toBe(environment);
    }
  });

  test('the answerable statuses equal the server\'s copy', () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../commonly-mcp/src/public-seat-gate.js'), 'utf8');
    const literal = /ANSWERABLE_API_STATUSES = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1];
    expect(literal).toBeDefined();
    expect(literal.split(',').map((s) => Number(s.trim())).sort()).toEqual([...ANSWERABLE_API_STATUSES].sort());
  });
});

const DRAIN_DEPTH = 16;
const drain = async () => {
  for (let i = 0; i < DRAIN_DEPTH; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

let delivery = 0;
const spawnedEnvironment = async (environment, installations = []) => {
  delivery += 1;
  let served = false;
  const mockGet = jest.fn(async (url) => {
    if (url === '/api/agents/runtime/installations') return { installations, outsiderGrantNarrowed: false };
    if (served) return { events: [] };
    served = true;
    return {
      events: [{
        _id: `evt-flag-${delivery}`, type: 'chat.mention', podId: 'pod-abc', agentName: 'quill', instanceId: 'default',
        payload: { content: 'hello', deliveryId: `delivery-flag-${delivery}` },
      }],
    };
  });
  createClient.mockReturnValue({ get: mockGet, post: jest.fn().mockResolvedValue({}), del: jest.fn().mockResolvedValue({}) });
  const spawn = jest.fn(async () => ({ text: 'ok' }));
  const handle = performRun({
    instanceUrl: INSTANCE,
    token: 'cm_agent_test',
    adapter: { name: 'claude', detect: stubAdapter.detect, spawn },
    agentName: 'quill',
    instanceId: 'default',
    podId: 'pod-abc',
    environment,
    readGrantBrokers: false,
    claimYieldDelayMs: 0,
    sleepImpl: async () => {},
    log: () => {},
    setTimeoutImpl: () => 0,
    // A turn placed public on Linux runs in bubblewrap; CI has none.
    detectBwrapImpl: () => ({ available: true, path: 'bwrap' }),
  });
  for (let i = 0; i < 400 && spawn.mock.calls.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
  await drain();
  handle.stop?.();
  expect(spawn).toHaveBeenCalledTimes(1);
  return spawn.mock.calls[0][1].environment;
};

describe('the spawn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('a public seat\'s Commonly server carries the flag, and the record does not', async () => {
    const environment = { model: 'm', sandbox: { trust: 'public' }, mcp: [COMMONLY] };
    const spawned = await spawnedEnvironment(environment);
    expect(spawned.mcp[0].env[PUBLIC_SEAT_MCP_ENV]).toBe('1');
    expect(environment.mcp[0].env[PUBLIC_SEAT_MCP_ENV]).toBeUndefined();
  });

  test('a legacy internal trust is a public seat, as the witness reads it', async () => {
    const spawned = await spawnedEnvironment({ model: 'm', sandbox: { trust: 'internal' }, mcp: [COMMONLY] });
    expect(spawned.mcp[0].env[PUBLIC_SEAT_MCP_ENV]).toBe('1');
  });

  test('a workspace seat in a private pod is not flagged, so it keeps writing through a blip', async () => {
    const privatePod = {
      podId: 'pod-abc', type: 'installation', publicRead: false, communityListed: false, joinPolicy: 'invite-only',
    };
    const spawned = await spawnedEnvironment({ model: 'm', sandbox: { trust: 'workspace' }, mcp: [COMMONLY] }, [privatePod]);
    expect(spawned.sandbox.trust).toBe('workspace');
    expect(spawned.mcp[0].env[PUBLIC_SEAT_MCP_ENV]).toBeUndefined();
  });

  // A workspace seat whose pods cannot be confirmed private runs that turn as a
  // public seat (TASK-294), so its server is flagged for that turn.
  test('a workspace seat placed public for the turn is flagged', async () => {
    const spawned = await spawnedEnvironment({ model: 'm', sandbox: { trust: 'workspace' }, mcp: [COMMONLY] }, []);
    expect(spawned.sandbox.trust).toBe('public');
    expect(spawned.mcp[0].env[PUBLIC_SEAT_MCP_ENV]).toBe('1');
  });

  test('an unconfined seat is not flagged', async () => {
    const environment = { model: 'm', mcp: [COMMONLY] };
    const spawned = await spawnedEnvironment(environment);
    expect(spawned).toBe(environment);
    expect(spawned.mcp[0].env[PUBLIC_SEAT_MCP_ENV]).toBeUndefined();
  });
});
