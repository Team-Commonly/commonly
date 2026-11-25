// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const mongoose = require('mongoose');
// eslint-disable-next-line global-require
const { pool: pgPool } = require('../config/db-pg');
// The mount probe, not the boot block's flag — see pgBootService.routerIsMounted
// for why those are two different facts (TASK-168).
// eslint-disable-next-line global-require
const { pgRoutesAreMounted } = require('../services/pgBootService');

interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

// eslint-disable-next-line global-require
const { sharedRedisRequired } = require('../config/sharedRedisRequired');

// /api/health answers unauthenticated callers, and a driver's error text can
// carry an internal host, IP:port, database name or user (F624). The response
// gets one of these fixed reasons; the full message goes to the server log.
type HealthReason = 'timeout' | 'connection_refused' | 'host_not_found' | 'auth_failed' | 'unavailable';

type DriverError = { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };

// A recognized code decides first: a hostname in the message (noauth.internal)
// must not outvote the errno that says what happened. pg: 28P01 invalid_password,
// 28000 invalid_authorization_specification. Mongo: 18 AuthenticationFailed,
// 13 Unauthorized.
const REASON_BY_CODE: Record<string, HealthReason> = {
  ECONNREFUSED: 'connection_refused',
  ENOTFOUND: 'host_not_found',
  EAI_AGAIN: 'host_not_found',
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout',
  '28P01': 'auth_failed',
  28000: 'auth_failed',
  18: 'auth_failed',
  13: 'auth_failed',
};

const reasonFromCode = (err: DriverError): HealthReason | null => {
  const code = err.code === undefined || err.code === null ? '' : String(err.code);
  return Object.prototype.hasOwnProperty.call(REASON_BY_CODE, code) ? REASON_BY_CODE[code] : null;
};

// Only when no code decides. Errno tokens go before auth words, and the Redis
// reply words are whole, upper-case words (node-redis ErrorReply has no code).
const reasonFromMessage = (err: DriverError): HealthReason | null => {
  const message = String(err.message ?? '');
  if (/\bECONNREFUSED\b/.test(message)) return 'connection_refused';
  if (/\b(?:ENOTFOUND|EAI_AGAIN)\b/.test(message)) return 'host_not_found';
  if (/\b(?:WRONGPASS|NOAUTH|NOPERM)\b/.test(message)
    || /authentication failed|auth failed|password authentication/i.test(message)) return 'auth_failed';
  if (/TimeoutError$/.test(String(err.name ?? ''))
    || /\bETIMEDOUT\b|timed out|timeout|did not answer within|exceeded \d+ms/i.test(message)) return 'timeout';
  return null;
};

const publicHealthReason = (error: unknown): HealthReason => {
  const err = (error && typeof error === 'object' ? error : { message: String(error) }) as DriverError;
  const cause = err.cause && typeof err.cause === 'object' ? err.cause as DriverError : null;
  return reasonFromCode(err)
    || (cause && reasonFromCode(cause))
    || reasonFromMessage(err)
    || (cause && reasonFromMessage(cause))
    || 'unavailable';
};

