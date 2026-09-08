// ADR-026 Phase 2 slice 2: the supervision loop's decisions, with every side
// effect injected — no processes, no network, no real timers.
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

import {
  backoffMs,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  createDaemonSupervisor,
} from '../src/lib/daemon-supervisor.js';

const record = {
  machineDbId: '507f1f77bcf86cd799439011',
  machineId: 'machine-a',
  machineName: 'Mac A',
  instanceUrl: 'https://api.commonly.me',
  daemonToken: 'cm_daemon_secret',
};

const makeChild = () => {
  const child = new EventEmitter();
  child.kill = jest.fn();
  return child;
};

const boundRow = (over = {}) => ({
  agentName: 'wren-test',
  instanceId: 'default',
  state: 'bound',
  podIds: ['pod-1'],
  runtime: { runtimeType: 'wrapper', model: 'claude-opus-5' },
  ...over,
});

const makeHarness = ({ rows, tokens = {}, mintResponses = [], resolveAdapter = async () => 'claude', persistState = jest.fn() } = {}) => {
  const children = [];
  const timers = [];
  const client = {
    get: jest.fn(async () => ({ agents: rows() })),
    post: jest.fn(async (path, body) => {
      if (path === '/api/agent-binding/runtime-token') {
        const next = mintResponses.shift();
        if (next instanceof Error) throw next;
        return next || { token: 'cm_agent_minted' };
      }
      return { ok: true, path, body };
    }),
  };
  const saveToken = jest.fn((name, rec) => { tokens[name] = rec; });
  const supervisor = createDaemonSupervisor({
    record,
    client,
    spawnChild: jest.fn((name) => {
      const child = makeChild();
      children.push({ name, child });
      return child;
    }),
    loadToken: (name) => tokens[name] || null,
    saveToken,
    resolveAdapter: jest.fn(resolveAdapter),
    persistState,
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: jest.fn(),
  });
  return {
    supervisor, client, children, timers, saveToken, tokens, persistState,
  };
};

describe('backoff', () => {
  test('doubles from the base and caps', () => {
    expect(backoffMs(0)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(1)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffMs(20)).toBe(BACKOFF_MAX_MS);
  });
});

