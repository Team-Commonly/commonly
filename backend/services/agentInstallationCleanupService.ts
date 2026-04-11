/**
 * agentInstallationCleanupService
 *
 * Daily cron that marks stale AgentInstallation rows (owning agent user has no
 * valid runtime tokens AND no recent AgentEvent activity), then prunes installs
 * that have been stale long enough. Also removes pruned agent users from pod
 * membership so the Agent Hub stops listing dead sessions.
 *
 * Kept separate from schedulerService + pgRetentionService so other tracks can
 * edit those files without stomping on this cron (and vice versa).
 *
 * Env var overrides:
 *   INSTALLATION_STALENESS_EVENT_DAYS    default 7  (days since last event before marking stale)
 *   INSTALLATION_PRUNE_AFTER_STALE_DAYS  default 14 (days after staleSince before deletion)
 */

// eslint-disable-next-line global-require
const cron = require('node-cron');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const AgentEvent = require('../models/AgentEvent');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const AgentIdentityService = require('./agentIdentityService');

const DEFAULT_STALENESS_EVENT_DAYS = 7;
const DEFAULT_PRUNE_AFTER_STALE_DAYS = 14;

interface CronJob {
  start(): void;
  stop(): void;
}

let scheduledJob: CronJob | null = null;

function resolveDays(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return NaN;
  }
  return parsed;
}

/**
 * Returns true if a user has at least one runtime token that is currently
 * valid (not expired). Tokens with a null/missing `expiresAt` are treated as
 * INVALID — session tokens always set an expiry, and null-expiry entries are
 * stragglers from earlier code paths that we explicitly want to reap.
 */
function hasValidRuntimeToken(user: { agentRuntimeTokens?: Array<{ expiresAt?: Date | null }> } | null): boolean {
  if (!user || !Array.isArray(user.agentRuntimeTokens)) return false;
  const now = Date.now();
  return user.agentRuntimeTokens.some((t) => {
    if (!t || !t.expiresAt) return false;
    const exp = t.expiresAt instanceof Date ? t.expiresAt.getTime() : new Date(t.expiresAt as any).getTime();
    return Number.isFinite(exp) && exp > now;
  });
}

/**
 * Scan every active AgentInstallation and mark it stale when the owning agent
 * user has no valid runtime tokens AND the latest AgentEvent for
 * (agentName, instanceId) is older than `daysSinceLastEvent` (or no events
 * exist at all).
 */
export async function markStaleInstallations(
  daysSinceLastEvent: number = DEFAULT_STALENESS_EVENT_DAYS,
): Promise<{ marked: number }> {
  if (!Number.isFinite(daysSinceLastEvent) || daysSinceLastEvent <= 0) {
    console.warn(
      '[installation-cleanup] invalid daysSinceLastEvent, skipping mark step (value=%s)',
      daysSinceLastEvent,
    );
    return { marked: 0 };
  }

  const cutoff = new Date(Date.now() - daysSinceLastEvent * 24 * 60 * 60 * 1000);

  // Pull only the fields we need. Installations are scoped per pod × agent ×
  // instanceId so this set is bounded and cheap to stream.
  const activeInstalls = await AgentInstallation.find({ status: 'active' })
    .select('_id agentName instanceId podId')
    .lean();

  if (!activeInstalls.length) {
    return { marked: 0 };
  }

  // Dedup the (agentName, instanceId) pairs so we only do one User lookup and
  // one AgentEvent lookup per unique agent-instance, even when the same agent
  // is installed into multiple pods.
  const pairKey = (a: string, i: string) => `${a}::${i || 'default'}`;
  const uniquePairs = new Map<string, { agentName: string; instanceId: string }>();
  for (const inst of activeInstalls) {
    uniquePairs.set(pairKey(inst.agentName, inst.instanceId), {
      agentName: inst.agentName,
      instanceId: inst.instanceId || 'default',
    });
  }

  const stalePairs = new Set<string>();

  for (const { agentName, instanceId } of uniquePairs.values()) {
    try {
      // Check owning user's runtime tokens
      const username = AgentIdentityService.buildAgentUsername(agentName, instanceId);
      const user = await User.findOne({ username })
        .select('agentRuntimeTokens')
        .lean();
      if (hasValidRuntimeToken(user)) {
        continue;
      }

      // Check most recent AgentEvent for this (agentName, instanceId)
      const latestEvent = await AgentEvent.findOne({ agentName, instanceId })
        .select('createdAt')
        .sort({ createdAt: -1 })
        .lean();

      if (latestEvent && latestEvent.createdAt && new Date(latestEvent.createdAt).getTime() > cutoff.getTime()) {
        continue; // recent activity → not stale
      }

      stalePairs.add(pairKey(agentName, instanceId));
    } catch (err) {
      console.error(
        '[installation-cleanup] error evaluating staleness for %s/%s: %s',
        agentName,
        instanceId,
        (err as Error).message,
      );
    }
  }

  if (!stalePairs.size) {
    return { marked: 0 };
  }

  // Build the OR filter once and updateMany — touches all pods of each stale
  // pair. `status: 'active'` guard keeps repeated runs idempotent.
  const now = new Date();
  const orClauses = Array.from(stalePairs).map((key) => {
    const [agentName, instanceId] = key.split('::');
    return { agentName, instanceId };
  });

  const result = await AgentInstallation.updateMany(
    { status: 'active', $or: orClauses },
    { $set: { status: 'stale', staleSince: now } },
  );

  const marked = result?.modifiedCount ?? result?.nModified ?? 0;
  return { marked };
}