// One log line per state change, not per request: this endpoint is
// unauthenticated and can be hammered. A check logs when its reason differs
// from the last one it logged, and forgets that state on its next success so a
// recurrence logs again. Credentials are scrubbed before the text is written:
// everything between scheme:// and the last @ of that token (a password may
// hold / or @), then a bare user:pass@host. A plain a@b, with no colon before
// the @, is left alone.
const scrubCredentials = (text: string): string => text
  .replace(/([a-z][a-z0-9+.-]*:\/\/)\S*@/gi, '$1***@')
  .replace(/(^|[\s(['"=])[^\s:@/'"]+:(?!\/\/)[^\s@]*@(?=[^\s@])/g, '$1***@');
const lastLoggedReason = new Map<string, HealthReason>();
const logHealthFailure = (check: string, error: unknown): HealthReason => {
  const reason = publicHealthReason(error);
  if (lastLoggedReason.get(check) !== reason) {
    lastLoggedReason.set(check, reason);
    const raw = String((error as { message?: unknown } | null)?.message ?? error);
    console.warn(`health: ${check} check failed (${reason}):`, scrubCredentials(raw));
  }
  return reason;
};
const clearHealthFailure = (check: string): void => { lastLoggedReason.delete(check); };

const REDIS_PROBE_CONNECT_TIMEOUT_MS = 1000;
// The overall deadline for connect plus PING. It sits past the socket's own
// connectTimeout, but that does not make the socket time out first (Node
// refreshes the connect timeout after DNS resolves), so a socket that
// connects after the deadline is closed when it appears (see runRedisProbe).
const REDIS_PROBE_DEADLINE_MS = 1500;
// /api/health is unauthenticated and unlimited, so a burst must not become a
// burst of Redis connections: one probe in flight per process (callers await
// it, as /ready does for PG), and its result, a failure too, reused for a few
// seconds so an outage is not re-probed on every request.
const REDIS_PROBE_TTL_MS = 5000;

type RedisProbe = { ok: boolean; check: Record<string, unknown> };
let redisProbeInFlight: Promise<RedisProbe> | null = null;
let redisProbeCached: { at: number; result: RedisProbe } | null = null;

type RedisProbeClient = { disconnect: () => Promise<unknown>; on: (event: string, listener: () => void) => unknown };
type ProbeState = { finished: boolean; socketStored: boolean };

const closeRedisProbeClient = async (client: Pick<RedisProbeClient, 'disconnect'>): Promise<void> => {
  try {
    await client.disconnect();
  } catch { /* already closed */ }
};

// The client stores its socket only once TCP connects, and emits 'connect' at
// that moment (@redis/client socket.js). Before that, disconnect() would flip
// the client closed and destroy nothing, stranding the socket that arrives
// later. So the probe closes only once the socket exists: right away if it
// does, else from this listener when 'connect' fires after the probe finished.
// A connect that never yields a socket (timeout, DNS, refused) is destroyed by
// the library itself.
//
// The close is deferred one turn on purpose. The client runs its startup
// (AUTH, CLIENT SETINFO) synchronously right after emitting 'connect' and only
// then attaches Promise.all to those commands. Closing inside the event makes
// the startup's write throw before that, and the commands' promises reject
// with nobody listening: an unhandledRejection, which ends the process.
const closeOnLateSocket = (client: Pick<RedisProbeClient, 'disconnect' | 'on'>, state: ProbeState): void => {
  client.on('connect', () => {
    state.socketStored = true;
    if (state.finished) setImmediate(() => { closeRedisProbeClient(client).catch(() => undefined); });
  });
};

const runRedisProbe = async (): Promise<RedisProbe> => {
  let redisClient: RedisProbeClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state: ProbeState = { finished: false, socketStored: false };
  const redisStart = Date.now();
  try {
    // eslint-disable-next-line global-require
    const { createClient } = require('redis');
    // eslint-disable-next-line global-require
    const { redisPassword } = require('../config/redisPassword');
    const redisHost = process.env.REDIS_HOST || 'redis';
    const redisPort = process.env.REDIS_PORT || 6379;
    const client = createClient({
      url: `redis://${redisHost}:${redisPort}`,
      password: redisPassword(),
      // One bounded attempt: no reconnect loop outlives the probe.
      socket: { connectTimeout: REDIS_PROBE_CONNECT_TIMEOUT_MS, reconnectStrategy: false },
    });
    redisClient = client;
    // An unheard 'error' event would end the process.
    client.on('error', () => undefined);
    closeOnLateSocket(client, state);
    const attempt = (async () => {
      await client.connect();
      return client.ping();
    })();
    // The race may be lost; a later rejection is then nobody else's to handle.
    attempt.catch(() => undefined);
    const pong = await Promise.race([
      attempt,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Redis did not answer within ${REDIS_PROBE_DEADLINE_MS}ms`)),
          REDIS_PROBE_DEADLINE_MS,
        );
      }),
    ]);
    if (pong === 'PONG') {
      clearHealthFailure('redis');
      return { ok: true, check: { status: 'healthy', latency: `${Date.now() - redisStart}ms` } };
    }
    return { ok: false, check: { status: 'unhealthy', error: 'Ping failed' } };
  } catch (error) {
    return { ok: false, check: { status: 'unhealthy', error: logHealthFailure('redis', error) } };
  } finally {
    state.finished = true;
    clearTimeout(timer);
    // Socket already stored: the client's startup has its Promise.all attached
    // by now (it ran synchronously at 'connect'), so closing here is safe.
    if (redisClient && state.socketStored) await closeRedisProbeClient(redisClient);
  }
};

const probeRedis = (): Promise<RedisProbe> => {
  if (redisProbeCached && Date.now() - redisProbeCached.at < REDIS_PROBE_TTL_MS) {
    return Promise.resolve(redisProbeCached.result);
  }
  if (!redisProbeInFlight) {
    redisProbeInFlight = runRedisProbe()
      .then((result) => {
        redisProbeCached = { at: Date.now(), result };
        return result;
      })
      .finally(() => { redisProbeInFlight = null; });
  }
  return redisProbeInFlight;
};

const router: ReturnType<typeof express.Router> & { resetRedisProbeForTests?: () => void; closeOnLateSocket?: typeof closeOnLateSocket; publicHealthReason?: typeof publicHealthReason } = express.Router();

router.get('/', async (_req: unknown, res: Res) => {
  const startTime = Date.now();
  const health: Record<string, unknown> = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    checks: {} as Record<string, unknown>,
  };

  try {
    const mongoState = mongoose.connection.readyState;
    const mongoStates: Record<number, string> = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
    if (mongoState === 1) {
      await mongoose.connection.db.admin().ping();
      clearHealthFailure('mongodb');
      (health.checks as Record<string, unknown>).mongodb = { status: 'healthy', state: mongoStates[mongoState], latency: `${Date.now() - startTime}ms` };
    } else {
      (health.checks as Record<string, unknown>).mongodb = { status: 'unhealthy', state: mongoStates[mongoState] || 'unknown', error: 'Not connected' };
      health.status = 'degraded';
    }
  } catch (error) {
    (health.checks as Record<string, unknown>).mongodb = { status: 'unhealthy', error: logHealthFailure('mongodb', error) };
    health.status = 'degraded';
  }

  try {
    if (process.env.PG_HOST && pgPool) {
      const pgStart = Date.now();
      const result = await (pgPool as { query: (q: string) => Promise<{ rows: Array<{ ok: number }> }> }).query('SELECT 1 as ok');
      if (result.rows[0]?.ok === 1) {
        clearHealthFailure('postgresql');
        (health.checks as Record<string, unknown>).postgresql = { status: 'healthy', latency: `${Date.now() - pgStart}ms` };
      } else {
        (health.checks as Record<string, unknown>).postgresql = { status: 'unhealthy', error: 'Query failed' };
        health.status = 'degraded';
      }
    } else {
      (health.checks as Record<string, unknown>).postgresql = { status: 'not_configured', message: 'PostgreSQL not configured (PG_HOST not set)' };
    }
  } catch (error) {
    (health.checks as Record<string, unknown>).postgresql = { status: 'unhealthy', error: logHealthFailure('postgresql', error) };
    health.status = 'degraded';
  }

  // The condition the socket.io adapter connects on (config/socket.ts), so this
  // check and the process cannot disagree about whether Redis is in use.
  if (process.env.AGENT_PROVISIONER_K8S === '1' || process.env.REDIS_HOST) {
    // A failure degrades the overall status only where Redis is required: a
    // process that stops without shared Redis (REQUIRE_SHARED_REDIS=1,
    // config/sharedRedisRequired), or Kubernetes, as before. Any other process
    // falls back to in-process stores, and a Redis blip must not make its
    // /api/health answer 503 (the VM compose healthcheck reads that).
    const redisRequired = sharedRedisRequired() || process.env.AGENT_PROVISIONER_K8S === '1';
    const probe = await probeRedis();
    (health.checks as Record<string, unknown>).redis = probe.check;
    if (!probe.ok && redisRequired) health.status = 'degraded';
  } else {
    (health.checks as Record<string, unknown>).redis = { status: 'not_configured', message: 'Redis not configured (REDIS_HOST not set)' };
  }

  (health.checks as Record<string, unknown>).services = {
    discord: { configured: !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID) },
    gemini: { configured: !!process.env.GEMINI_API_KEY },
    litellm: { configured: !!(process.env.LITELLM_BASE_URL && process.env.LITELLM_MASTER_KEY) },
    // The SMTP2GO provider pair, as admin/users checks it; signup verification also needs FRONTEND_URL.
    smtp2go: { configured: !!(process.env.SMTP2GO_API_KEY && process.env.SMTP2GO_FROM_EMAIL) },
    telegram: { configured: !!process.env.TELEGRAM_BOT_TOKEN },
  };

  const memUsage = process.memoryUsage();
  health.memory = {
    heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
    rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
    external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
  };
  health.responseTime = `${Date.now() - startTime}ms`;

  const httpStatus = health.status === 'healthy' ? 200 : 503;
  res.status(httpStatus).json(health);
});

router.get('/live', (_req: unknown, res: Res) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

// #454 follow-up: dedicated DB-pool probe. The main /api/health does a
// `SELECT 1` round-trip but doesn't surface pool stats. Alerting on
// pool.waitingCount > N for sustained windows would have caught the
// 2026-05-26 incident before user impact. Lightweight (no PG query) so
// safe to scrape frequently (e.g. every 10s from Prometheus).
//
// Returns 503 when waiting > 0 AND idle === 0 — the only signal that
// surely indicates saturation (waiting>0 alone could be a brief blip
// during normal bursts). Operators tune via env.
router.get('/db', (_req: unknown, res: Res) => {
  const stats: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    mongo: {
      state: ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown',
    },
  };

  if (!process.env.PG_HOST || !pgPool) {
    stats.pg = { status: 'not_configured' };
    return res.status(200).json(stats);
  }

  const p = pgPool as {
    options?: { max?: number; connectionTimeoutMillis?: number; idleTimeoutMillis?: number };
    totalCount?: number;
    idleCount?: number;
    waitingCount?: number;
  };
  const idle = p.idleCount ?? 0;
  const waiting = p.waitingCount ?? 0;
  const total = p.totalCount ?? 0;
  const max = p.options?.max ?? 0;

  // Saturation signal: waiting callers AND zero idle connections.
  // waiting > 0 with idle > 0 just means clients ask in bursts faster
  // than they release — pool will catch up. Both being non-zero is
  // when actual queueing happens and latency stacks up.
  const saturated = waiting > 0 && idle === 0;

  stats.pg = {
    status: saturated ? 'saturated' : 'ok',
    max,
    total,
    idle,
    waiting,
    connectionTimeoutMillis: p.options?.connectionTimeoutMillis ?? 0,
    idleTimeoutMillis: p.options?.idleTimeoutMillis ?? 0,
  };

  return res.status(saturated ? 503 : 200).json(stats);
});

const READY_PG_TIMEOUT_MS = 1500;
// One probe in flight per pod: a request that finds one still pending waits
// on it instead of starting another, so probes cannot pile up on the pool.
// The probe checks out its own client and gives its query a deadline of its
// own; past it the client is released with an error, which makes the pool
// destroy it, and the next request starts afresh. Without the deadline a query
// that never settled would hold its client and keep every later probe degraded.
type ProbeClient = {
  query: (q: string) => Promise<unknown>;
  release: (err?: Error) => void;
  on: (event: 'error', listener: (err: Error) => void) => unknown;
  removeListener: (event: 'error', listener: (err: Error) => void) => unknown;
};
type ProbePool = { connect: () => Promise<ProbeClient> };
let readyPgProbe: Promise<unknown> | null = null;
const probePg = (pool: ProbePool): Promise<unknown> => {
  if (!readyPgProbe) {
    const configured = Number(process.env.READY_PG_PROBE_DEADLINE_MS);
    // Node fires any delay above 2^31-1 ms at once, so such a value is unusable too.
    const deadlineMs = Number.isFinite(configured) && configured > 0 && configured <= 2147483647 ? configured : 10000;
    readyPgProbe = (async () => {
      const client = await pool.connect();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let failure: Error | undefined;
      // The pool drops its own error listener at checkout, and a socket that
      // fails mid-query emits 'error' on the client; unheard, that ends the process.
      const onClientError = (err: Error) => { failure = err; };
      client.on('error', onClientError);
      try {
        return await Promise.race([
          client.query('SELECT 1'),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`probe exceeded ${deadlineMs}ms`)), deadlineMs);
          }),
        ]);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        throw failure;
      } finally {
        clearTimeout(timer);
        client.removeListener('error', onClientError);
        client.release(failure);
      }
    })().finally(() => { readyPgProbe = null; });
    // A request that stopped waiting has already answered; nothing else reads this.
    readyPgProbe.catch(() => {});
  }
  return readyPgProbe;
};

router.get('/ready', async (_req: unknown, res: Res) => {
  // Draining is not a liveness failure; only readiness stops new traffic.
  const AgentEventService = require('../services/agentEventService');
  if (AgentEventService.isInProcessDraining()) {
    return res.status(503).json({ status: 'not_ready', reason: 'hosted runtime draining' });
  }
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ status: 'not_ready', reason: 'MongoDB not connected' });
    }
    clearHealthFailure('ready');

    // The gate that was missing on 2026-09-25 (TASK-168). A pod whose boot
    // connect timed out has no PG routes at all: /api/pg/messages 404s, so chat
    // history cannot load and socket writes fall to Mongo. It used to answer
    // ready anyway (this handler returned 200 for a PG probe failure), so during
    // a rollout it took 100% of the traffic while the pod it replaced was
    // healthy. Readiness now fails until the routes are actually mounted, which
    // is a fact about the route table rather than about a connection attempt —
    // and it stops failing the moment the retry mounts them, with no restart.
    //
    // What it deliberately does NOT gate: PG's liveness after a successful
    // mount. A blip then leaves the pod ready and degraded on purpose, because
    // failing every pod's readiness would turn partial degradation into a full
    // API outage (values.yaml, readinessProbe).
    if (process.env.PG_HOST && !pgRoutesAreMounted()) {
      return res.status(503).json({
        status: 'not_ready',
        reason: 'PostgreSQL routes are not mounted on this pod',
        timestamp: new Date().toISOString(),
      });
    }

    if (process.env.PG_HOST && pgPool) {
      // Bounded below the probe's 3s timeout (values.yaml readinessProbe). The
      // query shares the pool with the agent long-polls; when it waits on that
      // pool past the probe, the kubelet records a failed probe and this
      // handler says nothing (11-02/11-03 flaps). A slow answer is treated like
      // a failed one: the pod stays ready, degraded, and the warning is logged.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          probePg(pgPool as ProbePool),
          new Promise((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`did not answer within ${READY_PG_TIMEOUT_MS}ms`)),
              READY_PG_TIMEOUT_MS,
            );
          }),
        ]);
        clearHealthFailure('postgresql-ready');
      } catch (error) {
        // Public and polled by the kubelet: logged once per change, scrubbed.
        logHealthFailure('postgresql-ready', error);
        return res.status(200).json({
          status: 'ready',
          degraded: ['postgresql'],
          timestamp: new Date().toISOString(),
        });
      } finally {
        clearTimeout(timer);
      }
    }

    return res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (error) {
    return res.status(503).json({ status: 'not_ready', error: logHealthFailure('ready', error) });
  }
});

// Tests only: forget the cached Redis probe.
router.closeOnLateSocket = closeOnLateSocket;
router.publicHealthReason = publicHealthReason;
router.resetRedisProbeForTests = (): void => {
  lastLoggedReason.clear();
  redisProbeInFlight = null;
  redisProbeCached = null;
};

module.exports = router;

export {};
