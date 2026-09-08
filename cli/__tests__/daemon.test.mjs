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
  loadDaemonRecord,
  removeDaemonRecord,
  saveDaemonRecord,
} = await import('../src/lib/daemon-store.js');
const {
  getDaemonMachineStatus,
  heartbeatDaemonMachine,
  registerDaemonMachine,
  unregisterDaemonMachine,
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
        machine: { id: daemonRecord.machineDbId, status: 'online' },
      }),
    };
    await expect(getDaemonMachineStatus({ client, record: daemonRecord }))
      .resolves.toEqual({ id: daemonRecord.machineDbId, status: 'online' });
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
    const error = Object.assign(new Error('Machine not found'), { status: 404 });
    const client = { del: jest.fn().mockRejectedValue(error) };

    await unregisterDaemonMachine({ client, record: daemonRecord, remove });

    expect(remove).toHaveBeenCalledTimes(1);
  });
});
