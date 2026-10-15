/*
 * Purge the throwaway accounts the stranger journey signs up (TASK-260).
 *
 * The journey (k8s/helm/commonly/files/stranger-journey.py) registers
 * `eng-smoke-journey-<10 digits>@ops.commonly.invalid` twice a day and after
 * every deploy. Its own cleanup can only uninstall the seat and delete the pod:
 * there is no self-delete route, and the admin delete removes the Mongo user
 * row only. Everything else a signup leaves behind would otherwise accumulate
 * as fake users. This removes exactly that footprint, and nothing that a real
 * person could own:
 *
 *   per synthetic user H (all three must hold: username pattern, email domain,
 *   not a bot) and older than minAgeMs:
 *     pods created by H     → deletePodCascade + the pod-keyed rows it does not
 *                             cover (tasks, agent events/runs, approvals,
 *                             attention items, first-message and silence marks,
 *                             PG message claims)
 *     Scout's per-user bot  → its User (Mongo + PG), memory, events
 *     seats H approved      → the ephemeral registry row, its bot User if one
 *                             was ever minted, its memory and installations
 *     H itself              → user-keyed rows, Community pod membership, the
 *                             PG users row, the Mongo user
 *
 * Registration is open and accepts .invalid, so ANYONE can create an account
 * this selects; the purge must therefore never reach an identity such an
 * account merely names. A pod H created that another HUMAN has joined refuses
 * the whole account. A seat H published is cleaned only if all of these hold,
 * and is otherwise skipped and reported with its reason:
 *   - its name starts with the journey prefix (the BYO link derives seat names
 *     from the account's username, so journey seats always carry it);
 *   - no one else has an installation of that name;
 *   - its bot user, if any, was created at or after H (an account cannot own
 *     an identity older than itself).
 * Memory is deleted only for the seat's own (name, 'default') instance. Names
 * are not yet owned by an identity (TASK-270); once they are, the seat test
 * becomes "the seat's owner is H". Dry run is the default.
 */
const User = require('../models/User');
const Pod = require('../models/Pod');
const Task = require('../models/Task');
const AgentEvent = require('../models/AgentEvent');
const AgentRun = require('../models/AgentRun');
const ApprovalAction = require('../models/ApprovalAction');
const AttentionItem = require('../models/AttentionItem');
const PodMemberFirstMessage = require('../models/PodMemberFirstMessage');
const OnboardingSilenceEpisode = require('../models/OnboardingSilenceEpisode');
const AgentMemory = require('../models/AgentMemory');
const Summary = require('../models/Summary');
const { AgentRegistry, AgentInstallation } = require('../models/AgentRegistry');
const { perUserInstanceId } = require('./personaHireService');
const { deletePodCascade } = require('./podDeletionService');

export const SYNTHETIC_USERNAME = /^eng-smoke-journey-\d{10}$/;
export const SYNTHETIC_EMAIL_DOMAIN = '@ops.commonly.invalid';
// The same domain as a query, written as a literal rather than escaped from
// the string at runtime.
const SYNTHETIC_EMAIL = /@ops\.commonly\.invalid$/i;
export const SYNTHETIC_SEAT_PREFIX = 'eng-smoke-journey-';
const DEFAULT_MIN_AGE_MS = 2 * 60 * 60 * 1000;

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
}

export interface AccountReport {
  userId: string;
  username: string;
  refused?: string;
  pods: string[];
  scoutBot: string | null;
  seats: string[];
  /** Seats left alone, and why. */
  skippedSeats: { name: string; reason: string }[];
}

export interface PurgeReport {
  dryRun: boolean;
  examined: number;
  accounts: AccountReport[];
  /** Rows matched (dry run) or deleted (apply), per store. */
  counts: Record<string, number>;
}

export const isSyntheticAccount = (user: { username?: string; email?: string; isBot?: boolean } | null): boolean => (
  !!user
  && user.isBot !== true
  && SYNTHETIC_USERNAME.test(String(user.username || ''))
  && String(user.email || '').toLowerCase().endsWith(SYNTHETIC_EMAIL_DOMAIN)
);

const loadPool = (): PgPool | null => {
  if (!process.env.PG_HOST) return null;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  return require('../config/db-pg').pool as PgPool;
};

