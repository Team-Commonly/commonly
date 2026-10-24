import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const daemonTmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'commonly-daemon-test-'));

await jest.unstable_mockModule('os', () => {
  const actual = os;
  return {
    ...actual,
    default: { ...actual, homedir: () => daemonTmpHome },
    homedir: () => daemonTmpHome,
  };
});

const {
  daemonRecordPath,
  daemonStopPath,
  clearDaemonStop,
  loadDaemonStop,
  loadDaemonRecord,
  removeDaemonRecord,
  saveDaemonRecord,
  saveDaemonStop,
} = await import('../src/lib/daemon-store.js');
const {
  allowRevokedDaemonReplacement,
  daemonStatusErrorMessage,
  getDaemonMachineStatus,
  heartbeatDaemonMachine,
  registerDaemonMachine,
  unregisterDaemonMachine,
  formatSeatLine,
  resolveAdapterForRuntime,
} = await import('../src/commands/daemon.js');

const daemonRecord = {
  machineDbId: '507f1f77bcf86cd799439011',
  machineId: 'e7ee6405-bb61-4e62-85b9-7c7034086feb',
  machineName: 'Sam’s MacBook',
  instanceUrl: 'https://api.commonly.me',
  daemonToken: 'cm_daemon_secret',
  registeredAt: '2026-08-30T00:00:00.000Z',
};