describe('tick', () => {
  test('adopts a requested row, mints its token, writes the record, and spawns', async () => {
    const { supervisor, client, children, saveToken } = makeHarness({
      rows: () => [boundRow({ state: 'requested' })],
    });
    await supervisor.tick();

    expect(client.post).toHaveBeenCalledWith('/api/agent-binding/adopt', {
      agentName: 'wren-test', instanceId: 'default',
    });
    expect(saveToken).toHaveBeenCalledWith('wren-test', expect.objectContaining({
      agentName: 'wren-test',
      runtimeToken: 'cm_agent_minted',
      instanceUrl: record.instanceUrl,
      podId: 'pod-1',
      adapter: 'claude',
    }));
    expect(children).toHaveLength(1);
    expect(supervisor.agentStates()).toEqual([
      expect.objectContaining({ agentName: 'wren-test', state: 'running', restarts: 0 }),
    ]);
  });

  test('a declared model lands in the token record environment', async () => {
    const { supervisor, saveToken } = makeHarness({
      rows: () => [boundRow({ runtime: { runtimeType: 'wrapper', model: 'opus' } })],
    });
    await supervisor.tick();
    expect(saveToken).toHaveBeenCalledWith('wren-test', expect.objectContaining({
      environment: { model: 'opus' },
    }));
  });

  test('no declared model — no environment key invented', async () => {
    const { supervisor, saveToken } = makeHarness({
      rows: () => [boundRow({ runtime: { runtimeType: 'wrapper' } })],
    });
    await supervisor.tick();
    expect(saveToken.mock.calls[0][1]).not.toHaveProperty('environment');
  });

  test('preserves full declared environment and runtime effort when minting', async () => {
    const environment = {
      version: 1,
      workspace: { path: '/tmp/commonly-test-workspace' },
      sandbox: { mode: 'workspace', trust: 'internal' },
      skills: { claude: ['common'] },
      mcp: [{ name: 'commonly', command: ['npx', 'commonly-mcp'] }],
      effort: 'high',
    };
    const { supervisor, saveToken } = makeHarness({
      rows: () => [boundRow({ runtime: { runtimeType: 'wrapper', model: 'opus', effort: 'high' }, environment })],
    });
    await supervisor.tick();
    expect(saveToken).toHaveBeenCalledWith('wren-test', expect.objectContaining({
      environment: { ...environment, model: 'opus' },
      workspacePath: '/tmp/commonly-test-workspace',
    }));
  });

  test('runtime-only model updates preserve a local full environment', async () => {
    const environment = {
      workspace: { path: './workspace' },
      sandbox: { mode: 'workspace', trust: 'internal' },
      mcp: [{ name: 'commonly', command: ['npx', 'commonly-mcp'] }],
    };
    const tokens = { 'wren-test': { agentName: 'wren-test', environment } };
    const { supervisor, saveToken } = makeHarness({
      rows: () => [boundRow({ runtime: { runtimeType: 'wrapper', model: 'sonnet' } })],
      tokens,
    });
    await supervisor.tick();
    expect(saveToken).toHaveBeenCalledWith('wren-test', expect.objectContaining({
      environment: { ...environment, model: 'sonnet' },
    }));
  });

  test('a model changed server-side updates the record and restarts the seat', async () => {
    let model = 'opus';
    const tokens = { 'wren-test': { agentName: 'wren-test', environment: { model: 'opus' } } };
    const { supervisor, children, saveToken } = makeHarness({
      rows: () => [boundRow({ runtime: { runtimeType: 'wrapper', model } })],
      tokens,
    });
    await supervisor.tick();
    expect(children).toHaveLength(1);
    expect(saveToken).not.toHaveBeenCalled();

    model = 'sonnet';
    await supervisor.tick();
    expect(saveToken).toHaveBeenCalledWith('wren-test', expect.objectContaining({
      environment: { model: 'sonnet' },
    }));
    // Restart flows through the exit event (D6): kill now, respawn on exit.
    expect(children[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(children).toHaveLength(1);
    children[0].child.emit('exit', 0);
    // desired stays true → exit handler schedules the respawn.
  });

  test('a declared adapter change updates the token record and restarts the seat', async () => {
    let adapter = 'claude';
    const tokens = { 'wren-test': { agentName: 'wren-test', adapter } };
    const { supervisor, client, children, saveToken } = makeHarness({
      rows: () => [boundRow({ runtime: { runtimeType: 'wrapper', adapter } })],
      tokens,
      resolveAdapter: async (runtime) => runtime?.adapter || 'claude',
    });
    await supervisor.tick();
    expect(children).toHaveLength(1);
    expect(saveToken).not.toHaveBeenCalled();

    adapter = 'codex';
    await supervisor.tick();
    expect(saveToken).toHaveBeenCalledWith('wren-test', expect.objectContaining({ adapter: 'codex' }));
    expect(children[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(client.post).not.toHaveBeenCalledWith('/api/agent-binding/runtime-token', expect.anything());
  });

  test('server runtime row wins when local adapter and model disagree', async () => {
    let runtime = { runtimeType: 'wrapper', adapter: 'codex', model: 'local-model' };
    const tokens = {
      'wren-test': {
        agentName: 'wren-test',
        adapter: 'codex',
        environment: { model: 'local-model' },
      },
    };
    const { supervisor, children, saveToken } = makeHarness({
      rows: () => [boundRow({ runtime })],
      tokens,
      resolveAdapter: async (rowRuntime) => rowRuntime?.adapter || 'claude',
    });

    await supervisor.tick();
    expect(children).toHaveLength(1);
    expect(saveToken).not.toHaveBeenCalled();

    // Adoption/reload is server-authoritative: the next process must consume
    // the row, never silently preserve stale local adapter/model values.
    runtime = { runtimeType: 'wrapper', adapter: 'claude', model: 'server-model' };
    await supervisor.tick();

    expect(saveToken).toHaveBeenCalledWith('wren-test', expect.objectContaining({
      adapter: 'claude',
      environment: { model: 'server-model' },
    }));
    expect(children[0].child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('a declared adapter that resolves to a fallback is rejected without spawning', async () => {
    const tokens = { 'wren-test': { agentName: 'wren-test', adapter: 'codex' } };
    const { supervisor, children, saveToken } = makeHarness({
      rows: () => [boundRow({ runtime: { runtimeType: 'wrapper', adapter: 'claude' } })],
      tokens,
      resolveAdapter: async () => 'codex',
    });
    await supervisor.tick();
    expect(children).toHaveLength(0);
    expect(saveToken).not.toHaveBeenCalled();
  });

  test('a row without a model never strips a hand-set environment', async () => {
    const tokens = { 'wren-test': { agentName: 'wren-test', environment: { model: 'opus' } } };
    const { supervisor, saveToken } = makeHarness({
      rows: () => [boundRow({ runtime: { runtimeType: 'wrapper' } })],
      tokens,
    });
    await supervisor.tick();
    expect(saveToken).not.toHaveBeenCalled();
  });

  test('an existing token file skips the mint entirely', async () => {
    const { supervisor, client, children } = makeHarness({
      rows: () => [boundRow()],
      tokens: { 'wren-test': { agentName: 'wren-test', runtimeToken: 'cm_agent_old' } },
    });
    await supervisor.tick();
    expect(client.post).not.toHaveBeenCalledWith('/api/agent-binding/runtime-token', expect.anything());
    expect(children).toHaveLength(1);
  });

  test('answers token_exists with an explicit rotate, never silently', async () => {
    const conflict = Object.assign(new Error('exists'), { status: 409, body: { code: 'token_exists' } });
    const { supervisor, client, children } = makeHarness({
      rows: () => [boundRow()],
      mintResponses: [conflict, { token: 'cm_agent_rotated' }],
    });
    await supervisor.tick();
    expect(client.post).toHaveBeenCalledWith('/api/agent-binding/runtime-token', expect.objectContaining({ rotate: true }));
    expect(children).toHaveLength(1);
  });

  test('a lost adopt race drops the row without spawning', async () => {
    const { supervisor, client, children } = makeHarness({ rows: () => [boundRow({ state: 'requested' })] });
    client.post.mockImplementation(async (path) => {
      if (path === '/api/agent-binding/adopt') {
        throw Object.assign(new Error('bound elsewhere'), { status: 409 });
      }
      return { token: 'cm_agent_minted' };
    });
    await supervisor.tick();
    expect(children).toHaveLength(0);
  });

  test('an agent that leaves the work list is stopped', async () => {
    let assigned = [boundRow()];
    const { supervisor, children } = makeHarness({
      rows: () => assigned,
      tokens: { 'wren-test': { agentName: 'wren-test' } },
    });
    await supervisor.tick();
    expect(children).toHaveLength(1);

    assigned = [];
    await supervisor.tick();
    expect(children[0].child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('publishes safe runtime metadata and process state to the local store', async () => {
    const persistState = jest.fn();
    const { supervisor } = makeHarness({
      rows: () => [boundRow({ runtime: { adapter: 'claude', model: 'fable', effort: 'high' } })],
      tokens: { 'wren-test': { agentName: 'wren-test' } },
      persistState,
    });
    await supervisor.tick();
    expect(supervisor.agentStates()).toEqual([
      expect.objectContaining({
        adapter: 'claude', model: 'fable', effort: 'high', state: 'running',
      }),
    ]);
    expect(persistState).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ agentName: 'wren-test', adapter: 'claude', model: 'fable' }),
    ]));
  });
});

describe('supervision (D6)', () => {
  test('respawns only from the exit event, with backoff and a crash count', async () => {
    const { supervisor, children, timers } = makeHarness({
      rows: () => [boundRow()],
      tokens: { 'wren-test': { agentName: 'wren-test' } },
    });
    await supervisor.tick();
    expect(children).toHaveLength(1);

    // A second tick while the child runs must NOT double-spawn.
    await supervisor.tick();
    expect(children).toHaveLength(1);

    children[0].child.emit('exit', 1);
    expect(supervisor.agentStates()[0]).toEqual(expect.objectContaining({ state: 'crashed', restarts: 1 }));
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(BACKOFF_BASE_MS);

    // A tick during backoff must not spawn either — the timer owns the respawn.
    await supervisor.tick();
    expect(children).toHaveLength(1);

    timers[0].fn();
    expect(children).toHaveLength(2);
    expect(supervisor.agentStates()[0].state).toBe('running');
  });

  test('a clean exit records stopped, and stop() terminates without respawn', async () => {
    const { supervisor, children, timers } = makeHarness({
      rows: () => [boundRow()],
      tokens: { 'wren-test': { agentName: 'wren-test' } },
    });
    await supervisor.tick();
    supervisor.stop();
    expect(children[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.agentStates()[0]).toEqual(expect.objectContaining({ state: 'stopped', pid: null }));
    children[0].child.emit('exit', 0);
    expect(timers).toHaveLength(0);
    expect(supervisor.agentStates()[0].state).toBe('stopped');
  });
});

describe('heartbeat', () => {
  test('reports the supervised states on the machine heartbeat', async () => {
    const { supervisor, client } = makeHarness({
      rows: () => [boundRow()],
      tokens: { 'wren-test': { agentName: 'wren-test' } },
    });
    await supervisor.tick();
    await supervisor.heartbeat();
    expect(client.post).toHaveBeenCalledWith(`/api/machines/${record.machineDbId}/heartbeat`, {
      agents: [expect.objectContaining({ agentName: 'wren-test', state: 'running' })],
    });
  });
});