export const purgeSyntheticAccounts = async (
  { apply = false, minAgeMs = DEFAULT_MIN_AGE_MS, now = new Date(), pool = loadPool() }:
  { apply?: boolean; minAgeMs?: number; now?: Date; pool?: PgPool | null } = {},
): Promise<PurgeReport> => {
  const report: PurgeReport = { dryRun: !apply, examined: 0, accounts: [], counts: {} };
  const tally = (store: string, n: number | undefined) => {
    report.counts[store] = (report.counts[store] || 0) + (n || 0);
  };
  // Dry run counts what a delete would remove; apply deletes and counts that.
  const remove = async (store: string, model: any, filter: Record<string, unknown>) => {
    if (!apply) return tally(store, await model.countDocuments(filter));
    const res = await model.deleteMany(filter);
    return tally(store, res.deletedCount);
  };
  const pgRemove = async (store: string, sql: string, params: unknown[]) => {
    if (!pool) return;
    if (!apply) {
      const { rows } = await pool.query(sql.replace(/^DELETE FROM (\w+)/, 'SELECT count(*)::int AS n FROM $1'), params);
      tally(store, Number(rows[0]?.n || 0));
      return;
    }
    const res = await pool.query(sql, params);
    tally(store, res.rowCount ?? res.rows.length);
  };

  const candidates = await User.find({
    username: SYNTHETIC_USERNAME,
    email: SYNTHETIC_EMAIL,
    isBot: { $ne: true },
    createdAt: { $lt: new Date(now.getTime() - minAgeMs) },
  }).select('_id username email isBot createdAt').lean();
  report.examined = candidates.length;

  for (const human of candidates) {
    if (!isSyntheticAccount(human)) continue; // the query and the predicate must both agree
    const humanId = String(human._id);
    const scoutUsername = `scout-${perUserInstanceId(humanId)}`;
    const scoutBot = await User.findOne({ username: scoutUsername, isBot: true }).select('_id').lean();
    const seatRows = await AgentRegistry.find({ 'publisher.userId': human._id, ephemeral: true })
      .select('agentName').lean();
    const skippedSeats: { name: string; reason: string }[] = [];
    const seatNames: string[] = [];
    const seatBots: { _id: unknown; username: string }[] = [];
    for (const { agentName } of seatRows as { agentName: string }[]) {
      if (!agentName.startsWith(SYNTHETIC_SEAT_PREFIX)) {
        skippedSeats.push({ name: agentName, reason: 'name lacks the journey prefix' });
        continue;
      }
      if (await AgentInstallation.exists({ agentName, installedBy: { $ne: human._id } })) {
        skippedSeats.push({ name: agentName, reason: 'installed by another user' });
        continue;
      }
      const bot = await User.findOne({ username: agentName, isBot: true, email: `${agentName}@agents.commonly.local` })
        .select('_id username createdAt').lean();
      if (bot && (!bot.createdAt || !human.createdAt || new Date(bot.createdAt) < new Date(human.createdAt))) {
        skippedSeats.push({ name: agentName, reason: 'its bot user predates the account' });
        continue;
      }
      seatNames.push(agentName);
      if (bot) seatBots.push(bot);
    }
    const ownIds = new Set([humanId, scoutBot && String(scoutBot._id), ...seatBots.map((b: any) => String(b._id))]
      .filter(Boolean) as string[]);

    const pods = await Pod.find({ createdBy: human._id }).select('_id members').lean();
    const account: AccountReport = {
      userId: humanId,
      username: human.username,
      pods: pods.map((p: any) => String(p._id)),
      scoutBot: scoutBot ? scoutUsername : null,
      seats: seatNames,
      skippedSeats,
    };
    report.accounts.push(account);
    const foreignIds = pods.flatMap((p: any) => (p.members || []).map(String)).filter((m: string) => !ownIds.has(m));
    const foreignHuman = foreignIds.length
      ? await User.findOne({ _id: { $in: foreignIds }, isBot: { $ne: true } }).select('_id').lean()
      : null;
    if (foreignHuman) {
      account.refused = `a pod created by this account has another human member (${String(foreignHuman._id)})`;
      continue;
    }

    for (const pod of pods) {
      const podId = String(pod._id);
      await remove('tasks', Task, { podId });
      await remove('agentevents', AgentEvent, { podId });
      await remove('agentruns', AgentRun, { podId });
      await remove('approvalactions', ApprovalAction, { podId });
      await remove('attentionitems', AttentionItem, { podId });
      await remove('podmemberfirstmessages', PodMemberFirstMessage, { podId });
      await remove('onboardingsilenceepisodes', OnboardingSilenceEpisode, { podId });
      await pgRemove('pg.message_claims', 'DELETE FROM message_claims WHERE pod_id = $1', [podId]);
      if (apply) await deletePodCascade(podId);
      tally('pods', 1);
    }

    if (scoutBot) {
      const instanceId = perUserInstanceId(humanId);
      await remove('agentmemories', AgentMemory, { agentName: 'scout', instanceId });
      await remove('agentevents', AgentEvent, { agentName: 'scout', instanceId });
      await pgRemove('pg.users', 'DELETE FROM users WHERE _id = $1', [String(scoutBot._id)]);
      await remove('users', User, { _id: scoutBot._id });
    }

    for (const name of seatNames) {
      await remove('agentmemories', AgentMemory, { agentName: name, instanceId: 'default' });
      await remove('agentinstallations', AgentInstallation, { agentName: name, installedBy: human._id });
      await remove('agentregistries', AgentRegistry, { agentName: name, 'publisher.userId': human._id, ephemeral: true });
    }
    for (const bot of seatBots) {
      await pgRemove('pg.users', 'DELETE FROM users WHERE _id = $1', [String(bot._id)]);
      await remove('users', User, { _id: bot._id });
    }

    await remove('approvalactions', ApprovalAction, { ownerUserId: human._id });
    await remove('attentionitems', AttentionItem, { recipientUserId: human._id });
    await remove('summaries', Summary, { 'metadata.userId': { $in: [human._id, humanId] } });
    await remove('onboardingsilenceepisodes', OnboardingSilenceEpisode, { userId: human._id });
    await remove('podmemberfirstmessages', PodMemberFirstMessage, { userId: human._id });
    if (apply) {
      const res = await Pod.updateMany({ members: human._id }, { $pull: { members: human._id } });
      tally('pod.members', res.modifiedCount);
    } else {
      tally('pod.members', await Pod.countDocuments({ members: human._id, createdBy: { $ne: human._id } }));
    }
    await pgRemove('pg.pod_members', 'DELETE FROM pod_members WHERE user_id = $1', [humanId]);
    await pgRemove('pg.users', 'DELETE FROM users WHERE _id = $1', [humanId]);
    await remove('users', User, { _id: human._id });
  }
  return report;
};

// CJS compat, same shape as sibling services.
module.exports = {
  purgeSyntheticAccounts, isSyntheticAccount, SYNTHETIC_USERNAME, SYNTHETIC_EMAIL_DOMAIN,
};
