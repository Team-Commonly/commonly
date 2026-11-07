import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

// TASK-294: a workspace seat re-reads its pods before every turn, and a turn
// it cannot confirm private runs as a public seat in the scratch folder.
const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-workspace-turn-test-'));
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-workspace-turn-repo-'));

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

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

const scratchDir = path.join(os.tmpdir(), 'commonly-agents', 'workspace-stub');
const privatePod = {
  podId: 'pod-ws', publicRead: false, communityListed: false, joinPolicy: 'invite-only',
};
const noopTimeout = () => 0;
const drain = async () => {
  for (let i = 0; i < 24; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let eventCount = 0;
const runOneTurn = async ({
  environment, installations, newSessionId, adapterName = 'stub', spawns = 1, detectBwrapImpl, codexUnconfined,
  spawnError, eventType = 'chat.mention', eventPayload = { content: 'read the repo' }, spawnCredentialLeaseFactory,
}) => {
  eventCount += 1;
  const eventId = `ws-event-${eventCount}`;
  const get = jest.fn(async (route) => {
    if (route === '/api/agents/runtime/events') {
      return {
        events: [{
          _id: eventId, type: eventType, podId: 'pod-ws', agentName: 'workspace-stub',
          payload: eventPayload,
        }],
      };
    }
    if (route === '/api/agents/runtime/installations') {
      if (installations instanceof Error) throw installations;
      return { installations };
    }
    if (route === '/api/agents/runtime/memory') return { sections: { long_term: { content: 'notes from the project' } } };
    if (route.endsWith('/messages')) return { messages: [] };
    if (route.endsWith('/context')) return { focus: { podId: 'pod-ws', revision: 0, focus: null } };
    return {};
  });
  const post = jest.fn().mockResolvedValue({});
  createClient.mockReturnValue({ get, post });
  const spawn = spawnError ? jest.fn().mockRejectedValue(spawnError)
    : jest.fn().mockResolvedValue({ text: 'done', newSessionId });
  const logs = [];
  const { stop } = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_workspace',
    adapter: { name: adapterName, detect: stubAdapter.detect, spawn },
    agentName: 'workspace-stub',
    environment,
    workspacePath: workspaceDir,
    log: (line) => logs.push(line),
    setTimeoutImpl: noopTimeout,
    detectBwrapImpl,
    codexUnconfined,
    ...(spawnCredentialLeaseFactory ? { spawnCredentialLeaseFactory } : {}),
  });
  await drain();
  stop();
  expect(spawn).toHaveBeenCalledTimes(spawns);
  return { ctx: spawn.mock.calls[0]?.[1], get, post, logs };
};

