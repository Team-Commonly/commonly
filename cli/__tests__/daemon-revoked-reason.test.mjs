// F641: a revoked daemon key can carry the server's reason text in `error`.
// The daemon prints it before its usual stop line and still exits 77, and the
// status line shows it. A 401 without `error` behaves exactly as before, and
// the revoke detection (which old CLIs share) still keys on `body.message`.
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'commonly-daemon-reason-'));
await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => tmpHome },
  homedir: () => tmpHome,
}));

const { saveInstance } = await import('../src/lib/config.js');
const { createClient } = await import('../src/lib/api.js');
const { loadDaemonStop } = await import('../src/lib/daemon-store.js');
const {
  daemonStatusErrorMessage,
  isRevokedDaemonKey,
  createTerminalAuthStop,
} = await import('../src/commands/daemon.js');

const REASON = 'This computer was disconnected because of a bug in our CLI. Run the computer setup command again from Bring your own agent to get the fixed version.';
const record = {
  machineDbId: '507f1f77bcf86cd799439011',
  machineId: 'e7ee6405-bb61-4e62-85b9-7c7034086feb',
  instanceUrl: 'https://api.commonly.me',
};

afterAll(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(path.join(tmpHome, '.commonly'), { recursive: true, force: true });
  saveInstance({ key: 'dev', url: 'https://api.commonly.me', token: 't', userId: 'u1', username: 'u' });
  process.exitCode = undefined;
});

afterEach(() => { process.exitCode = undefined; });

// The error exactly as api.js builds it from a server response.
const serverError = async (status, body) => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status, text: async () => JSON.stringify(body) });
  try {
    await createClient({ instance: 'dev', token: 'cm_daemon_x' }).get('/api/machines/me');
  } catch (err) {
    return err;
  }
  throw new Error('expected the request to reject');
};

const revokedWithReason = () => serverError(401, { message: 'Daemon token revoked or unknown', error: REASON });
const revokedPlain = () => serverError(401, { message: 'Daemon token revoked or unknown' });

describe('the new 401 body keeps old CLIs stopping', () => {
  test('the revoke check still matches, because body.message is unchanged', async () => {
    const err = await revokedWithReason();
    // Old CLIs build error.message from body.error first, so it is the text now…
    expect(err.message).toBe(REASON);
    // …and body.message, which the revoke check reads, stays exact.
    expect(err.body.message).toBe('Daemon token revoked or unknown');
    expect(isRevokedDaemonKey(err)).toBe(true);
    expect(isRevokedDaemonKey(await revokedPlain())).toBe(true);
    expect(isRevokedDaemonKey(await serverError(401, { message: 'Machine access revoked', error: REASON }))).toBe(true);
  });
});

describe('daemonStatusErrorMessage', () => {
  test('shows the server text before the usual recovery line', async () => {
    const message = daemonStatusErrorMessage(await revokedWithReason());
    expect(message).toBe(`${REASON}\nThis computer's old key was revoked. Run: commonly daemon register`);
  });

  test('without a server text, says exactly what it said before', async () => {
    expect(daemonStatusErrorMessage(await revokedPlain()))
      .toBe("This computer's old key was revoked. Run: commonly daemon register");
  });

  test('prints no terminal control characters from the server', async () => {
    const message = daemonStatusErrorMessage(await serverError(401, {
      message: 'Daemon token revoked or unknown', error: 'Reconnect\u001b[2J now.',
    }));
    expect(message.split('\n')[0]).toBe('Reconnect[2J now.');
  });
});

describe('the daemon stop on a revoked key', () => {
  const run = async (error) => {
    const lines = [];
    const stopSupervision = jest.fn();
    const stop = createTerminalAuthStop({ record, stampLog: (line) => lines.push(line), stopSupervision });
    stop(error);
    return { lines, stopSupervision };
  };

  test('prints the server text before the stop line and still exits 77', async () => {
    const { lines, stopSupervision } = await run(await revokedWithReason());
    expect(lines).toEqual([REASON, 'machine key revoked; stopping supervised agents. Run: commonly daemon register']);
    expect(stopSupervision).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(77);
    expect(loadDaemonStop(record)).toEqual({ machineDbId: record.machineDbId, exitCode: 77 });
  });

  test('without a server text, logs only the stop line as before', async () => {
    const { lines, stopSupervision } = await run(await revokedPlain());
    expect(lines).toEqual(['machine key revoked; stopping supervised agents. Run: commonly daemon register']);
    expect(stopSupervision).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(77);
  });

  // macOS: without the stop marker launchd would restart a 77 forever, so a
  // failed save exits 0 (a clean exit parks it); other platforms keep 77.
  test('on macOS a stop marker that fails to save exits 0, and still says why', async () => {
    const lines = [];
    const stopSupervision = jest.fn();
    const stop = createTerminalAuthStop({
      record,
      stampLog: (line) => lines.push(line),
      stopSupervision,
      saveStop: () => { throw new Error('disk full'); },
      platform: 'darwin',
    });
    stop(await revokedWithReason());
    expect(lines).toEqual([
      'could not save revoked-machine stop marker: disk full',
      REASON,
      'machine key revoked; stopping supervised agents. Run: commonly daemon register',
    ]);
    expect(stopSupervision).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);

    const linux = createTerminalAuthStop({
      record, stampLog: () => {}, stopSupervision: () => {}, saveStop: () => { throw new Error('disk full'); }, platform: 'linux',
    });
    linux(await revokedPlain());
    expect(process.exitCode).toBe(77);
  });

  // F637 releases the one-daemon lock on this path. The stop's wiring lives in
  // the `daemon run` action, which no unit test starts, so the source is the
  // witness: the callback the stop calls ends supervision and releases the lock.
  test('the daemon run stop still ends supervision and releases the one-daemon lock', () => {
    const source = fs.readFileSync(new URL('../src/commands/daemon.js', import.meta.url), 'utf8');
    const wiring = source.match(/const onTerminalAuthError = createTerminalAuthStop\(\{[\s\S]*?\n {8}\}\);/);
    expect(wiring).not.toBeNull();
    expect(wiring[0]).toMatch(/clearInterval\(pollTimer\);\s*clearInterval\(heartbeatTimer\);\s*supervisor\.stop\(\);\s*releaseLock\(\);/);
  });
});
