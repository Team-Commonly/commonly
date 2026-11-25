import { promises as fsPromises } from 'fs';
import inspector from 'inspector';
import os from 'os';
import path from 'path';
import { describeError } from '../utils/safeErrorLog';

/**
 * Captures a CPU profile of this process when it receives SIGUSR2, behind
 * CPU_PROFILE_ON_SIGNAL=1 (F633).
 *
 * The prod backend stalls its event loop for 2–6s at :04/:14/:24 and holds a
 * core for 10–15s; `[loop-lag]` sees the stall but no log says what burns the
 * CPU, and nothing ad hoc is ever run inside the serving container. So an
 * operator sends `docker kill -s USR2 <backend-container>` from the host and
 * fetches the file with `docker cp`. Runbook:
 * docs/runbooks/cpu-profile-on-signal.md.
 *
 * Off by default, and when off nothing is registered: nodemon restarts the
 * dev server by sending SIGUSR2 and waiting for the child to exit, and a
 * handler would swallow that. SIGUSR1 is Node's inspector activation and is
 * never touched.
 */

export const DEFAULT_SECONDS = 30;
export const MIN_SECONDS = 5;
export const MAX_SECONDS = 60;
export const KEEP_FILES = 5;
const FILE_PATTERN = /^cpu-.*\.cpuprofile$/;

interface ProfilerSession {
  connect(): void;
  disconnect(): void;
  post(method: string, callback: (err: Error | null, result?: unknown) => void): void;
  post(method: string, params: object, callback: (err: Error | null, result?: unknown) => void): void;
}

interface ProfileFs {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(file: string, data: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  unlink(file: string): Promise<void>;
}

interface Logger {
  log(format: string, ...args: unknown[]): void;
  warn(format: string, ...args: unknown[]): void;
  error(format: string, ...args: unknown[]): void;
}

interface SignalTarget {
  on(event: 'SIGUSR2', listener: () => void): unknown;
  removeListener(event: 'SIGUSR2', listener: () => void): unknown;
}

export interface CpuProfileHandle {
  stop(): void;
}

export const parseProfileSeconds = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(n)));
};

const post = (session: ProfilerSession, method: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    session.post(method, (err, result) => (err ? reject(err) : resolve(result)));
  });

export const startCpuProfileOnSignal = ({
  env = process.env,
  proc = process as SignalTarget,
  createSession = () => new inspector.Session() as unknown as ProfilerSession,
  fs = fsPromises as unknown as ProfileFs,
  logger = console as Logger,
  now = () => new Date(),
}: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  proc?: SignalTarget;
  createSession?: () => ProfilerSession;
  fs?: ProfileFs;
  logger?: Logger;
  now?: () => Date;
} = {}): CpuProfileHandle => {
  if (env.CPU_PROFILE_ON_SIGNAL !== '1') return { stop: () => {} };

  const seconds = parseProfileSeconds(env.CPU_PROFILE_SECONDS);
  const dir = env.CPU_PROFILE_DIR || path.join(os.tmpdir(), 'cpuprofiles');

  let session: ProfilerSession | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let stopped = false;

  const logFailure = (label: string, err: unknown) => {
    try {
      logger.error('%s', label, describeError(err));
    } catch {
      // A broken logger must not turn a failed capture into a throw.
    }
  };

  const release = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const s = session;
    session = null;
    busy = false;
    try {
      s?.disconnect();
    } catch {
      // Already disconnected.
    }
  };

  const prune = async () => {
    const names = (await fs.readdir(dir)).filter((name) => FILE_PATTERN.test(name)).sort();
    // ISO timestamps sort by name, so the oldest come first.
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_FILES))) {
      await fs.unlink(path.join(dir, name));
    }
  };

  const finish = async (s: ProfilerSession) => {
    try {
      const { profile } = (await post(s, 'Profiler.stop')) as { profile: unknown };
      if (stopped) return;
      const data = JSON.stringify(profile);
      // Colons in a file name trip `docker cp <container>:<path>` and Windows.
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `cpu-${stamp}.cpuprofile`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, data);
      logger.log('[cpu-profile] wrote %s (%d bytes, %ds)', file, Buffer.byteLength(data), seconds);
      try {
        await prune();
      } catch (err) {
        logFailure('[cpu-profile] pruning old profiles failed', err);
      }
    } catch (err) {
      logFailure('[cpu-profile] capture failed', err);
    } finally {
      if (session === s) release();
    }
  };

  const capture = async () => {
    if (busy) {
      logger.warn('[cpu-profile] a capture is already running; signal ignored');
      return;
    }
    busy = true;
    try {
      const s = createSession();
      session = s;
      s.connect();
      await post(s, 'Profiler.enable');
      await post(s, 'Profiler.start');
      if (stopped || session !== s) return;
      logger.log('[cpu-profile] started, %ds, writing to %s', seconds, dir);
      timer = setTimeout(() => {
        timer = null;
        void finish(s);
      }, seconds * 1000);
      // A pending capture never holds the process open at shutdown.
      timer.unref?.();
    } catch (err) {
      logFailure('[cpu-profile] capture failed', err);
      release();
    }
  };

  const onSignal = () => {
    capture().catch((err) => logFailure('[cpu-profile] capture failed', err));
  };

  proc.on('SIGUSR2', onSignal);

  return {
    stop: () => {
      stopped = true;
      proc.removeListener('SIGUSR2', onSignal);
      release();
    },
  };
};

export default { startCpuProfileOnSignal, parseProfileSeconds };
// CJS compat: let require() return the module object with named exports
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