describe('performRun workspace turn placement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('a workspace seat whose pods are all private reads its workspace', async () => {
    const { ctx, get, logs } = await runOneTurn({
      environment: { sandbox: { trust: 'workspace' } },
      installations: [privatePod],
    });
    expect(ctx.cwd).toBe(workspaceDir);
    expect(ctx.environment.sandbox.trust).toBe('workspace');
    // Skills are copied here, not into the project (the claude adapter).
    expect(ctx.skillMountDir).toBe(scratchDir);
    expect(get).toHaveBeenCalledWith('/api/agents/runtime/installations', {}, {
      signal: expect.any(AbortSignal),
    });
    expect(logs.some((line) => line.includes('public seat'))).toBe(false);
    expect(ctx.memoryWithheld).toBe(false);
    expect(ctx.memoryLongTerm).toBe('notes from the project');
  });

  test('a turn that runs public never reads the seat\'s memory', async () => {
    const { ctx, get } = await runOneTurn({
      environment: { sandbox: { trust: 'workspace' } },
      installations: [privatePod, { podId: 'pod-open', publicRead: true, communityListed: false }],
    });
    expect(ctx.environment.sandbox.trust).toBe('public');
    expect(ctx.memoryWithheld).toBe(true);
    expect(ctx.memoryLongTerm).toBeUndefined();
    expect(get.mock.calls.some(([route]) => route === '/api/agents/runtime/memory')).toBe(false);
  });

  test('F145: a turn that runs public asks for no memory writes, and gets none whatever the mint says', async () => {
    const leases = [];
    const { ctx } = await runOneTurn({
      environment: { sandbox: { trust: 'workspace' } },
      installations: [privatePod, { podId: 'pod-open', publicRead: true, communityListed: false }],
      spawnCredentialLeaseFactory: (args) => {
        leases.push(args);
        return {
          open: async () => ({ token: 'cm_agent_child', credentialId: 'c1', source: 'spawn', ownerWoken: true }),
          close: async () => ({ revoked: true }),
        };
      },
    });
    expect(leases[0]).toEqual(expect.objectContaining({ publicSeat: true, eventIds: [] }));
    expect(ctx.memoryWithheld).toBe(true);
    expect(ctx).not.toHaveProperty('ownerWoken');
  });

  test('F145: a workspace turn in private pods is not a public seat', async () => {
    const leases = [];
    await runOneTurn({
      environment: { sandbox: { trust: 'workspace' } },
      installations: [privatePod],
      spawnCredentialLeaseFactory: (args) => {
        leases.push(args);
        return {
          open: async () => ({ token: 'cm_agent_child', credentialId: 'c1', source: 'spawn' }),
          close: async () => ({ revoked: true }),
        };
      },
    });
    expect(leases[0]).not.toHaveProperty('publicSeat');
  });

  test('a pod that turned public runs the turn as a public seat in the scratch folder', async () => {
    const { ctx, logs } = await runOneTurn({
      environment: { sandbox: { trust: 'workspace' } },
      installations: [privatePod, { podId: 'pod-open', publicRead: true, communityListed: false }],
    });
    expect(ctx.cwd).toBe(scratchDir);
    expect(fs.existsSync(scratchDir)).toBe(true);
    expect(ctx.environment.sandbox.trust).toBe('public');
    expect(logs).toContain(
      `this turn runs as a public seat in ${scratchDir}, because a pod it answers in is `
      + 'publicly readable or open to join, or did not report whether it is',
    );
  });

  test('a failed read of its pods degrades the turn the same way', async () => {
    const { ctx, logs } = await runOneTurn({
      environment: { sandbox: { trust: 'workspace' } },
      installations: Object.assign(new Error('boom'), { status: 503 }),
    });
    expect(ctx.cwd).toBe(scratchDir);
    expect(ctx.environment.sandbox.trust).toBe('public');
    expect(logs).toContain(
      `this turn runs as a public seat in ${scratchDir}, because its pods could not be read`,
    );
  });

  test('a public seat spawns as declared and does not re-read its pods', async () => {
    const { ctx, get } = await runOneTurn({
      environment: { sandbox: { trust: 'public' } },
      installations: [privatePod],
    });
    expect(ctx.cwd).toBe(workspaceDir);
    expect(ctx.environment.sandbox.trust).toBe('public');
    expect(get.mock.calls.some(([route]) => route === '/api/agents/runtime/installations')).toBe(false);
  });

  test('a public turn never resumes a conversation that read the workspace', async () => {
    const environment = { sandbox: { trust: 'workspace' } };
    await runOneTurn({ environment, installations: [privatePod], newSessionId: 'sess-ws' });
    const resumed = await runOneTurn({ environment, installations: [privatePod] });
    expect(resumed.ctx.sessionId).toBe('sess-ws');

    const degraded = await runOneTurn({
      environment,
      installations: [{ podId: 'pod-ws', publicRead: true, communityListed: true }],
    });
    expect(degraded.ctx.sessionId).toBeFalsy();
  });

  test('a refused public turn leaves the workspace thread it never resumed', async () => {
    const environment = { sandbox: { trust: 'workspace' } };
    await runOneTurn({ environment, installations: [privatePod], newSessionId: 'sess-ws' });

    await runOneTurn({
      environment,
      installations: [{ podId: 'pod-ws', publicRead: true, communityListed: true }],
      spawnError: new Error('codex turn failed: This content was flagged for possible cybersecurity risk.'),
    });

    const resumed = await runOneTurn({ environment, installations: [privatePod] });
    expect(resumed.ctx.sessionId).toBe('sess-ws');
  });
});

// TASK-027, then F96: a workspace turn placed public runs as a public seat,
// which on Linux needs bubblewrap. Since F96 the public jail carries Claude
// Code too, so the turn runs where bubblewrap does, and is refused before
// anything is read or spawned where it does not.
describe('performRun workspace turn placement for Claude Code on Linux', () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });
  afterEach(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));

  const posted = (post) => post.mock.calls.filter(([route]) => /\/messages$/.test(route));

  test('a private turn spawns in the workspace', async () => {
    const { ctx } = await runOneTurn({
      environment: { sandbox: { trust: 'workspace' } }, installations: [privatePod], adapterName: 'claude',
    });
    expect(ctx.cwd).toBe(workspaceDir);
    expect(ctx.environment.sandbox.trust).toBe('workspace');
  });

  const noBwrap = () => ({ available: false, error: 'bwrap not found on PATH.' });
  const bwrap = () => ({ available: true, path: 'bwrap' });

  test.each([
    ['its pod turned public', [privatePod, { podId: 'pod-open', publicRead: true, communityListed: false }],
      /because a pod it answers in is publicly readable/],
    ['a pod reports no visibility', [privatePod, { podId: 'pod-unknown', joinPolicy: 'invite-only' }],
      /did not report whether it is/],
  ])('on a host without bubblewrap, a turn is refused when %s, with nothing read, spawned or posted', async (_label, installations, why) => {
    const { get, post, logs } = await runOneTurn({
      environment: { sandbox: { trust: 'workspace' } }, installations, adapterName: 'claude', spawns: 0, detectBwrapImpl: noBwrap,
    });
    expect(logs.some((line) => /^turn refused, because /.test(line) && why.test(line)
      && /bubblewrap sandbox, which is not available here/.test(line))).toBe(true);
    expect(get.mock.calls.some(([route]) => route === '/api/agents/runtime/memory')).toBe(false);
    expect(posted(post)).toHaveLength(0);
  });

  test('with bubblewrap, a turn whose pod turned public runs as a public seat', async () => {
    const { ctx, logs } = await runOneTurn({
      environment: { sandbox: { trust: 'workspace' } },
      installations: [privatePod, { podId: 'pod-open', publicRead: true, communityListed: false }],
      adapterName: 'claude',
      detectBwrapImpl: bwrap,
    });
    expect(ctx.environment.sandbox.trust).toBe('public');
    expect(ctx.cwd).not.toBe(workspaceDir);
    expect(logs.some((line) => /^turn refused, because /.test(line))).toBe(false);
  });

  test('a failed read of its pods defers the turn for a retry instead of refusing it', async () => {
    const { get, post, logs } = await runOneTurn({
      environment: { sandbox: { trust: 'workspace' } },
      installations: Object.assign(new Error('boom'), { status: 503 }),
      adapterName: 'claude',
      spawns: 0,
      detectBwrapImpl: noBwrap,
    });
    expect(logs.some((line) => /turn deferred, because its pods could not be read: boom/.test(line)
      && /retrying 1 held event/.test(line))).toBe(true);
    expect(logs.some((line) => /^turn refused, because /.test(line))).toBe(false);
    expect(post.mock.calls.some(([route]) => /\/ack$/.test(route))).toBe(false);
    expect(get.mock.calls.some(([route]) => route === '/api/agents/runtime/memory')).toBe(false);
    expect(posted(post)).toHaveLength(0);
  });
});

