// F637: one daemon per machine credential. A Windows install piled up ~140
// copies of `daemon run` on one key, and nothing refused the second one. The
// lock is a listening local socket (a named pipe on Windows), which the OS
// frees when its process dies, so it can never go stale the way a pid file can.
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from '@jest/globals';

import {
  DAEMON_LOCK_EXIT,
  acquireDaemonLock,
  daemonLockId,
  daemonLockPath,
  tryAcquireDaemonLock,
} from '../src/lib/daemon-lock.js';

const win = process.platform === 'win32';
const posixOnly = win ? test.skip : test;

// macOS caps a unix socket path near 104 bytes and os.tmpdir() there is long,
// so the POSIX tests use a short directory under /tmp.
const shortTmp = () => (win
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'))
  : fs.mkdtempSync('/tmp/cl-'));

let seq = 0;
const lockPathIn = (dir) => {
  seq += 1;
  return win
    ? `\\\\.\\pipe\\commonly-daemon-test-${process.pid}-${seq}`
    : path.join(dir, `d${seq}.sock`);
};

describe('the lock name', () => {
  // A home holds one machine record (~/.commonly/daemon/machine.json), and
  // `daemon run --instance` refuses any instance but the registered one, so
  // the lock is keyed by the home alone: an old daemon still running across a
  // `daemon register` (a new machineDbId) still blocks a new one.
  test('is the first 16 hex of sha256(home)', () => {
    const want = createHash('sha256').update('C:\\Users\\Maya').digest('hex').slice(0, 16);
    expect(daemonLockId({ home: 'C:\\Users\\Maya' })).toBe(want);
    expect(daemonLockId({ home: 'C:\\Users\\Other' })).not.toBe(want);
  });

  test('does not change when the machine is registered again', () => {
    expect(daemonLockPath({ home: '/home/maya', machineDbId: 'old', platform: 'linux' }))
      .toBe(daemonLockPath({ home: '/home/maya', machineDbId: 'new', platform: 'linux' }));
    expect(daemonLockPath({ home: 'C:\\Users\\Maya', machineDbId: 'old', platform: 'win32' }))
      .toBe(daemonLockPath({ home: 'C:\\Users\\Maya', platform: 'win32' }));
  });

  test('is a named pipe on Windows and a socket under ~/.commonly/daemon elsewhere', () => {
    const id = daemonLockId({ home: 'C:\\Users\\Maya' });
    expect(daemonLockPath({ home: 'C:\\Users\\Maya', platform: 'win32' }))
      .toBe(`\\\\.\\pipe\\commonly-daemon-${id}`);
    const posixId = daemonLockId({ home: '/home/maya' });
    expect(daemonLockPath({ home: '/home/maya', platform: 'linux' }))
      .toBe(path.join('/home/maya', '.commonly', 'daemon', `daemon-${posixId}.sock`));
  });

  test('the refusal exit code is 79', () => {
    expect(DAEMON_LOCK_EXIT).toBe(79);
  });
});

