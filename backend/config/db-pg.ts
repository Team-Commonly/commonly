// eslint-disable-next-line global-require
const fs = require('fs');
// eslint-disable-next-line global-require
const { Pool } = require('pg');
// eslint-disable-next-line global-require
require('dotenv').config();

interface PgConfig {
  user: string | undefined;
  password: string | undefined;
  host: string | undefined;
  port: number | string;
  database: string | undefined;
  ssl?: { rejectUnauthorized: boolean; ca: string } | false;
  // Pool sizing — see #454 (2026-05-26 incident). pg.Pool defaults to
  // max=10 and connectionTimeoutMillis=0 (wait forever). On any traffic
  // surge — e.g. the hourly summarizer fanning out 60 summary.request
  // events — concurrent pool.query() calls saturate the 10 slots and
  // every subsequent caller hangs indefinitely instead of failing fast.
  // User-facing endpoints (getAllPods, /api/messages) then appear to
  // "freeze" with no diagnostic signal. Bumping max + adding an explicit
  // connection-acquire timeout fixes both: more headroom for the burst,
  // and a clear acquire-timeout error if it does saturate.
  max: number;
  connectionTimeoutMillis: number;
}

// Defaults: max=50 (Aiven dev plan supports 100+ connections; 50 gives
// ample room for the 60-event summarizer burst without claiming the
// entire DB connection budget), connectionTimeoutMillis=5000ms (fail
// fast as a 5xx so the user sees an error rather than a perpetual
// "loading"). Operators can tune via env without rebuilding;
// non-numeric / non-positive env values fall through to the default
// rather than zeroing the pool.
const parsePoolInt = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const pgConfig: PgConfig = {
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  host: process.env.PG_HOST,
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE,
  max: parsePoolInt(process.env.PG_POOL_MAX, 50),
  connectionTimeoutMillis: parsePoolInt(process.env.PG_POOL_CONNECT_TIMEOUT_MS, 5000),
};

/**
 * Decide the pool's SSL configuration from the environment.
 *
 * THREE THINGS THIS USED TO GET WRONG, all in the same direction — SSL on for
 * a server that has none, which fails the connect where the failure is
 * permanent and silent (TASK-168, 2026-09-25):
 *
 * 1. `PG_SSL_ENABLED` was never read. The chart sets it (`false` locally, `true`
 *    in dev/prod) and the local secrets file even carries the comment "Empty
 *    cert — not used when PG_SSL_ENABLED=false", but the decision was made by
 *    the presence of the PATH alone. So the kind smoke cluster — which mounts
 *    the local placeholder secret and disables SSL on purpose — put the pool in
 *    SSL mode against an in-cluster Postgres without TLS. It never connected,
 *    which nothing noticed until the readiness gate started reporting it.
 * 2. An EMPTY CA file counted as a CA. `fs.existsSync` was the whole test, and
 *    the local placeholder secret is a zero-byte `ca.pem` under a real path, so
 *    `{ ca: '' }` was "configured". That is not a local-only shape: any instance
 *    whose CA secret materializes empty lands here, and the mode it lands in
 *    both forces TLS and gives Node nothing to verify against.
 * 3. A read error silently disabled SSL, which is the opposite of failing
 *    closed. Left as-is (a missing CA must not stop the pod from booting), but
 *    now it is reported with its reason rather than looking like a decision.
 *
 * Unset `PG_SSL_ENABLED` keeps the old default (on), so dev and prod — which set
 * it to "true" and mount a real CA — behave exactly as before.
 */
