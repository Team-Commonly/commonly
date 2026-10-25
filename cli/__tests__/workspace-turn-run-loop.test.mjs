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
const runOneTurn = async ({ environment, installations, newSessionId }) => {
  eventCount += 1;
  const eventId = `ws-event-${eventCount}`;
  const get = jest.fn(async (route) => {
    if (route === '/api/agents/runtime/events') {
      return {
        events: [{
          _id: eventId, type: 'chat.mention', podId: 'pod-ws', agentName: 'workspace-stub',
          payload: { content: 'read the repo' },
        }],
      };
    }
    if (route === '/api/agents/runtime/installations') {
      if (installations instanceof Error) throw installations;
      return { installations };
    }
    if (route === '/api/agents/runtime/memory') return { sections: {} };
    if (route.endsWith('/messages')) return { messages: [] };
    if (route.endsWith('/context')) return { focus: { podId: 'pod-ws', revision: 0, focus: null } };
    return {};
  });
  createClient.mockReturnValue({ get, post: jest.fn().mockResolvedValue({}) });
  const spawn = jest.fn().mockResolvedValue({ text: 'done', newSessionId });
  const logs = [];
  const { stop } = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_workspace',
    adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
    agentName: 'workspace-stub',
    environment,
    workspacePath: workspaceDir,
    log: (line) => logs.push(line),
    setTimeoutImpl: noopTimeout,
  });
  await drain();
  stop();
  expect(spawn).toHaveBeenCalledTimes(1);
  return { ctx: spawn.mock.calls[0][1], get, logs };
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
});
