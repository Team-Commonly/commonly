import { DM_POD_TYPES_GUARD } from './agentIdentityService';
import { withAdminUserMutationLock } from './adminUserMutationService';
/*
 * Purge the throwaway accounts the stranger journey signs up (TASK-260).
 *
 * The journey (k8s/helm/commonly/files/stranger-journey.py) registers
 * `eng-smoke-journey-<10 digits>@ops.commonly.invalid` twice a day and after
 * every deploy. Its own cleanup can only uninstall the seat and delete the pod:
 * there is no self-delete route, and the admin delete removes the Mongo user
 * row only. Everything else a signup leaves behind would otherwise accumulate
 * as fake users. Cleanup is limited by the footprint and dependency refusals
 * below; these are snapshot checks, not a fence against concurrent installs.
 * Foreign group dependencies of disposable bots remain tracked in TASK-007:
 *
 *   per synthetic user H (all three must hold: username pattern, email domain,
 *   not a bot) and older than minAgeMs:
 *     disposable pods by H → deletePodCascade + the pod-keyed rows it does not
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
 * the whole account. A seat H published is cleaned only if all of these hold;
 * otherwise it is skipped, reported with its reason, and the whole account is
 * refused, because deleting H would orphan the seat: install refuses an
 * ephemeral registry row to anyone but its publisher (routes/registry/
 * install.ts), so the name would be dead for everyone, permanently. A leftover
 * test account is harmless; a dead name is not.
 *   - its name starts with the journey prefix (the BYO link derives seat names
 *     from the account's username, so journey seats always carry it);
 *   - no one else has an installation of that name;
 *   - its bot user, if any, was created at or after H (an account cannot own
 *     an identity older than itself).
 * DMs with participants outside this disposable footprint retain their historical
 * pair and data. A disposable bot used by another DM or a Scout installed by
 * another owner refuses the account purge. Any pod selected for cascade with an
 * outside-footprint installation also refuses before cleanup. Shared-pod
 * membership still removes H.
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
const AgentCredential = require('../models/AgentCredential');
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
  /** Historical DMs retained for a participant outside the disposable footprint. */
  preservedDms: string[];
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

