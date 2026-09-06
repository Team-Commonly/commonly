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

const makeHarness = ({ rows, tokens = {}, mintResponses = [] } = {}) => {
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
    resolveAdapter: jest.fn(async () => 'claude'),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: jest.fn(),
  });
  return {
    supervisor, client, children, timers, saveToken, tokens,
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