describe('acquiring the lock', () => {
  test('a second acquire is refused and names the holder pid; it frees once the holder closes', async () => {
    const dir = shortTmp();
    const lockPath = lockPathIn(dir);
    try {
      const first = await tryAcquireDaemonLock({ lockPath });
      expect(first.ok).toBe(true);
      const second = await tryAcquireDaemonLock({ lockPath });
      expect(second).toEqual({ ok: false, holderPid: process.pid });
      await first.release();
      const third = await tryAcquireDaemonLock({ lockPath });
      expect(third.ok).toBe(true);
      await third.release();
      // Released twice is harmless.
      await third.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a retry inside the window succeeds once the holder releases', async () => {
    const dir = shortTmp();
    const lockPath = lockPathIn(dir);
    try {
      const holder = await tryAcquireDaemonLock({ lockPath });
      expect(holder.ok).toBe(true);
      setTimeout(() => { void holder.release(); }, 300);
      const waited = await acquireDaemonLock({ lockPath, waitMs: 5000, retryEveryMs: 50 });
      expect(waited.ok).toBe(true);
      await waited.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a holder that stays past the window is reported, with its pid', async () => {
    const dir = shortTmp();
    const lockPath = lockPathIn(dir);
    try {
      const holder = await tryAcquireDaemonLock({ lockPath });
      const started = Date.now();
      const refused = await acquireDaemonLock({ lockPath, waitMs: 300, retryEveryMs: 50 });
      expect(refused).toEqual({ ok: false, holderPid: process.pid });
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      await holder.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // F637 review: close() unlinks a unix socket's path itself (libuv), so
  // release() does not unlink again; a second unlink could remove the socket
  // of a daemon that bound in between.
  posixOnly('release leaves no socket file, and a released holder never removes the next one\'s', async () => {
    const dir = shortTmp();
    const lockPath = lockPathIn(dir);
    try {
      const first = await tryAcquireDaemonLock({ lockPath });
      await first.release();
      expect(fs.existsSync(lockPath)).toBe(false);
      const second = await tryAcquireDaemonLock({ lockPath });
      expect(second.ok).toBe(true);
      // The first holder's release, run again, leaves it alone.
      await first.release();
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(await tryAcquireDaemonLock({ lockPath })).toEqual({ ok: false, holderPid: process.pid });
      await second.release();
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  posixOnly('a socket file left by a killed holder is reclaimed', async () => {
    const dir = shortTmp();
    const lockPath = lockPathIn(dir);
    try {
      // A holder killed with SIGKILL leaves its socket file behind.
      const child = spawn(process.execPath, ['-e', `
        require('net').createServer().listen(${JSON.stringify(lockPath)}, () => process.stdout.write('up\\n'));
      `], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((resolve) => child.stdout.once('data', resolve));
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      expect(fs.existsSync(lockPath)).toBe(true);
      const lock = await tryAcquireDaemonLock({ lockPath });
      expect(lock.ok).toBe(true);
      await lock.release();
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('daemon run with the lock held', () => {
  posixOnly('makes no HTTP request and exits 79, naming the holder pid and the machine', async () => {
    const home = shortTmp();
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests += 1;
      res.writeHead(500).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const record = {
      machineDbId: '507f1f77bcf86cd799439011',
      machineId: 'e7ee6405-bb61-4e62-85b9-7c7034086feb',
      machineName: 'Test Box',
      instanceUrl: `http://127.0.0.1:${server.address().port}`,
      daemonToken: 'cm_daemon_secret',
      registeredAt: '2026-08-30T00:00:00.000Z',
    };
    const daemonDir = path.join(home, '.commonly', 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(home, '.commonly'), 0o700);
    fs.chmodSync(daemonDir, 0o700);
    fs.writeFileSync(path.join(daemonDir, 'machine.json'), JSON.stringify(record), { mode: 0o600 });
    const holder = await tryAcquireDaemonLock({
      // Keyed by the home: a holder for another machineDbId (an older
      // registration) blocks this daemon all the same.
      lockPath: daemonLockPath({ home }),
    });
    expect(holder.ok).toBe(true);
    try {
      const entry = new URL('../src/index.js', import.meta.url).pathname;
      // Async spawn, not spawnSync: this process holds the lock and must stay
      // free to answer the child's pid probe.
      const child = spawn(process.execPath, [entry, 'daemon', 'run'], {
        env: {
          ...process.env,
          HOME: home,
          COMMONLY_DAEMON_LOCK_WAIT_MS: '400',
          COMMONLY_NO_UPDATE_CHECK: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      // A daemon that ignores the lock would run forever; never leave it behind.
      const guard = setTimeout(() => child.kill('SIGKILL'), 12_000);
      const code = await new Promise((resolve) => child.once('exit', resolve));
      clearTimeout(guard);
      expect(code).toBe(79);
      expect(out).toContain(`pid ${process.pid}`);
      expect(out).toContain('Test Box');
      expect(requests).toBe(0);
    } finally {
      await holder.release();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