const purgeSyntheticAccountsUnlocked = async (
  { apply = false, minAgeMs = DEFAULT_MIN_AGE_MS, now = new Date(), pool = loadPool() }:
  { apply?: boolean; minAgeMs?: number; now?: Date; pool?: PgPool | null } = {},
  beginWrite: () => void = () => {},
): Promise<PurgeReport> => {
  const report: PurgeReport = { dryRun: !apply, examined: 0, accounts: [], counts: {} };
  const tally = (store: string, n: number | undefined) => {
    report.counts[store] = (report.counts[store] || 0) + (n || 0);
  };
  // Dry run counts what a delete would remove; apply deletes and counts that.
  const remove = async (store: string, model: any, filter: Record<string, unknown>) => {
    if (!apply) return tally(store, await model.countDocuments(filter));
    beginWrite();
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
    beginWrite();
    const res = await pool.query(sql, params);
    tally(store, res.rowCount ?? res.rows.length);
  };

  const candidates = await User.find({
    username: SYNTHETIC_USERNAME,
    email: SYNTHETIC_EMAIL,
    isBot: { $ne: true },
    role: { $ne: 'admin' },
    createdAt: { $lt: new Date(now.getTime() - minAgeMs) },
  }).select('_id username email isBot createdAt').lean();
  report.examined = candidates.length;

  for (const human of candidates) {
    if (!isSyntheticAccount(human)) continue; // the query and the predicate must both agree
    const humanId = String(human._id);
    const scoutUsername = `scout-${perUserInstanceId(humanId)}`;
    const scoutBot = await User.findOne({ username: scoutUsername, isBot: true, role: { $ne: 'admin' } })
      .select('_id').lean();
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
        .select('_id username createdAt role').lean();
      if (bot?.role === 'admin') {
        skippedSeats.push({ name: agentName, reason: 'its bot user is an administrator' });
        continue;
      }
      if (bot && (!bot.createdAt || !human.createdAt || new Date(bot.createdAt) < new Date(human.createdAt))) {
        skippedSeats.push({ name: agentName, reason: 'its bot user predates the account' });
        continue;
      }
      seatNames.push(agentName);
      if (bot) seatBots.push(bot);
    }
    const ownIds = new Set([humanId, scoutBot && String(scoutBot._id), ...seatBots.map((b: any) => String(b._id))]
      .filter(Boolean) as string[]);

    const createdPods = await Pod.find({ createdBy: human._id }).select('_id type members').lean();
    const preservedDms = createdPods.filter((pod: any) => DM_POD_TYPES_GUARD.has(String(pod.type))
      && (pod.members || []).some((member: unknown) => !ownIds.has(String(member))));
    const preservedIds = new Set(preservedDms.map((pod: any) => String(pod._id)));
    const pods = createdPods.filter((pod: any) => !preservedIds.has(String(pod._id)));
    const account: AccountReport = {
      userId: humanId,
      username: human.username,
      pods: pods.map((p: any) => String(p._id)),
      scoutBot: scoutBot ? scoutUsername : null,
      seats: seatNames,
      skippedSeats,
      preservedDms: preservedDms.map((pod: any) => String(pod._id)),
    };
    report.accounts.push(account);
    if (skippedSeats.length) {
      const seats = skippedSeats.map((seat) => `${seat.name} (${seat.reason})`).join(', ');
      account.refused = `deleting this account would orphan its skipped seat(s): ${seats}`;
      continue;
    }
    // A disposable bot can acquire a life outside this throwaway footprint.
    // Refuse rather than deleting an identity another DM still depends on.
    if (scoutBot && await AgentInstallation.exists({
      agentName: 'scout', instanceId: perUserInstanceId(humanId), installedBy: { $ne: human._id },
    })) {
      account.refused = 'the disposable Scout is installed by another user';
      continue;
    }
    const disposableBotIds = [scoutBot?._id, ...seatBots.map((bot: any) => bot._id)].filter(Boolean);
    const botDms = disposableBotIds.length ? await Pod.find({
      type: { $in: [...DM_POD_TYPES_GUARD] }, members: { $in: disposableBotIds },
    }).select('createdBy members').lean() : [];
    if (botDms.some((pod: any) => String(pod.createdBy) !== humanId
      || (pod.members || []).some((member: unknown) => !ownIds.has(String(member))))) {
      account.refused = 'a disposable agent participates in a DM outside the synthetic footprint';
      continue;
    }
    // Cascading a disposable pod removes every installation in it. Membership
    // alone cannot prove ownership: an outside installer need not be a member.
    if (pods.length && await AgentInstallation.exists({
      podId: { $in: pods.map((pod: any) => pod._id) }, installedBy: { $nin: [...ownIds] },
    })) {
      account.refused = 'a disposable pod has an installation owned outside the synthetic footprint';
      continue;
    }
    const foreignIds = createdPods.flatMap((p: any) => (p.members || []).map(String))
      .filter((member: string) => !ownIds.has(member));
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
      if (apply) {
        beginWrite();
        await deletePodCascade(podId);
      }
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
      const credentials = await AgentCredential.find({ ownerUserId: human._id }).select('_id').lean();
      beginWrite();
      await AgentCredential.revokeCascade(credentials.map((credential: any) => credential._id));
      const paused = await AgentInstallation.updateMany(
        { installedBy: human._id, status: 'active' }, { $set: { status: 'paused' } },
      );
      tally('agentinstallations.paused', paused.modifiedCount);
      const res = await Pod.updateMany(
        { members: human._id, type: { $nin: [...DM_POD_TYPES_GUARD] } },
        { $pull: { members: human._id } },
      );
      tally('pod.members', res.modifiedCount);
    } else {
      tally('agentinstallations.paused', await AgentInstallation.countDocuments({
        installedBy: human._id, status: 'active', podId: { $nin: pods.map((pod: any) => pod._id) },
      }));
      tally('pod.members', await Pod.countDocuments({
        members: human._id, createdBy: { $ne: human._id }, type: { $nin: [...DM_POD_TYPES_GUARD] },
      }));
    }
    const dmTypes = [...DM_POD_TYPES_GUARD];
    const dmParams = dmTypes.map((_type, index) => `$${index + 2}`).join(', ');
    await pgRemove('pg.pod_members',
      `DELETE FROM pod_members WHERE user_id = $1
       AND pod_id NOT IN (SELECT id FROM pods WHERE type IN (${dmParams}))`, [humanId, ...dmTypes]);
    await pgRemove('pg.users', 'DELETE FROM users WHERE _id = $1', [humanId]);
    await remove('users', User, { _id: human._id });
  }
  return report;
};

// Applying the purge can remove User rows. Keep selection and deletion in the
// same critical section as online role writers so a candidate cannot become an
// administrator between those steps. Dry runs perform no destructive writes.
export const purgeSyntheticAccounts = async (
  options: Parameters<typeof purgeSyntheticAccountsUnlocked>[0] = {},
): Promise<PurgeReport> => (options.apply
  ? withAdminUserMutationLock((beginWrite) => purgeSyntheticAccountsUnlocked(options, beginWrite))
  : purgeSyntheticAccountsUnlocked(options));

// CJS compat, same shape as sibling services.
module.exports = {
  purgeSyntheticAccounts, isSyntheticAccount, SYNTHETIC_USERNAME, SYNTHETIC_EMAIL_DOMAIN,
};
