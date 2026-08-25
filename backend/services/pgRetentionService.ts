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
  deleteOlderThan: (days: number, protectedPodIds?: string[]) => Promise<{ deleted: number }>;
};
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const PgRetentionRun = require('../models/pg/PgRetentionRun') as {
  start: (input: { configuredRetentionDays: number | null; targetBytes: number | null }) => Promise<number>;
  finish: (runId: number, outcome: {
    status: 'completed' | 'aborted' | 'failed' | 'skipped';
    finalRetentionDays: number | null;
    protectedPodCount: number | null;
    deletedMessageCount: number;
    initialSizeBytes: number | null;
    finalSizeBytes: number | null;
    detail?: string | null;
  }) => Promise<void>;
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
// How long a lapsed Pro account keeps its history after the entitlement ends.
// Deliberately NOT tied to PG_MESSAGE_RETENTION_DAYS: that window is the free
// tier's product, this one is a win-back runway, and squeezing free-tier
// storage should never shorten it.
const DEFAULT_PRO_GRACE_DAYS = 30;

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

function resolveGraceDays(): number {
  const days = resolvePositiveNumber(process.env.PRO_DATA_GRACE_DAYS, DEFAULT_PRO_GRACE_DAYS);
  // A bad env value must not silently shorten the window to zero and delete a
  // lapsed customer's history — fall back to the documented default.
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_PRO_GRACE_DAYS;
  return days;
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

/**
 * Pods whose history the Pro tier promises to keep.
 *
 * The landing page sells "Unlimited message history — nothing expires at 30
 * days" as the headline Pro feature. This is what makes that true; without it
 * the cron below deletes a paying customer's messages on exactly the same
 * schedule as a free user's, and the step-down under storage pressure can take
 * that to a single day.
 *
 * The POD'S CREATOR governs, not any member. Retention is a property of the
 * room, the way it is in every other team tool — a paid user in someone
 * else's free workspace gets that workspace's policy.
 *
 * The rejected alternative was "any Pro member protects the pod". It reads
 * more generous and behaves worse: membership is cheap and unilateral, so a
 * single Pro admin who has joined everything silently confers unlimited
 * retention on the entire instance (measured 2026-08-06: one Pro admin
 * protected 95 of 235 pods, 78% of all messages). Retention would then be
 * decided by who happened to join a room rather than by who owns it, and the
 * only way to remove protection would be to remove a person.
 *
 * The honest cost: a Pro user in a pod they did not create does not get
 * unlimited history there. The pricing copy says "pods you create" for exactly
 * this reason — see landing.pricing.pro.items.history.
 *
 * Throws rather than returning empty. The caller must abort the run: deleting
 * paid-for data because a lookup failed is unrecoverable, while skipping one
 * night of cleanup costs nothing.
 */
export async function resolveProtectedPodIds(): Promise<string[]> {
  /*
   * Lapsed accounts keep their DATA for a grace window after their FEATURES
   * stop. Otherwise one failed card payment flips the subscription to
   * `past_due` and that night's run deletes everything older than 30 days —
   * before the customer has seen the dunning email, and irreversibly if they
   * fix the card the next morning. Winning them back is impossible once their
   * history is gone; holding bytes for a month is nearly free.
   *
   * `billing.proEndedAt` is stamped on the true -> false edge by
   * billingService.applySubscriptionState.
   */
  const graceCutoff = new Date(Date.now() - resolveGraceDays() * 24 * 60 * 60 * 1000);
  const proUsers = await User.find({
    $or: [
      { 'entitlements.pro': true },
      { 'billing.proEndedAt': { $gte: graceCutoff } },
    ],
  }).select('_id').lean();
  if (proUsers.length === 0) return [];
  const proIds = proUsers.map((u: { _id: unknown }) => u._id);
  const pods = await Pod.find({ createdBy: { $in: proIds } }).select('_id').lean();
  return pods.map((p: { _id: unknown }) => String(p._id));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${bytes} B`;
}

export async function runMessageRetention(): Promise<void> {
  let runId: number | null = null;
  let currentDays: number | null = null;
  let totalDeleted = 0;
  let protectedPodCount: number | null = null;
  let initialSize: number | null = null;
  let size: number | null = null;

  const finishRun = async (outcome: {
    status: 'completed' | 'aborted' | 'failed' | 'skipped';
    detail?: string | null;
  }): Promise<void> => {
    if (runId === null) return;
    try {
      await PgRetentionRun.finish(runId, {
        status: outcome.status,
        finalRetentionDays: currentDays,
        protectedPodCount,
        deletedMessageCount: totalDeleted,
        initialSizeBytes: initialSize,
        finalSizeBytes: size,
        detail: outcome.detail || null,
      });
    } catch (recordError) {
      // Do not rewrite a completed run as failed if the *recording* update
      // flakes. Its surviving `running` row is the honest durable signal.
      console.error('[pg-retention] could not persist run outcome:', (recordError as Error).message);
    }
  };

  try {
    const startDays = resolveRetentionDays();
    if (!Number.isFinite(startDays) || startDays <= 0) {
      // This is still a scheduled run. Persist the configuration failure so a
      // restart cannot turn "cron fired but safely skipped" into "cron never
      // fired".
      runId = await PgRetentionRun.start({ configuredRetentionDays: null, targetBytes: null });
      await finishRun({ status: 'skipped', detail: 'invalid PG_MESSAGE_RETENTION_DAYS' });
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

    // Start the durable observation BEFORE touching entitlement or messages.
    // If this fails, the outer catch leaves without deleting invisibly.
    runId = await PgRetentionRun.start({
      configuredRetentionDays: Math.trunc(startDays),
      targetBytes,
    });

    // Resolved ONCE per run and threaded through every tier below, including
    // the step-down. A failure here aborts before a single row is deleted —
    // see resolveProtectedPodIds.
    let protectedPodIds: string[];
    try {
      protectedPodIds = await resolveProtectedPodIds();
    } catch (err) {
      await finishRun({
        status: 'aborted',
        detail: `could not resolve Pro-protected pods: ${(err as Error).message}`,
      });
      console.error(
        '[pg-retention] ABORT: could not resolve Pro-protected pods, refusing to delete: %s',
        (err as Error).message,
      );
      return;
    }
    protectedPodCount = protectedPodIds.length;

    initialSize = await getDatabaseSizeBytes();
    console.log(
      `[pg-retention] start: size=${initialSize !== null ? formatBytes(initialSize) : 'unknown'} ` +
      `target=${formatBytes(targetBytes)} (${targetPct}% of ${formatBytes(capacity)}) ` +
      `retention=${startDays}d step=${stepDays}d protectedPods=${protectedPodIds.length}`,
    );

    currentDays = Math.max(FLOOR_DAYS, Math.trunc(startDays));

    const first = await Message.deleteOlderThan(currentDays, protectedPodIds);
    totalDeleted += first.deleted || 0;
    await vacuumMessages();
    size = await getDatabaseSizeBytes();
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
      const tierResult = await Message.deleteOlderThan(currentDays, protectedPodIds);
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
    await finishRun({ status: 'completed' });
  } catch (err) {
    await finishRun({ status: 'failed', detail: (err as Error).message });
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