beforeEach(() => {
  fs.rmSync(path.join(daemonTmpHome, '.commonly'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(daemonTmpHome, { recursive: true, force: true });
});

describe('daemon credential storage', () => {
  test('persists a private terminal verdict without the bearer and clears it after registration', () => {
    saveDaemonRecord(daemonRecord);
    saveDaemonStop(daemonRecord, 77);
    expect(loadDaemonStop(daemonRecord)).toEqual({ machineDbId: daemonRecord.machineDbId, exitCode: 77 });
    expect(fs.statSync(daemonStopPath()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(daemonStopPath(), 'utf8')).not.toContain(daemonRecord.daemonToken);
    expect(loadDaemonStop({ machineDbId: 'another' })).toBeNull();
    clearDaemonStop();
    expect(loadDaemonStop(daemonRecord)).toBeNull();
  });
  test('writes a private directory and 0600 bearer record', () => {
    saveDaemonRecord(daemonRecord);

    expect(loadDaemonRecord()).toEqual(daemonRecord);
    expect(fs.statSync(path.dirname(daemonRecordPath())).mode & 0o777).toBe(0o700);
    expect(fs.statSync(daemonRecordPath()).mode & 0o777).toBe(0o600);
  });

  test('rejects a malformed local credential instead of minting another machine', () => {
    fs.mkdirSync(path.dirname(daemonRecordPath()), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(daemonRecordPath()), 0o700);
    fs.writeFileSync(daemonRecordPath(), '{"machineDbId":"missing-token"}', 'utf8');
    fs.chmodSync(daemonRecordPath(), 0o600);
    expect(() => loadDaemonRecord()).toThrow(/credential file is invalid/i);
  });

  test('refuses to load a bearer from a group- or world-readable file', () => {
    saveDaemonRecord(daemonRecord);
    fs.chmodSync(daemonRecordPath(), 0o644);
    expect(() => loadDaemonRecord()).toThrow(/permissions are insecure/i);
  });

  test('refuses a writable credential directory even when the file is 0600', () => {
    saveDaemonRecord(daemonRecord);
    fs.chmodSync(path.dirname(daemonRecordPath()), 0o755);
    expect(() => loadDaemonRecord()).toThrow(/directory permissions are insecure/i);
  });

  test('removes the local record only when explicitly asked after revocation', () => {
    saveDaemonRecord(daemonRecord);
    expect(removeDaemonRecord()).toBe(true);
    expect(loadDaemonRecord()).toBeNull();
    expect(removeDaemonRecord()).toBe(false);
  });
});

describe('daemon machine calls', () => {
  const daemonError = (status, message) => Object.assign(new Error(message), {
    status,
    body: { message },
  });

  test('re-registers over a revoked local record without deleting it before secure replacement', async () => {
    saveDaemonRecord(daemonRecord);
    const revoked = daemonError(401, 'Machine access revoked');
    await expect(allowRevokedDaemonReplacement({
      existing: daemonRecord,
      client: { get: jest.fn().mockRejectedValue(revoked) },
    })).resolves.toBe('revoked');
    expect(loadDaemonRecord()).toEqual(daemonRecord);

    const replacement = {
      ...daemonRecord,
      machineDbId: '507f1f77bcf86cd799439022',
      daemonToken: 'cm_daemon_replacement',
    };
    const client = {
      post: jest.fn().mockResolvedValue({
        machine: {
          id: replacement.machineDbId,
          machineId: replacement.machineId,
          name: replacement.machineName,
        },
        daemonToken: replacement.daemonToken,
      }),
      del: jest.fn(),
    };
    await registerDaemonMachine({
      client, instanceUrl: replacement.instanceUrl, name: replacement.machineName,
    });
    expect(loadDaemonRecord()).toEqual(expect.objectContaining({
      machineDbId: replacement.machineDbId,
      daemonToken: replacement.daemonToken,
    }));
  });

  test('does not replace a live record or one whose server status cannot be determined', async () => {
    const live = { get: jest.fn().mockResolvedValue({ machine: {
      id: daemonRecord.machineDbId, machineId: daemonRecord.machineId,
    } }) };
    await expect(allowRevokedDaemonReplacement({ existing: daemonRecord, client: live }))
      .rejects.toThrow(/already registered/i);
    const unavailable = { get: jest.fn().mockRejectedValue(new Error('network unavailable')) };
    await expect(allowRevokedDaemonReplacement({ existing: daemonRecord, client: unavailable }))
      .rejects.toThrow(/network unavailable/i);
    const missing = { get: jest.fn().mockRejectedValue(daemonError(404, 'Machine not found')) };
    await expect(allowRevokedDaemonReplacement({ existing: daemonRecord, client: missing }))
      .resolves.toBe('missing');
  });

  test('a revoked status names the recovery command without exposing the bearer', () => {
    const message = daemonStatusErrorMessage(daemonError(401, 'Machine access revoked'));
    expect(message).toContain('commonly daemon register');
    expect(message).not.toContain(daemonRecord.daemonToken);
    expect(daemonStatusErrorMessage(daemonError(404, 'Machine not found'))).toContain('commonly daemon register');
  });

  test.each([
    ['HTML 404', { get: jest.fn().mockRejectedValue(daemonError(404, '<html>not found</html>')) }],
    ['JSON 200 without a machine', { get: jest.fn().mockResolvedValue({}) }],
    ['HTML 200', { get: jest.fn().mockResolvedValue({ message: '<html>ok</html>' }) }],
    ['wrong machine', { get: jest.fn().mockResolvedValue({ machine: { id: 'other', machineId: 'other' } }) }],
  ])('keeps the local key on ambiguous %s status', async (_label, client) => {
    saveDaemonRecord(daemonRecord);
    await expect(allowRevokedDaemonReplacement({ existing: daemonRecord, client })).rejects.toThrow();
    expect(loadDaemonRecord()).toEqual(daemonRecord);
  });

  test('persists the one-time daemon bearer without returning it in the machine view', async () => {
    const client = {
      post: jest.fn().mockResolvedValue({
        machine: {
          id: daemonRecord.machineDbId,
          machineId: daemonRecord.machineId,
          name: daemonRecord.machineName,
        },
        daemonToken: daemonRecord.daemonToken,
      }),
      del: jest.fn(),
    };
    const persist = jest.fn();

    const result = await registerDaemonMachine({
      client,
      instanceUrl: daemonRecord.instanceUrl,
      name: daemonRecord.machineName,
      persist,
    });

    expect(client.post).toHaveBeenCalledWith('/api/machines', { name: daemonRecord.machineName });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      machineDbId: daemonRecord.machineDbId,
      daemonToken: daemonRecord.daemonToken,
    }));
    expect(result.machine).not.toHaveProperty('daemonToken');
  });

  test('revokes the just-created machine if secure persistence fails', async () => {
    const client = {
      post: jest.fn().mockResolvedValue({
        machine: {
          id: daemonRecord.machineDbId,
          machineId: daemonRecord.machineId,
          name: daemonRecord.machineName,
        },
        daemonToken: daemonRecord.daemonToken,
      }),
      del: jest.fn().mockResolvedValue({ success: true }),
    };

    await expect(registerDaemonMachine({
      client,
      instanceUrl: daemonRecord.instanceUrl,
      name: daemonRecord.machineName,
      persist: () => { throw new Error('disk full'); },
    })).rejects.toThrow(/registration was revoked/i);
    expect(client.del).toHaveBeenCalledWith(`/api/machines/${daemonRecord.machineDbId}`);
  });

  test('names the immutable machine id if persistence and revocation both fail', async () => {
    const client = {
      post: jest.fn().mockResolvedValue({
        machine: {
          id: daemonRecord.machineDbId,
          machineId: daemonRecord.machineId,
          name: daemonRecord.machineName,
        },
        daemonToken: daemonRecord.daemonToken,
      }),
      del: jest.fn().mockRejectedValue(new Error('network unavailable')),
    };

    await expect(registerDaemonMachine({
      client,
      instanceUrl: daemonRecord.instanceUrl,
      name: daemonRecord.machineName,
      persist: () => { throw new Error('disk full'); },
    })).rejects.toThrow(daemonRecord.machineDbId);
  });

  test('heartbeats only the machine id held by the daemon credential record', async () => {
    const client = { post: jest.fn().mockResolvedValue({ machine: { status: 'online' } }) };
    await heartbeatDaemonMachine({ client, record: daemonRecord });
    expect(client.post).toHaveBeenCalledWith(`/api/machines/${daemonRecord.machineDbId}/heartbeat`);
  });

  test('status uses the daemon-scoped self route, not an owner machine listing', async () => {
    const client = {
      get: jest.fn().mockResolvedValue({
        machine: { id: daemonRecord.machineDbId, machineId: daemonRecord.machineId, status: 'online' },
      }),
    };
    await expect(getDaemonMachineStatus({ client, record: daemonRecord }))
      .resolves.toEqual({ id: daemonRecord.machineDbId, machineId: daemonRecord.machineId, status: 'online' });
    expect(client.get).toHaveBeenCalledWith('/api/machines/me');
  });

  test('revokes server-side before deleting the local credential', async () => {
    const remove = jest.fn();
    const client = { del: jest.fn().mockResolvedValue({ success: true }) };

    await unregisterDaemonMachine({ client, record: daemonRecord, remove });

    expect(client.del).toHaveBeenCalledWith(`/api/machines/${daemonRecord.machineDbId}`);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('keeps the local credential if server revocation fails', async () => {
    const remove = jest.fn();
    const client = { del: jest.fn().mockRejectedValue(new Error('network unavailable')) };

    await expect(unregisterDaemonMachine({ client, record: daemonRecord, remove }))
      .rejects.toThrow(/network unavailable/i);
    expect(remove).not.toHaveBeenCalled();
  });

  test('cleans up a local record when its machine was already removed server-side', async () => {
    const remove = jest.fn();
    const error = daemonError(404, 'Machine not found');
    const client = { del: jest.fn().mockRejectedValue(error) };

    await unregisterDaemonMachine({ client, record: daemonRecord, remove });

    expect(remove).toHaveBeenCalledTimes(1);
  });

  test.each([401, 403])('removes local state after owner DELETE %i only when the daemon key is revoked', async (status) => {
    const remove = jest.fn();
    const client = { del: jest.fn().mockRejectedValue(daemonError(status, 'Access denied')) };
    const daemonClient = { get: jest.fn().mockRejectedValue(daemonError(401, 'Machine access revoked')) };

    await expect(unregisterDaemonMachine({ client, daemonClient, record: daemonRecord, remove }))
      .resolves.toEqual({ removedRemotely: false });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(daemonClient.get).toHaveBeenCalledWith('/api/machines/me');
  });

  test.each([
    ['HTML 404', { get: jest.fn().mockRejectedValue(daemonError(404, '<html>not found</html>')) }],
    ['JSON 200 without a machine', { get: jest.fn().mockResolvedValue({}) }],
    ['HTML 200', { get: jest.fn().mockResolvedValue({ message: '<html>ok</html>' }) }],
  ])('keeps the local key after owner refusal and ambiguous %s proof', async (_label, daemonClient) => {
    saveDaemonRecord(daemonRecord);
    const remove = jest.fn();
    const client = { del: jest.fn().mockRejectedValue(daemonError(403, 'Access denied')) };
    await expect(unregisterDaemonMachine({ client, daemonClient, record: daemonRecord, remove }))
      .rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
    expect(loadDaemonRecord()).toEqual(daemonRecord);
  });

  test('keeps the local key if owner DELETE fails but the daemon key still works', async () => {
    const remove = jest.fn();
    const client = { del: jest.fn().mockRejectedValue(daemonError(401, 'Unauthorized')) };
    const daemonClient = { get: jest.fn().mockResolvedValue({ machine: {
      id: daemonRecord.machineDbId, machineId: daemonRecord.machineId,
    } }) };
    await expect(unregisterDaemonMachine({ client, daemonClient, record: daemonRecord, remove }))
      .rejects.toThrow(/Unauthorized/);
    expect(remove).not.toHaveBeenCalled();
  });
});

// TASK-072: the status line is the only place a local seat's identity and its flap
// counter can be read, and it showed neither. `restarts` is written, persisted and
// served, so a seat that had been crash-looping printed exactly like a healthy one.
describe('resolveAdapterForRuntime', () => {
  test('OpenCode is selected only by an explicit runtime.adapter', async () => {
    const calls = [];
    const registry = {
      getAdapter: (name) => {
        calls.push(name);
        return name === 'opencode' ? { detect: async () => ({ path: '/bin/opencode' }) } : null;
      },
    };
    await expect(resolveAdapterForRuntime({}, registry)).resolves.toBeNull();
    expect(calls).toEqual(['claude', 'codex']);

    calls.length = 0;
    await expect(resolveAdapterForRuntime({ adapter: 'opencode' }, registry)).resolves.toBe('opencode');
    expect(calls).toEqual(['opencode']);
  });
});

describe('formatSeatLine', () => {
  test('names the seat\'s instance and its restart count', () => {
    const line = formatSeatLine({
      agentName: 'quill',
      instanceId: 'quill-seo-writer',
      state: 'running',
      adapter: 'pi',
      model: 'gpt-5.6-luna',
      effort: 'xhigh',
      pid: 12814,
      restarts: 3,
      lastTurnAt: '2026-09-19T19:06:46.349Z',
    });
    // The instance is the identity the platform routes by: a seat attached to the
    // wrong one is otherwise indistinguishable from a correctly attached seat.
    expect(line).toContain('instance=quill-seo-writer');
    expect(line).toContain('restarts=3');
  });

  test('prints restarts=0 rather than omitting a healthy counter', () => {
    const line = formatSeatLine({
      agentName: 'c4-smoke', instanceId: 'default', state: 'running', restarts: 0,
    });
    // A field shown only when non-zero cannot be told apart from a field that was
    // never recorded, which is the whole complaint behind this task.
    expect(line).toContain('restarts=0');
  });

  test('a state file written before the field existed reads as unknown, not as zero', () => {
    const line = formatSeatLine({ agentName: 'old-seat', state: 'running' });
    expect(line).toContain('instance=-');
    expect(line).toContain('restarts=-');
  });
});
