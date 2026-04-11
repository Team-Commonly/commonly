/**
 * pgRetentionService
 *
 * Daily cron that deletes PostgreSQL chat messages older than the configured
 * retention window (default: 30 days). Controlled by the
 * `PG_MESSAGE_RETENTION_DAYS` env var.
 *
 * Intentionally kept separate from schedulerService so that other tracks can
 * edit schedulerService without stomping on this cron (and vice versa).
 */

// eslint-disable-next-line global-require
const cron = require('node-cron');
// eslint-disable-next-line global-require
const Message = require('../models/pg/Message') as {
  deleteOlderThan: (days: number) => Promise<{ deleted: number }>;
};

const DEFAULT_RETENTION_DAYS = 30;

interface CronJob {
  start(): void;
  stop(): void;
}

let scheduledJob: CronJob | null = null;

function resolveRetentionDays(): number {
  const raw = process.env.PG_MESSAGE_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_RETENTION_DAYS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return NaN;
  }
  return parsed;
}

export async function runMessageRetention(): Promise<void> {
  try {
    const days = resolveRetentionDays();
    if (!Number.isFinite(days) || days <= 0) {
      console.warn(
        '[pg-retention] invalid PG_MESSAGE_RETENTION_DAYS, skipping (value=%s)',
        process.env.PG_MESSAGE_RETENTION_DAYS,
      );
      return;
    }
    console.log(`[pg-retention] running: delete messages older than ${days} days`);
    const result = await Message.deleteOlderThan(days);
    console.log(`[pg-retention] done: deleted ${result?.deleted || 0} message(s)`);
  } catch (err) {
    // Swallow so cron keeps running — never crash the host process from a
    // retention failure. Next run will retry.
    console.error('[pg-retention] failed:', (err as Error).message);
  }
}

export function initPgRetention(): void {
  if (scheduledJob) {
    console.log('[pg-retention] already scheduled, skipping re-init');
    return;
  }
  try {
    scheduledJob = cron.schedule('0 3 * * *', runMessageRetention, { timezone: 'UTC' }) as CronJob;
    console.log('[pg-retention] scheduled daily cleanup at 03:00 UTC');
  } catch (err) {
    console.error('[pg-retention] failed to schedule cron:', (err as Error).message);
  }
}

export default {
  runMessageRetention,
  initPgRetention,
};

// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