export const resolvePgSsl = (
  // `Record<string, string | undefined>` rather than a narrow object type:
  // `process.env` is a `ProcessEnv`, which shares no properties with a literal
  // shape under this tsconfig (TS2559), and the two keys this reads are the
  // whole contract anyway.
  env: Record<string, string | undefined>,
  readCaFile: (p: string) => { exists: boolean; content: string },
): { ssl: false | { rejectUnauthorized: boolean; ca: string }; reason: string } => {
  const enabled = String(env.PG_SSL_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  if (!enabled) {
    return { ssl: false, reason: 'PG_SSL_ENABLED=false' };
  }
  if (!env.PG_SSL_CA_PATH) {
    return { ssl: false, reason: 'no PG_SSL_CA_PATH' };
  }
  let ca: { exists: boolean; content: string };
  try {
    ca = readCaFile(env.PG_SSL_CA_PATH);
  } catch (err) {
    const e = err as { message?: string };
    return { ssl: false, reason: `CA file unreadable at ${env.PG_SSL_CA_PATH}: ${e.message}` };
  }
  if (!ca.exists) {
    return { ssl: false, reason: `CA file not found at ${env.PG_SSL_CA_PATH}` };
  }
  if (!ca.content.trim()) {
    return { ssl: false, reason: `CA file at ${env.PG_SSL_CA_PATH} is empty` };
  }
  return { ssl: { rejectUnauthorized: true, ca: ca.content }, reason: `CA loaded from ${env.PG_SSL_CA_PATH}` };
};

const sslDecision = resolvePgSsl(process.env, (caPath) => {
  if (!fs.existsSync(caPath)) return { exists: false, content: '' };
  return { exists: true, content: fs.readFileSync(caPath).toString() };
});
pgConfig.ssl = sslDecision.ssl;
if (sslDecision.ssl) {
  console.log(`SSL enabled — ${sslDecision.reason}`);
} else {
  console.log(`SSL disabled — ${sslDecision.reason}`);
}

const pool: unknown = pgConfig.host ? new Pool(pgConfig) : null;

if (pool) {
  (pool as { on: (event: string, cb: (client: { query: (sql: string) => Promise<void> }) => void) => void }).on('connect', (client) => {
    client.query('SET default_transaction_read_only = off').catch(() => {});
  });

  // An IDLE pooled client that errors with no 'error' listener is an unhandled
  // EventEmitter error, which in Node terminates the process. That is not a
  // theoretical footgun — it took the API down twice on 2026-08-20 with:
  //
  //   error: terminating connection due to administrator command  (severity FATAL)
  //
  // which is what managed Postgres says during a failover, a patch window, or
  // ordinary connection recycling. In other words a ROUTINE event on the
  // provider side was converting into a full outage on ours, and the pod
  // restart loop (`restarts: 2` inside two minutes) meant every maintenance
  // window would do it again.
  //
  // The pool already handles the recovery correctly on its own: the broken
  // client is discarded and the next checkout dials a fresh one. All that was
  // missing was a listener so the error stays an error instead of becoming a
  // process exit. Logged rather than swallowed — a silent reconnect would hide
  // a genuinely failing database, and "it fails quietly" is the pattern this
  // codebase keeps paying for.
  (pool as { on: (event: string, cb: (err: Error) => void) => void }).on('error', (err) => {
    console.error('[pg-pool] idle client error (connection discarded, pool will reconnect):', err?.message || err);
  });
}

const connectPG = async (): Promise<unknown> => {
  if (!pool) {
    console.log('PostgreSQL not configured (PG_HOST not set), skipping connection');
    return null;
  }
  try {
    console.log('Attempting to connect to PostgreSQL...');
    const p = pool as { connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }>; release(): void }> };
    const client = await p.connect();
    const result = await client.query('SELECT VERSION()');
    console.log('PostgreSQL connected: ', result.rows[0].version);

    const roResult = await client.query('SHOW default_transaction_read_only');
    if (roResult.rows[0].default_transaction_read_only === 'on') {
      console.warn('PostgreSQL default_transaction_read_only is ON — fixing...');
      await client.query('SET default_transaction_read_only = off');
      await client.query(
        `ALTER DATABASE ${pgConfig.database || 'defaultdb'} SET default_transaction_read_only = off`,
      );
      console.log('PostgreSQL default_transaction_read_only fixed to OFF');
    }

    client.release();
    return pool;
  } catch (err) {
    const e = err as { message?: string };
    console.error('PostgreSQL connection error:', e.message);
    console.error('Connection details:', {
      host: pgConfig.host,
      port: pgConfig.port,
      database: pgConfig.database,
      user: pgConfig.user,
      ssl: pgConfig.ssl ? 'Enabled' : 'Disabled',
    });
    return null;
  }
};

module.exports = { pool, connectPG, resolvePgSsl };

export {};
