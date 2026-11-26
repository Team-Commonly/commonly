/**
 * One `commonly daemon run` per machine credential (F637).
 *
 * A Windows install piled up ~140 daemons on one key, each polling the server
 * on its own 30 s timers, and nothing refused the second copy. The lock is a
 * listening local socket: a named pipe on Windows, a unix socket under
 * ~/.commonly/daemon elsewhere. The OS frees it when the holder dies, however
 * it dies, so it never goes stale the way a pid file does (and a reused pid
 * can never pass for the holder).
 *
 * The holder answers anyone who connects with one JSON line, `{"pid":<n>}`,
 * and hangs up, so a refused daemon can name the copy that is already running.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { createConnection, createServer } from 'net';
import { dirname, join } from 'path';

// The exit code of a daemon that found another one holding the lock. The
// Windows launcher waits on it and tries again; it never disables the task.
export const DAEMON_LOCK_EXIT = 79;

// A restart's old node exits within ~2 s of its launcher ending, so a new
// daemon waits this long before it gives up.
export const DAEMON_LOCK_WAIT_MS = 10_000;
const RETRY_EVERY_MS = 500;
const PID_READ_TIMEOUT_MS = 1_000;

// A unix socket path is capped near 104 bytes on macOS (108 on Linux).
const MAX_SOCKET_PATH = 100;

// Keyed by the home alone. A home holds exactly one machine record
// (~/.commonly/daemon/machine.json), and `daemon run --instance` refuses any
// instance but the registered one, so one daemon per home is the rule. Keying
// by machineDbId would let an old daemon still running across a
// `daemon register` (a new machineDbId) sit beside the new one.
export const daemonLockId = ({ home }) => createHash('sha256')
  .update(String(home))
  .digest('hex')
  .slice(0, 16);

export const daemonLockPath = ({ home, platform = process.platform }) => {
  const id = daemonLockId({ home });
  if (platform === 'win32') return `\\\\.\\pipe\\commonly-daemon-${id}`;
  const path = join(home, '.commonly', 'daemon', `daemon-${id}.sock`);
  // A home too deep for a socket path falls back to /tmp; the id still
  // carries the home, so two accounts never share one.
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH ? path : join('/tmp', `commonly-daemon-${id}.sock`);
};

const isPipe = (lockPath) => lockPath.startsWith('\\\\.\\pipe\\');

const listen = (server, lockPath) => new Promise((resolve, reject) => {
  const onError = (error) => { server.off('listening', onListening); reject(error); };
  const onListening = () => { server.off('error', onError); resolve(); };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(lockPath);
});

// Connect to whoever holds the path. `held` with the pid it sent (null when it
// sent nothing readable in time), or `free` when nothing is listening there.
const probe = (lockPath) => new Promise((resolve) => {
  let settled = false;
  let data = '';
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(result);
  };
  const socket = createConnection(lockPath);
  const timer = setTimeout(() => finish({ state: 'held', holderPid: null }), PID_READ_TIMEOUT_MS);
  const parsePid = () => {
    try {
      const pid = JSON.parse(data.split('\n')[0])?.pid;
      return Number.isInteger(pid) ? pid : null;
    } catch {
      return null;
    }
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    data += chunk;
    if (data.includes('\n')) finish({ state: 'held', holderPid: parsePid() });
  });
  socket.on('end', () => finish({ state: 'held', holderPid: parsePid() }));
  socket.on('error', (error) => {
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish({ state: 'free' });
    else finish({ state: 'held', holderPid: parsePid() });
  });
});

const holderServer = () => {
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.end(`${JSON.stringify({ pid: process.pid })}\n`);
  });
  // A late client error must never end the daemon.
  server.on('error', () => {});
  return server;
};

const held = (server, lockPath) => {
  // The lock never keeps the process alive on its own.
  server.unref();
  let released = false;
  const unlinkOwn = () => {
    if (isPipe(lockPath)) return;
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  };
  // process.exit() skips the close below; the socket file goes with the exit.
  const onExit = () => { if (!released) unlinkOwn(); };
  process.once('exit', onExit);
  const release = () => new Promise((resolve) => {
    if (released) { resolve(); return; }
    released = true;
    process.off('exit', onExit);
    // Unlinked once, before the close: unlinking after it could remove the
    // socket of a daemon that took the lock in between.
    unlinkOwn();
    server.close(() => resolve());
  });
  return { ok: true, lockPath, release };
};

/**
 * One attempt: `{ ok: true, release }` when this process now holds the lock,
 * `{ ok: false, holderPid }` when another process does.
 */
export const tryAcquireDaemonLock = async ({ lockPath }) => {
  if (!isPipe(lockPath)) {
    const dir = dirname(lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const server = holderServer();
    try {
      // eslint-disable-next-line no-await-in-loop
      await listen(server, lockPath);
      return held(server, lockPath);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
    // eslint-disable-next-line no-await-in-loop
    const found = await probe(lockPath);
    if (found.state === 'held') return { ok: false, holderPid: found.holderPid };
    // Nothing answers: a socket file a killed holder left behind. A pipe is
    // freed by the OS, so on Windows this is only a holder that just exited.
    // Accepted race: two copies that probe the same stale socket within the
    // same few microseconds can both unlink and both bind. POSIX service
    // managers (launchd, systemd) already run one copy, so this needs two
    // hand-started daemons racing a crashed one; Windows pipes can't hit it.
    if (attempt === 0 && !isPipe(lockPath)) {
      try { unlinkSync(lockPath); } catch { /* raced with another reclaim */ }
    }
  }
  return { ok: false, holderPid: null };
};

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Retries for `waitMs`, so the daemon of a restart can take over from the old
 * one that is still exiting. Never makes a request to the server.
 */
export const acquireDaemonLock = async ({
  lockPath, waitMs = DAEMON_LOCK_WAIT_MS, retryEveryMs = RETRY_EVERY_MS, now = Date.now, sleep = pause,
}) => {
  const deadline = now() + waitMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await tryAcquireDaemonLock({ lockPath });
    if (result.ok || now() >= deadline) return result;
    // eslint-disable-next-line no-await-in-loop
    await sleep(Math.min(retryEveryMs, Math.max(0, deadline - now())));
  }
};

// COMMONLY_DAEMON_LOCK_WAIT_MS shortens the wait (tests); bad values keep the default.
export const daemonLockWaitMs = (env = process.env) => {
  const value = Number(env.COMMONLY_DAEMON_LOCK_WAIT_MS);
  return Number.isFinite(value) && value >= 0 ? value : DAEMON_LOCK_WAIT_MS;
};
