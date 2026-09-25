/**
 * Boot-time PostgreSQL connection, with retries (TASK-168).
 *
 * WHY THIS EXISTS. On 2026-09-25 a production pod's startup PG connect timed
 * out ("Connection terminated due to connection timeout"). `server.ts` called
 * `connectPG()` once, treated a null result as "PostgreSQL is not available on
 * this pod, forever", and never tried again. That pod then:
 *
 *   - reported `/api/pg/status` → `available:false` for its whole life,
 *   - 404'd `/api/pg/messages` (the routes were never mounted), so chat
 *     history would not load,
 *   - sent socket chat writes to Mongo,
 *   - never started pg-retention or installation-cleanup,
 *
 * while PG itself was healthy — a probe from the same pod connected in 331ms.
 * A rollout restart on the same image fixed it, i.e. the only recovery was a
 * human noticing.
 *
 * A transient connect failure at boot is not a property of the deployment, so
 * it must not be decided once. This retries with exponential backoff, and if
 * the synchronous attempts are exhausted it keeps retrying in the background
 * and mounts the PG routes the moment the connection succeeds — so a pod that
 * booted during a blip heals itself instead of serving without chat until
 * someone restarts it.
 *
 * WHAT IT DOES NOT DO. It never throws, and it never mounts a route it has not
 * proven: the routes go up only after a connect AND a successful schema
 * initialization. `pgBootState.mounted` is the observable result — the health
 * route reads it to decide whether this pod is safe to serve (the boot-scoped
 * readiness gate), so a pod that never mounted PG does not take traffic
 * during a rollout.
 *
 * WHY A FACTORY. The retry loop is the part worth testing, and testing it
 * against the real pool would mean waiting out real backoff intervals and real
 * connect timeouts. Everything the loop touches — the clock, the connector,
 * the schema initializer, the route mount, the background scheduler — is
 * injected, so the test can make the FIRST connect time out and prove the
 * SECOND attempt mounts the routes (TASK-168 acceptance 3) without a database.
 */

export interface PgBootState {
  /** True once connect + initialize succeeded and the routes are mounted. */
  mounted: boolean;
  /** Total connect attempts made, synchronous and background. */
  attempts: number;
  /** True once the synchronous attempts ran out and the background loop took over. */
  fellBack: boolean;
  /** Why the most recent attempt failed, for logs and `/api/pg/status` diagnostics. */
  lastError: string | null;
  /** ISO timestamp of the successful mount, null while unmounted. */
  mountedAt: string | null;
}

/**
 * Module-level so the health route can read it without importing server.ts
 * (which would be a cycle: server.ts mounts the health route).
 */
export const pgBootState: PgBootState = {
  mounted: false,
  attempts: 0,
  fellBack: false,
  lastError: null,
  mountedAt: null,
};

export type LogFn = (message: string, error?: unknown) => void;