/**
 * Delete installs that have been marked stale for longer than
 * `minStaleAgeDays`. Also pulls the agent user out of the install's pod
 * members array so the Agent Hub stops listing it.
 */
export async function pruneStaleInstallations(
  minStaleAgeDays: number = DEFAULT_PRUNE_AFTER_STALE_DAYS,
): Promise<{ deleted: number }> {
  if (!Number.isFinite(minStaleAgeDays) || minStaleAgeDays <= 0) {
    console.warn(
      '[installation-cleanup] invalid minStaleAgeDays, skipping prune step (value=%s)',
      minStaleAgeDays,
    );
    return { deleted: 0 };
  }

  const cutoff = new Date(Date.now() - minStaleAgeDays * 24 * 60 * 60 * 1000);

  const prunable = await AgentInstallation.find({
    status: 'stale',
    staleSince: { $lte: cutoff },
  })
    .select('_id agentName instanceId podId')
    .lean();

  if (!prunable.length) {
    return { deleted: 0 };
  }

  let deleted = 0;
  for (const inst of prunable) {
    try {
      // Remove the agent user from the pod's members array so it stops
      // appearing in pod sidebars. Schema invariant: members is a flat
      // ObjectId array — use $pull against the agent user's _id.
      const username = AgentIdentityService.buildAgentUsername(inst.agentName, inst.instanceId || 'default');
      const agentUser = await User.findOne({ username }).select('_id').lean();
      if (agentUser && inst.podId) {
        await Pod.updateOne({ _id: inst.podId }, { $pull: { members: agentUser._id } });
      }

      await AgentInstallation.deleteOne({ _id: inst._id });
      deleted += 1;
    } catch (err) {
      console.error(
        '[installation-cleanup] failed to prune install %s (%s/%s): %s',
        inst._id,
        inst.agentName,
        inst.instanceId,
        (err as Error).message,
      );
    }
  }

  return { deleted };
}

export async function runCleanup(): Promise<void> {
  try {
    const eventDays = resolveDays('INSTALLATION_STALENESS_EVENT_DAYS', DEFAULT_STALENESS_EVENT_DAYS);
    const pruneDays = resolveDays('INSTALLATION_PRUNE_AFTER_STALE_DAYS', DEFAULT_PRUNE_AFTER_STALE_DAYS);

    if (!Number.isFinite(eventDays) || eventDays <= 0) {
      console.warn(
        '[installation-cleanup] invalid INSTALLATION_STALENESS_EVENT_DAYS, skipping (value=%s)',
        process.env.INSTALLATION_STALENESS_EVENT_DAYS,
      );
      return;
    }
    if (!Number.isFinite(pruneDays) || pruneDays <= 0) {
      console.warn(
        '[installation-cleanup] invalid INSTALLATION_PRUNE_AFTER_STALE_DAYS, skipping (value=%s)',
        process.env.INSTALLATION_PRUNE_AFTER_STALE_DAYS,
      );
      return;
    }

    console.log(
      `[installation-cleanup] running: mark stale after ${eventDays}d inactivity, prune after ${pruneDays}d stale`,
    );
    const markResult = await markStaleInstallations(eventDays);
    console.log(`[installation-cleanup] mark done: marked ${markResult.marked} install(s) stale`);
    const pruneResult = await pruneStaleInstallations(pruneDays);
    console.log(`[installation-cleanup] prune done: deleted ${pruneResult.deleted} stale install(s)`);
  } catch (err) {
    // Swallow so cron keeps running — never crash the host process from a
    // cleanup failure. Next run will retry.
    console.error('[installation-cleanup] failed:', (err as Error).message);
  }
}

export function initInstallationCleanup(): void {
  if (scheduledJob) {
    console.log('[installation-cleanup] already scheduled, skipping re-init');
    return;
  }
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  try {
    // 04:00 UTC — one hour after pgRetention (03:00 UTC) to avoid overlapping
    // load on the DB during off-peak window.
    scheduledJob = cron.schedule('0 4 * * *', runCleanup, { timezone: 'UTC' }) as CronJob;
    console.log('[installation-cleanup] scheduled daily cleanup at 04:00 UTC');
  } catch (err) {
    console.error('[installation-cleanup] failed to schedule cron:', (err as Error).message);
  }
}

export default {
  markStaleInstallations,
  pruneStaleInstallations,
  runCleanup,
  initInstallationCleanup,
};

// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
