/**
 * §12 C: a confined seat that a connector grant may reach runs with only the
 * shipped MCP servers. The server marks the seat narrowed on
 * GET /installations (`outsiderGrantNarrowed`); an answer without the field is
 * treated as narrowed, because this CLI publishes before that server change
 * deploys. Unconfined seats are not checked.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-outsider-mcp-test-'));

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
  OUTSIDER_GRANT_MCP_UNCONFINED, outsiderGrantMcpRefusal, unshippedMcpEntries,
} = await import('../src/lib/outsider-grant-mcp.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

afterAll(() => fs.rmSync(sessionsTmpDir, { recursive: true, force: true }));

const INSTANCE = 'http://localhost:5000';
const SHIPPED_COMMONLY = {
  name: 'commonly',
  command: ['npx', '-y', '@commonlyai/mcp@latest'],
  env: { COMMONLY_API_URL: '${COMMONLY_API_URL}', COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
};
const shippedBroker = (extra = {}) => ({
  name: 'commonly-grant-broker',
  transport: 'http',
  url: '${COMMONLY_API_URL}/api/mcp/grants/grant_1',
  headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
  ...extra,
});
// A server its owner installed on this machine: the shape auditDeclaredMcp
// admits when it equals an entry in the local token record.
const LOCAL = { name: 'notes', command: ['node', '/Users/ada/mcp/notes.js'] };
const publicSeat = (mcp) => ({ model: 'm', sandbox: { trust: 'public' }, mcp });

describe('the rule', () => {
  test('only the shipped Commonly server and a shipped broker pass, the byoNamed flag included', () => {
    const environment = publicSeat([SHIPPED_COMMONLY, shippedBroker({ byoNamed: true }), LOCAL]);
    expect(unshippedMcpEntries(environment, INSTANCE).map((s) => s.name)).toEqual(['notes']);
  });

  test('a broker with any other field, or pointed elsewhere, is not the shipped one', () => {
    const environment = publicSeat([
      shippedBroker({ byoNamed: 'yes' }),
      shippedBroker({ url: 'https://evil.example/api/mcp/grants/grant_1' }),
    ]);
    expect(unshippedMcpEntries(environment, INSTANCE)).toHaveLength(2);
  });

  test('a confined seat with a local server is refused while narrowed, and when the server does not say', () => {
    const environment = publicSeat([SHIPPED_COMMONLY, LOCAL]);
    const narrowed = outsiderGrantMcpRefusal({ environment, identity: { outsiderGrantNarrowed: true }, instanceUrl: INSTANCE });
    expect(narrowed).toMatchObject({ code: OUTSIDER_GRANT_MCP_UNCONFINED, names: ['notes'] });
    const missing = outsiderGrantMcpRefusal({ environment, identity: { installations: [] }, instanceUrl: INSTANCE });
    expect(missing).toMatchObject({ code: OUTSIDER_GRANT_MCP_UNCONFINED, names: ['notes'] });
    expect(missing.message).toContain('did not say');
    expect(outsiderGrantMcpRefusal({ environment, identity: null, instanceUrl: INSTANCE })).not.toBeNull();
  });

  test('only an explicit "not narrowed" lets a local server run', () => {
    const environment = publicSeat([SHIPPED_COMMONLY, LOCAL]);
    expect(outsiderGrantMcpRefusal({ environment, identity: { outsiderGrantNarrowed: false }, instanceUrl: INSTANCE })).toBeNull();
  });

  test('a legacy internal trust is read as public, as the broker guard reads it', () => {
    const environment = { sandbox: { trust: 'internal' }, mcp: [LOCAL] };
    expect(outsiderGrantMcpRefusal({ environment, identity: {}, instanceUrl: INSTANCE }))
      .toMatchObject({ code: OUTSIDER_GRANT_MCP_UNCONFINED, names: ['notes'] });
  });

  test('workspace trust is confined too', () => {
    const environment = { sandbox: { trust: 'workspace' }, mcp: [LOCAL] };
    expect(outsiderGrantMcpRefusal({ environment, identity: { outsiderGrantNarrowed: true }, instanceUrl: INSTANCE })).not.toBeNull();
  });

  test('an unconfined seat is not checked: its owner consented, and it holds a shell', () => {
    for (const environment of [{ mcp: [LOCAL] }, { sandbox: {}, mcp: [LOCAL] }, null]) {
      expect(outsiderGrantMcpRefusal({ environment, identity: { outsiderGrantNarrowed: true }, instanceUrl: INSTANCE })).toBeNull();
    }
  });
});

const DRAIN_DEPTH = 16;
const drain = async () => {
  for (let i = 0; i < DRAIN_DEPTH; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

const setup = ({ environment, installations }) => {
  let served = false;
  const mockGet = jest.fn(async (url) => {
    if (url === '/api/agents/runtime/installations') {
      if (installations instanceof Error) throw installations;
      return installations;
    }
    if (served) return { events: [] };
    served = true;
    return {
      events: [{
        _id: 'evt-1', type: 'chat.mention', podId: 'pod-abc', agentName: 'quill', instanceId: 'default',
        payload: { content: 'hello' },
      }],
    };
  });
  const mockPost = jest.fn().mockResolvedValue({});
  createClient.mockReturnValue({ get: mockGet, post: mockPost, del: jest.fn().mockResolvedValue({}) });
  const spawn = jest.fn(async () => ({ text: 'ok' }));
  const logs = [];
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
    log: (line) => logs.push(line),
    setTimeoutImpl: () => 0,
  });
  const installationsReads = () => mockGet.mock.calls.filter(([url]) => url === '/api/agents/runtime/installations').length;
  const ackFor = () => mockPost.mock.calls.find(([url]) => url.endsWith('/events/evt-1/ack'));
  return { handle, spawn, logs, installationsReads, ackFor };
};

describe('before each turn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('a confined seat with only the shipped servers runs on today\'s server, and asks it nothing', async () => {
    const run = setup({
      environment: publicSeat([SHIPPED_COMMONLY, shippedBroker({ byoNamed: true })]),
      installations: { installations: [] },
    });
    await drain();
    run.handle.stop?.();
    expect(run.spawn).toHaveBeenCalledTimes(1);
    expect(run.installationsReads()).toBe(0);
  });

  test('a confined seat with a local server is refused on today\'s server, where the field is missing', async () => {
    const run = setup({ environment: publicSeat([SHIPPED_COMMONLY, LOCAL]), installations: { installations: [] } });
    await drain();
    run.handle.stop?.();
    expect(run.spawn).not.toHaveBeenCalled();
    expect(run.logs.join('\n')).toContain(OUTSIDER_GRANT_MCP_UNCONFINED);
    expect(run.logs.join('\n')).toContain('notes');
    expect(run.ackFor()).toBeDefined();
  });

  test('the same seat runs once the server says no grant reaches it', async () => {
    const run = setup({
      environment: publicSeat([SHIPPED_COMMONLY, LOCAL]),
      installations: { outsiderGrantNarrowed: false, installations: [] },
    });
    await drain();
    run.handle.stop?.();
    expect(run.spawn).toHaveBeenCalledTimes(1);
  });

  test('and is refused when the server says one does', async () => {
    const run = setup({
      environment: publicSeat([SHIPPED_COMMONLY, LOCAL]),
      installations: { outsiderGrantNarrowed: true, installations: [] },
    });
    await drain();
    run.handle.stop?.();
    expect(run.spawn).not.toHaveBeenCalled();
    expect(run.ackFor()).toBeDefined();
  });

  test('a failed read defers the turn: nothing spawns and the event is not acked', async () => {
    const run = setup({
      environment: publicSeat([SHIPPED_COMMONLY, LOCAL]),
      installations: Object.assign(new Error('socket hang up'), { status: 503 }),
    });
    await drain();
    run.handle.stop?.();
    expect(run.spawn).not.toHaveBeenCalled();
    expect(run.ackFor()).toBeUndefined();
  });
});