export interface PgBootDeps {
  /** Mounts the PG message routes. Called exactly once, only after a proven connection. */
  mountRoutes: () => void;
  /** `connectPG` — resolves the pool, or null when the attempt failed. */
  connect: () => Promise<unknown>;
  /** `initializePGDB` — applies schema.sql; false means the schema is not there. */
  initialize: () => Promise<boolean>;
  /** Started once, after the mount (retention + installation-cleanup crons). */
  onMounted?: () => void;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to an unref'd setInterval. Returns a canceller. */
  schedule?: (fn: () => void, ms: number) => () => void;
  log?: { info: LogFn; warn: LogFn; error: LogFn };
  state?: PgBootState;
  /** Overrides; each falls back to its env var, then to the default. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backgroundIntervalMs?: number;
}

export interface PgBootHandle {
  start: () => Promise<boolean>;
  stopBackground: () => void;
  state: PgBootState;
}

const readPositiveInt = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const messageOf = (error: unknown): string => {
  const e = error as { message?: string };
  return e?.message || String(error);
};

export const createPgBoot = (deps: PgBootDeps): PgBootHandle => {
  const state = deps.state || pgBootState;
  const defaultLog = (level: 'info' | 'warn' | 'error'): LogFn => (message, error) => {
    const suffix = error === undefined ? '' : ` ${messageOf(error)}`;
    if (level === 'error') console.error(message + suffix);
    else if (level === 'warn') console.warn(message + suffix);
    else console.log(message + suffix);
  };
  const log = {
    info: deps.log?.info || defaultLog('info'),
    warn: deps.log?.warn || defaultLog('warn'),
    error: deps.log?.error || defaultLog('error'),
  };

  const attempts = readPositiveInt(
    deps.attempts ?? process.env.PG_BOOT_RETRY_ATTEMPTS,
    5,
  );
  const baseDelayMs = readPositiveInt(
    deps.baseDelayMs ?? process.env.PG_BOOT_RETRY_BASE_DELAY_MS,
    500,
  );
  const maxDelayMs = readPositiveInt(
    deps.maxDelayMs ?? process.env.PG_BOOT_RETRY_MAX_DELAY_MS,
    30000,
  );
  const backgroundIntervalMs = readPositiveInt(
    deps.backgroundIntervalMs ?? process.env.PG_BOOT_RETRY_INTERVAL_MS,
    30000,
  );
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }));
  const schedule = deps.schedule || ((fn: () => void, ms: number) => {
    const timer = setInterval(fn, ms);
    // An unmounted-pod retry loop must not hold the process open; the HTTP
    // server does that already.
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  });

  let cancelBackground: (() => void) | null = null;

  const mount = (): void => {
    if (state.mounted) return;
    deps.mountRoutes();
    state.mounted = true;
    state.mountedAt = new Date().toISOString();
    log.info('PostgreSQL routes registered for chat functionality');
    if (deps.onMounted) deps.onMounted();
  };

  const attemptOnce = async (): Promise<boolean> => {
    state.attempts += 1;
    let pool: unknown = null;
    try {
      pool = await deps.connect();
    } catch (err) {
      state.lastError = `connect threw: ${messageOf(err)}`;
      return false;
    }
    if (!pool) {
      state.lastError = 'connect returned no pool';
      return false;
    }
    let initialized = false;
    try {
      initialized = await deps.initialize();
    } catch (err) {
      state.lastError = `initialize threw: ${messageOf(err)}`;
      return false;
    }
    if (!initialized) {
      state.lastError = 'schema initialization failed';
      return false;
    }
    state.lastError = null;
    mount();
    return true;
  };

  const stopBackground = (): void => {
    if (cancelBackground) {
      cancelBackground();
      cancelBackground = null;
    }
  };

  const backgroundAttempt = (): void => {
    attemptOnce()
      .then((mounted) => {
        if (mounted) stopBackground();
        else log.warn(`PostgreSQL still unavailable after ${state.attempts} attempts; will retry`);
      })
      .catch((err) => {
        // attemptOnce swallows its own failures; this is the belt-and-braces
        // path so a rejection can never become an unhandled rejection that
        // takes the process down.
        log.error('PostgreSQL background retry failed:', err);
      });
  };

  const start = async (): Promise<boolean> => {
    for (let i = 0; i < attempts; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await attemptOnce()) return true;
      if (i < attempts - 1) {
        const wait = Math.min(baseDelayMs * (2 ** i), maxDelayMs);
        log.warn(
          `PostgreSQL connection attempt ${state.attempts} failed (${state.lastError}); retrying in ${wait}ms`,
        );
        // eslint-disable-next-line no-await-in-loop
        await sleep(wait);
      }
    }

    state.fellBack = true;
    log.error(
      `PostgreSQL not available after ${state.attempts} boot attempts (${state.lastError}). `
      + `Chat functionality will use MongoDB until it connects; retrying every ${backgroundIntervalMs}ms `
      + 'and the PG routes mount as soon as it does.',
    );
    stopBackground();
    cancelBackground = schedule(backgroundAttempt, backgroundIntervalMs);
    return false;
  };

  return { start, stopBackground, state };
};

export {};