describe('performRun: a Windows Codex run opted in on private pods (F187)', () => {
  const originalPlatform = process.platform;
  const seat = { model: 'm' };
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));
  const run = (installations, extra = {}) => runOneTurn({
    environment: seat, installations, adapterName: 'codex', codexUnconfined: true, ...extra,
  });

  test('every pod private: the turn reaches Codex with no sandbox block and no hostUnconfined', async () => {
    const { ctx } = await run([privatePod]);
    expect(ctx.environment.sandbox).toBeUndefined();
    expect(ctx.environment.model).toBe('m');
    expect(ctx.hostUnconfined).toBeUndefined();
  });

  test('a private ask on a pod turned open is answered with a refusal, not left to expire', async () => {
    const { post } = await run([{ ...privatePod, joinPolicy: 'open' }], {
      spawns: 0,
      eventType: 'agent.ask',
      eventPayload: { requestId: 'ask-1', from: 'other-seat', question: 'can you check this?', prompt: 'can you check this?' },
    });
    expect(post).toHaveBeenCalledWith('/api/agents/runtime/asks/ask-1/respond', {
      content: expect.stringContaining('this pod isn’t private'),
    });
  });

  test('a failed pod read refuses no ask: it stays unacked and comes back', async () => {
    const { post } = await run(new Error('offline'), {
      spawns: 0,
      eventType: 'agent.ask',
      eventPayload: { requestId: 'ask-2', from: 'other-seat', question: 'can you check this?', prompt: 'can you check this?' },
    });
    expect(post.mock.calls.filter(([route]) => /\/asks\//.test(route))).toHaveLength(0);
  });

  test.each([
    ['a pod turned open to join', [privatePod, { ...privatePod, joinPolicy: 'open' }]],
    ['a pod turned publicly readable', [{ ...privatePod, publicRead: true }]],
    ['a pod reports no visibility', [{ joinPolicy: 'invite-only' }]],
  ])('%s: the turn is refused with nothing read, spawned or posted', async (_label, installations) => {
    const { get, post, logs } = await run(installations, { spawns: 0 });
    expect(logs.some((line) => /^turn refused, because /.test(line)
      && /publicly readable or open to join/.test(line))).toBe(true);
    // The person already passed the flag, so the refusal must not offer it again.
    expect(logs.some((line) => /--unsandboxed/.test(line))).toBe(false);
    expect(logs.some((line) => /runs as a public seat/.test(line))).toBe(false);
    expect(get.mock.calls.some(([route]) => route === '/api/agents/runtime/memory')).toBe(false);
    expect(post.mock.calls.filter(([route]) => /\/messages$/.test(route))).toHaveLength(0);
  });

  test('a failed read of its pods defers the turn: it never spawns unconfined on a guess', async () => {
    const { post, logs } = await run(new Error('boom'), { spawns: 0 });
    expect(logs.some((line) => /turn deferred, because its pods could not be read: boom/.test(line))).toBe(true);
    expect(post.mock.calls.some(([route]) => /\/ack$/.test(route))).toBe(false);
  });

  test('without the opt-in, nothing here changes how a seat is placed', async () => {
    const { ctx } = await runOneTurn({
      environment: { model: 'm', sandbox: { trust: 'public' } }, installations: [privatePod], adapterName: 'codex',
    });
    expect(ctx.environment.sandbox).toEqual({ trust: 'public' });
  });
});
