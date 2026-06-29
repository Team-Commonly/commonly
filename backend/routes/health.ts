// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const mongoose = require('mongoose');
// eslint-disable-next-line global-require
const { pool: pgPool } = require('../config/db-pg');

interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

const getPgPoolSnapshot = (): null | {
  max: number;
  total: number;
  idle: number;
  waiting: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  saturated: boolean;
} => {
  if (!process.env.PG_HOST || !pgPool) return null;

  const p = pgPool as {
    options?: { max?: number; connectionTimeoutMillis?: number; idleTimeoutMillis?: number };
    totalCount?: number;
    idleCount?: number;
    waitingCount?: number;
  };
  const idle = p.idleCount ?? 0;
  const waiting = p.waitingCount ?? 0;

  return {
    max: p.options?.max ?? 0,
    total: p.totalCount ?? 0,
    idle,
    waiting,
    connectionTimeoutMillis: p.options?.connectionTimeoutMillis ?? 0,
    idleTimeoutMillis: p.options?.idleTimeoutMillis ?? 0,
    saturated: waiting > 0 && idle === 0,
  };
};

// Shared PG-pool detail block surfaced by both /db and /ready, so the two
// probes can't drift in what they report. (Theo review on PR #503.)
const pgPoolDetail = (s: NonNullable<ReturnType<typeof getPgPoolSnapshot>>) => ({
  max: s.max,
  total: s.total,
  idle: s.idle,
  waiting: s.waiting,
  connectionTimeoutMillis: s.connectionTimeoutMillis,
});

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
      (health.checks as Record<string, unknown>).mongodb = { status: 'healthy', state: mongoStates[mongoState], latency: `${Date.now() - startTime}ms` };
    } else {
      (health.checks as Record<string, unknown>).mongodb = { status: 'unhealthy', state: mongoStates[mongoState] || 'unknown', error: 'Not connected' };
      health.status = 'degraded';
    }
  } catch (error) {
    const e = error as { message?: string };
    (health.checks as Record<string, unknown>).mongodb = { status: 'unhealthy', error: e.message };
    health.status = 'degraded';
  }

  try {
    if (process.env.PG_HOST && pgPool) {
      const pgStart = Date.now();
      const result = await (pgPool as { query: (q: string) => Promise<{ rows: Array<{ ok: number }> }> }).query('SELECT 1 as ok');
      if (result.rows[0]?.ok === 1) {
        (health.checks as Record<string, unknown>).postgresql = { status: 'healthy', latency: `${Date.now() - pgStart}ms` };
      } else {
        (health.checks as Record<string, unknown>).postgresql = { status: 'unhealthy', error: 'Query failed' };
        health.status = 'degraded';
      }
    } else {
      (health.checks as Record<string, unknown>).postgresql = { status: 'not_configured', message: 'PostgreSQL not configured (PG_HOST not set)' };
    }
  } catch (error) {
    const e = error as { message?: string };
    (health.checks as Record<string, unknown>).postgresql = { status: 'unhealthy', error: e.message };
    health.status = 'degraded';
  }

  if (process.env.AGENT_PROVISIONER_K8S === '1') {
    try {
      // eslint-disable-next-line global-require
      const { createClient } = require('redis');
      const redisHost = process.env.REDIS_HOST || 'redis';
      const redisPort = process.env.REDIS_PORT || 6379;
      const redisClient = createClient({ url: `redis://${redisHost}:${redisPort}` });
      const redisStart = Date.now();
      await redisClient.connect();
      const pong = await redisClient.ping();
      await redisClient.disconnect();
      if (pong === 'PONG') {
        (health.checks as Record<string, unknown>).redis = { status: 'healthy', latency: `${Date.now() - redisStart}ms` };
      } else {
        (health.checks as Record<string, unknown>).redis = { status: 'unhealthy', error: 'Ping failed' };
        health.status = 'degraded';
      }
    } catch (error) {
      const e = error as { message?: string };
      (health.checks as Record<string, unknown>).redis = { status: 'unhealthy', error: e.message };
      health.status = 'degraded';
    }
  } else {
    (health.checks as Record<string, unknown>).redis = { status: 'not_configured', message: 'Redis not configured (Docker Compose mode)' };
  }

  (health.checks as Record<string, unknown>).services = {
    discord: { configured: !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID) },
    gemini: { configured: !!process.env.GEMINI_API_KEY },
    litellm: { configured: !!(process.env.LITELLM_BASE_URL && process.env.LITELLM_MASTER_KEY) },
    sendgrid: { configured: !!process.env.SENDGRID_API_KEY },
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

  const snapshot = getPgPoolSnapshot();
  if (!snapshot) {
    stats.pg = { status: 'not_configured' };
    return res.status(200).json(stats);
  }

  stats.pg = {
    status: snapshot.saturated ? 'saturated' : 'ok',
    ...pgPoolDetail(snapshot),
    idleTimeoutMillis: snapshot.idleTimeoutMillis,
  };

  return res.status(snapshot.saturated ? 503 : 200).json(stats);
});

router.get('/ready', async (_req: unknown, res: Res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ status: 'not_ready', reason: 'MongoDB not connected' });
    }

    if (process.env.PG_HOST && pgPool) {
      const snapshot = getPgPoolSnapshot();
      if (snapshot?.saturated) {
        return res.status(503).json({
          status: 'not_ready',
          reason: 'PostgreSQL pool saturated',
          pg: pgPoolDetail(snapshot),
        });
      }
      try {
        await (pgPool as { query: (q: string) => Promise<unknown> }).query('SELECT 1');
      } catch {
        return res.status(503).json({ status: 'not_ready', reason: 'PostgreSQL not connected' });
      }
    }

    if (process.env.AGENT_PROVISIONER_K8S === '1') {
      try {
        // eslint-disable-next-line global-require
        const { createClient } = require('redis');
        const redisHost = process.env.REDIS_HOST || 'redis';
        const redisPort = process.env.REDIS_PORT || 6379;
        const redisClient = createClient({ url: `redis://${redisHost}:${redisPort}` });
        await redisClient.connect();
        await redisClient.ping();
        await redisClient.disconnect();
      } catch {
        return res.status(503).json({ status: 'not_ready', reason: 'Redis not connected (required in K8s mode)' });
      }
    }

    return res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (error) {
    const e = error as { message?: string };
    return res.status(503).json({ status: 'not_ready', error: e.message });
  }
});

router.get('/clawdbot', async (_req: unknown, res: Res) => {
  const gatewayUrl = process.env.CLAWDBOT_GATEWAY_URL || 'http://clawdbot-gateway:18789';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${gatewayUrl}/health`, { signal: controller.signal }).catch(() => null);
    clearTimeout(timeout);

    if (response && response.ok) {
      const data = await response.json().catch(() => ({})) as { version?: string; channels?: unknown[] };
      return res.json({ status: 'connected', gateway: gatewayUrl, version: data.version || 'unknown', channels: data.channels || [] });
    }

    const basicResponse = await fetch(gatewayUrl, { method: 'HEAD' }).catch(() => null);
    if (basicResponse) {
      return res.json({ status: 'connected', gateway: gatewayUrl, channels: [] });
    }

    return res.json({ status: 'not_configured', message: 'Clawdbot gateway not reachable' });
  } catch (error) {
    const e = error as { message?: string };
    return res.json({ status: 'error', message: e.message });
  }
});

module.exports = router;

export {};
