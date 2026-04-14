/**
 * pgRetentionService
 *
 * Daily cron that deletes PostgreSQL chat messages older than the configured
 * retention window (default: 30 days). Controlled by the
 * `PG_MESSAGE_RETENTION_DAYS` env var.
 *
 * If after the initial delete the database is still above
 * `PG_USAGE_TARGET_PCT` of `PG_CAPACITY_BYTES`, retention steps down by
 * `PG_RETENTION_STEP_DAYS` (default 1) per pass until usage drops under the
 * target or a floor of 1 day is reached. Keeps as much history as the disk
 * allows.
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
// eslint-disable-next-line global-require
const { pool } = require('../config/db-pg') as {
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
};

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_CAPACITY_BYTES = 8 * 1024 * 1024 * 1024; // Cloud SQL tier: 8 GiB
const DEFAULT_USAGE_TARGET_PCT = 75;
const DEFAULT_STEP_DAYS = 1;
const FLOOR_DAYS = 1;

interface CronJob {
  start(): void;
  stop(): void;
}

let scheduledJob: CronJob | null = null;

function resolvePositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return NaN;
  return parsed;
}

function resolveRetentionDays(): number {
  return resolvePositiveNumber(process.env.PG_MESSAGE_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
}

function resolveCapacityBytes(): number {
  return resolvePositiveNumber(process.env.PG_CAPACITY_BYTES, DEFAULT_CAPACITY_BYTES);
}

function resolveUsageTargetPct(): number {
  const pct = resolvePositiveNumber(process.env.PG_USAGE_TARGET_PCT, DEFAULT_USAGE_TARGET_PCT);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return DEFAULT_USAGE_TARGET_PCT;
  return pct;
}

function resolveStepDays(): number {
  const step = resolvePositiveNumber(process.env.PG_RETENTION_STEP_DAYS, DEFAULT_STEP_DAYS);
  if (!Number.isFinite(step) || step <= 0) return DEFAULT_STEP_DAYS;
  return Math.max(1, Math.trunc(step));
}

async function getDatabaseSizeBytes(): Promise<number | null> {
  try {
    const result = await pool.query('SELECT pg_database_size(current_database())::bigint AS size');
    const raw = result.rows?.[0]?.size;
    const size = typeof raw === 'string' ? Number(raw) : (raw as number | undefined);
    return Number.isFinite(size) ? (size as number) : null;
  } catch (err) {
    console.error('[pg-retention] pg_database_size failed:', (err as Error).message);
    return null;
  }
}

async function vacuumMessages(): Promise<void> {
  try {
    // Plain VACUUM — frees pages for reuse without locking writers.
    // VACUUM FULL would reclaim OS-level disk but takes an ACCESS EXCLUSIVE lock.
    await pool.query('VACUUM ANALYZE messages');
  } catch (err) {
    console.error('[pg-retention] vacuum failed:', (err as Error).message);
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${bytes} B`;
}

export async function runMessageRetention(): Promise<void> {
  try {
    const startDays = resolveRetentionDays();
    if (!Number.isFinite(startDays) || startDays <= 0) {
      console.warn(
        '[pg-retention] invalid PG_MESSAGE_RETENTION_DAYS, skipping (value=%s)',
        process.env.PG_MESSAGE_RETENTION_DAYS,
      );
      return;
    }

    const capacity = resolveCapacityBytes();
    const targetPct = resolveUsageTargetPct();
    const stepDays = resolveStepDays();
    const targetBytes = Math.floor(capacity * (targetPct / 100));

    const initialSize = await getDatabaseSizeBytes();
    console.log(
      `[pg-retention] start: size=${initialSize !== null ? formatBytes(initialSize) : 'unknown'} ` +
      `target=${formatBytes(targetBytes)} (${targetPct}% of ${formatBytes(capacity)}) ` +
      `retention=${startDays}d step=${stepDays}d`,
    );

    let totalDeleted = 0;
    let currentDays = Math.max(FLOOR_DAYS, Math.trunc(startDays));

    const first = await Message.deleteOlderThan(currentDays);
    totalDeleted += first.deleted || 0;
    await vacuumMessages();
    let size = await getDatabaseSizeBytes();
    console.log(
      `[pg-retention] tier ${currentDays}d: deleted ${first.deleted || 0} ` +
      `size=${size !== null ? formatBytes(size) : 'unknown'}`,
    );

    // Bail reason governs the final log. "vacuumCantReclaim" means regular
    // VACUUM can't shrink the physical file — stepping deeper would over-delete
    // history without reclaiming disk (operator needs VACUUM FULL / pg_repack /
    // bigger tier).
    let bailReason: 'underTarget' | 'floorReached' | 'vacuumCantReclaim' = 'underTarget';

    while (true) {
      if (size === null || size <= targetBytes) {
        bailReason = 'underTarget';
        break;
      }
      if (currentDays <= FLOOR_DAYS) {
        bailReason = 'floorReached';
        break;
      }
      const sizeBefore = size;
      currentDays = Math.max(FLOOR_DAYS, currentDays - stepDays);
      const tierResult = await Message.deleteOlderThan(currentDays);
      totalDeleted += tierResult.deleted || 0;
      await vacuumMessages();
      size = await getDatabaseSizeBytes();
      console.log(
        `[pg-retention] tier ${currentDays}d: deleted ${tierResult.deleted || 0} ` +
        `size=${size !== null ? formatBytes(size) : 'unknown'} ` +
        `(was ${formatBytes(sizeBefore)} > target=${formatBytes(targetBytes)})`,
      );
      if (size !== null && size >= sizeBefore) {
        bailReason = 'vacuumCantReclaim';
        break;
      }
    }

    if (size !== null && size > targetBytes) {
      if (bailReason === 'vacuumCantReclaim') {
        console.warn(
          `[pg-retention] still over target after vacuum stopped reclaiming — ` +
          `size=${formatBytes(size)} target=${formatBytes(targetBytes)} retention=${currentDays}d. ` +
          `Regular VACUUM cannot shrink the physical file; run VACUUM FULL / pg_repack, ` +
          `audit non-message tables, or upgrade the Cloud SQL tier.`,
        );
      } else {
        console.warn(
          `[pg-retention] still over target at floor=${FLOOR_DAYS}d — ` +
          `size=${formatBytes(size)} target=${formatBytes(targetBytes)}. ` +
          `Capacity upgrade or non-message table audit needed.`,
        );
      }
    }

    console.log(
      `[pg-retention] done: totalDeleted=${totalDeleted} finalRetention=${currentDays}d ` +
      `size=${size !== null ? formatBytes(size) : 'unknown'}`,
    );
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
