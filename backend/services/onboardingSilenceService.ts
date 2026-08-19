import mongoose from 'mongoose';
import OnboardingSilenceEpisode, { IAgentEventSnapshot } from '../models/OnboardingSilenceEpisode';
import { HUMAN_FILTER, BOT_FILTER } from './userClassification';

/**
 * "Signed up, typed, got no reply" — the onboarding-silence alert (W4 item 2).
 *
 * WHAT THIS EXISTS FOR. On 2026-08-14 every onboarding defect we know about
 * was found by a human deciding to read production transcripts: an inert
 * honesty fix, a Map read that defeated three separate callers, a migration
 * that would have written nothing and reported success, a summarizer failing
 * on a cron for a month unnoticed. The fixes were real; the detection was a
 * person choosing to look. This service is the part that does not require
 * anyone to choose.
 *
 * It answers exactly one question, on a cron: did a newcomer say something in
 * a room that could have answered, and did nothing answer?
 *
 * CALIBRATION (pod-architect, 2026-08-15 — against production, not intuition):
 *
 * - **15 minutes, wall-clock.** Derived from the queue's own constants rather
 *   than from the observed reply spread, because the spread is a sample of a
 *   system that mostly worked and the constants stay true when the sample
 *   changes. AGENT_EVENT_REQUEUE_DELIVERED_MINUTES is 10, so anything under
 *   ~12 fires inside a legitimate retry. The upper bracket was
 *   AGENT_EVENT_STALE_PENDING_MINUTES at 30, past which the evidence used to be
 *   deleted along with the answer; 15 sat between the two. That upper bracket
 *   is gone as of 2026-08-18 — pending rows now age out on the 168h clock
 *   (#993) — so only the lower constraint still derives this number, and 15 is
 *   now a floor plus a judgement about how long a newcomer should wait, not a
 *   midpoint. Re-deriving it from the constants alone will no longer reproduce
 *   it. (Observed replies agree with the value: every genuine one in 21 days
 *   landed inside 107 seconds, and the next cluster was 10+ hours.)
 *
 * - **Not idle-gated.** "Fire only if the user has since gone idle" would be
 *   measured by `lastActive`, which over-counts — V2PodChat polls every 60s,
 *   so an abandoned open tab reads as presence. Idle-gating would also make
 *   the rate incomparable across cohorts, which kills the alert's second job:
 *   telling us whether a fix worked.
 *
 * - **The pod must contain >= 1 ACTIVE AgentInstallation**, not merely an
 *   agent in `pod.members`. A member without an installation gets 403 when it
 *   tries to post, so it was never going to answer either. This is the same
 *   predicate the posting path itself uses, so the alert and the kernel agree
 *   on "could anything have answered here" by construction.
 *
 * - **Only a bot author counts as a reply.** The claim being made is *the
 *   platform did not answer*; a human answering is a different outcome and a
 *   good one, and folding it in weakens the claim. It is recorded as its own
 *   outcome (`human-rescued`) rather than discarded — at the 10h/13h latencies
 *   seen in production it mostly says the room was being read, not that the
 *   product worked.
 *
 * WHAT THIS DOES NOT DO. It does not nudge the user; that is the
 * stalled-connect trigger (W4 item 3, ux-lead's spec), which fires on install
 * state rather than on conversational outcome and speaks to the user rather
 * than to us. The two are complementary: a seat whose token was never used is
 * caught by that one before anybody types, and a Scout that breaks tonight is
 * caught by this one, which knows nothing about tokens.
 */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * FLOOR — and the current value is below it. See #1008.
 *
 * The floor is not `AGENT_EVENT_REQUEUE_DELIVERED_MINUTES` (10). That constant
 * is a threshold, and the requeue runs on a ten-minute cron, so redelivery lands
 * uniformly across `[T, T+P)` = 10-20 minutes, mean ~15 — stated outright at
 * `agentEventService.ts:632-635`, which ends "Change both numbers together."
 * The real floor is therefore **20 plus margin**, and 15 sits at the MEAN of
 * the window it was supposed to clear: for any delivered-but-unacked event,
 * roughly half of legitimate retries are still in flight when this fires.
 *
 * Ceiling: re-derived from the reply distribution rather than from the
 * collector, after #993 removed the 30-minute pending-GC bracket. Every genuine
 * reply measured over 21 days landed inside 107 SECONDS, next cluster 10+ hours.
 * Nothing legitimate occupies the gap, so time above the floor buys no accuracy
 * — it only delays the alert.
 *
 * Those two together give the rule, and note it INVERTS the guidance this
 * comment carried until 2026-08-18: keep the value just above the 20-minute
 * band, not just above 10. Raising 15 → ~22 is a gain, not the "pure loss" the
 * earlier text claimed, because the earlier text had the floor wrong. The value
 * is left at 15 here deliberately — moving a live alert is #1008's call, with
 * the false-positive rate measured rather than derived.
 *
 * NOT CURRENTLY MISFIRING, and the reason is the same distribution
 * (@sprint-review). A reply produced by a redelivery would have to land at
 * 10-20+ min — inside the span that measured EMPTY over 21 days — so the retry
 * path has never produced a genuine reply here, and an alert at 15 has never
 * pre-empted one. #1008 is a documentation inconsistency plus a latent defect,
 * not a live incident.
 *
 * The latent half is worth naming, because #993's fix arms it: those 21 days
 * were measured in a regime where the retry path was structurally broken — the
 * `attempts < cap` guard vacuous, the retire pass unreachable, and pending rows
 * deleted at 30 min before three deliveries could accumulate. Give events 168h
 * and they get retried for real. More retries is more chance a retry succeeds,
 * and the first retry-produced reply lands squarely in the window this
 * threshold sits at the mean of. Re-measure the distribution after that
 * deploys; do not carry the empty-gap finding across it.
 */
export const SILENCE_THRESHOLD_MINUTES = Number(
  process.env.ONBOARDING_SILENCE_THRESHOLD_MINUTES || 15,
);

/** "Newcomer" — how long after signup a silence still counts as onboarding. */
export const ONBOARDING_WINDOW_DAYS = Number(
  process.env.ONBOARDING_SILENCE_WINDOW_DAYS || 7,
);

/**
 * How far back a single pass looks for messages to judge.
 *
 * The cron runs far more often than this, so passes overlap heavily and a
 * missed tick (deploy, restart, PG blip) is picked up by the next one instead
 * of falling through the floor. Re-scanning is safe because the episode index
 * makes opening idempotent — the same drop-proof-by-re-derivation argument
 * ux-lead's stalled-connect spec uses to prefer a cron over a delayed event.
 */
export const SCAN_LOOKBACK_HOURS = Number(
  process.env.ONBOARDING_SILENCE_LOOKBACK_HOURS || 24,
);

/**
 * Above this many NEW episodes in a rolling hour, individual delivery collapses
 * into one rollup.
 *
 * The per-incident base rate is ~1/day, measured on a system that works. The
 * failure this alert exists to catch is a regression, and a regression strands
 * users in bulk — which is precisely when per-incident becomes twenty pages in
 * a minute. Cheap to add now, expensive to add during the incident that needs
 * it.
 */
export const ROLLUP_COLLAPSE_THRESHOLD = Number(
  process.env.ONBOARDING_SILENCE_ROLLUP_THRESHOLD || 5,
);

/**
 * How long an open episode keeps being checked for a late answer.
 *
 * Resolution costs one PG query per open episode per pass, forever, and an
 * episode nobody ever answered never closes on its own — so without a bound
 * the steady-state cost of this cron grows monotonically with the number of
 * users we failed. That is precisely backwards.
 *
 * Past this window an episode STAYS open rather than being auto-closed,
 * because "open" is a true statement about it: nothing ever answered. It just
 * stops being polled. Auto-closing would be cheaper and would also be a lie.
 */
export const RESOLUTION_WINDOW_DAYS = Number(
  process.env.ONBOARDING_SILENCE_RESOLUTION_WINDOW_DAYS || 7,
);

export interface SilenceEpisodeSummary {
  episodeId: string;
  userId: string;
  username?: string;
  podId: string;
  podName?: string;
  firstMessageId: string;
  firstTypedAt: Date;
  accountAgeMinutes: number;
  messageCount: number;
  eventSnapshot?: IAgentEventSnapshot;
}

export interface ScanResult {
  scannedMessages: number;
  opened: SilenceEpisodeSummary[];
  updated: number;
  resolved: Array<{ episodeId: string; outcome: 'answered' | 'human-rescued'; lagSeconds: number }>;
  skippedNoAgent: number;
}

interface PgMessageRow {
  id: string | number;
  pod_id: string;
  user_id: string;
  created_at: Date;
}

/** Isolated so tests can run without a live PostgreSQL. */
const pgQuery = async (text: string, params: unknown[]): Promise<{ rows: PgMessageRow[] }> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg');
  return pool.query(text, params);
};

/**
 * What the agent-event queue knew, at the moment we decided this was silence.
 *
 * MUST be captured at fire time. Pending rows are deleted at 30 minutes and
 * the alert fires at 15, so this is the only window in which "nothing was ever
 * enqueued" (a producer bug) can be told apart from "enqueued and never acked"
 * (a runtime bug). Afterwards both look like an empty queue.
 */
export const snapshotAgentEvents = async (
  podId: string,
  since: Date,
  until: Date,
): Promise<IAgentEventSnapshot> => {
  const empty: IAgentEventSnapshot = {
    total: 0, byStatus: {}, targets: [], noneEnqueued: true, runsStarted: 0,
  };
  if (!mongoose.Types.ObjectId.isValid(podId)) return empty;
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentEvent = require('../models/AgentEvent');
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentRun = require('../models/AgentRun');
    const objectId = new mongoose.Types.ObjectId(podId);

    const [rows, runsStarted] = await Promise.all([
      AgentEvent.find({
        podId: objectId,
        createdAt: { $gte: since, $lte: until },
      }).select('agentName instanceId status type').lean(),
      // See IAgentEventSnapshot.runsStarted: this is what separates "the
      // runtime declined before creating a run" from "it ran and said
      // nothing". Indexed by { podId, agentName, instanceId, startedAt }.
      AgentRun.countDocuments({ podId: objectId, startedAt: { $gte: since, $lte: until } }),
    ]);

    const byStatus: Record<string, number> = {};
    const targets = new Set<string>();
    for (const r of rows as Array<Record<string, any>>) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      targets.add(`${r.agentName}/${r.instanceId || 'default'}`);
    }
    return {
      total: rows.length,
      byStatus,
      targets: [...targets],
      noneEnqueued: rows.length === 0,
      runsStarted,
    };
  } catch (error) {
    // Evidence-gathering must never be the reason an alert fails to fire.
    console.warn('[onboarding-silence] event snapshot failed:', (error as Error).message);
    return empty;
  }
};

/**
 * One detection pass. Safe to run concurrently with itself and safe to re-run
 * over ground it has already covered.
 */
export const scan = async ({
  now = new Date(),
  thresholdMinutes = SILENCE_THRESHOLD_MINUTES,
  onboardingWindowDays = ONBOARDING_WINDOW_DAYS,
  lookbackHours = SCAN_LOOKBACK_HOURS,
}: {
  now?: Date;
  thresholdMinutes?: number;
  onboardingWindowDays?: number;
  lookbackHours?: number;
} = {}): Promise<ScanResult> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../models/User');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../models/AgentRegistry');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const Pod = require('../models/Pod');

  const result: ScanResult = {
    scannedMessages: 0, opened: [], updated: 0, resolved: [], skippedNoAgent: 0,
  };

  const thresholdMs = thresholdMinutes * MINUTE_MS;
  // Only messages already older than the threshold can be judged; anything
  // newer still has time to be answered legitimately.
  const judgeBefore = new Date(now.getTime() - thresholdMs);
  const windowStart = new Date(now.getTime() - lookbackHours * 60 * MINUTE_MS);
  const signupSince = new Date(now.getTime() - onboardingWindowDays * DAY_MS);

  const newcomers = await User.find({ createdAt: { $gte: signupSince }, ...HUMAN_FILTER })
    .select('_id username createdAt').lean();

  await resolveOpenEpisodes({ now, result });

  if (newcomers.length === 0) return result;

  const byId = new Map<string, any>(newcomers.map((u: any) => [String(u._id), u]));
  const candidateIds = [...byId.keys()];

  const { rows: typed } = await pgQuery(
    "SELECT id, pod_id, user_id, created_at FROM messages"
    + " WHERE user_id = ANY($1) AND message_type = 'text'"
    + ' AND created_at >= $2 AND created_at <= $3'
    + ' ORDER BY created_at ASC',
    [candidateIds, windowStart, judgeBefore],
  );
  result.scannedMessages = typed.length;
  if (typed.length === 0) return result;

  // Which of those pods could have answered at all? Active installation, not
  // membership — a member without one 403s on post.
  const podIds = [...new Set(typed.map((m) => String(m.pod_id)))];
  const objectIdPods = podIds
    .filter((p) => mongoose.Types.ObjectId.isValid(p))
    .map((p) => new mongoose.Types.ObjectId(p));
  const liveInstalls = await AgentInstallation.find({
    podId: { $in: objectIdPods }, status: 'active',
  }).select('podId').lean();
  const podsThatCouldAnswer = new Set(
    (liveInstalls as Array<{ podId: unknown }>).map((i) => String(i.podId)),
  );

  const eligible = typed.filter((m) => podsThatCouldAnswer.has(String(m.pod_id)));
  result.skippedNoAgent = typed.length - eligible.length;
  if (eligible.length === 0) return result;

  // Everything said in those pods across the window, so replies can be matched
  // in memory rather than with a query per message.
  const eligiblePods = [...new Set(eligible.map((m) => String(m.pod_id)))];
  const { rows: allInPods } = await pgQuery(
    'SELECT id, pod_id, user_id, created_at FROM messages'
    + ' WHERE pod_id = ANY($1) AND created_at >= $2 ORDER BY created_at ASC',
    [eligiblePods, windowStart],
  );

  const authorIds = [...new Set(allInPods.map((m) => String(m.user_id)))];
  const botIds = new Set(
    (await User.find({ _id: { $in: authorIds }, ...BOT_FILTER }).select('_id').lean())
      .map((u: any) => String(u._id)),
  );

  const byPod = new Map<string, PgMessageRow[]>();
  for (const m of allInPods) {
    const k = String(m.pod_id);
    if (!byPod.has(k)) byPod.set(k, []);
    byPod.get(k)!.push(m);
  }

  const podNames = new Map<string, string>(
    (await Pod.find({ _id: { $in: eligiblePods.filter((p) => mongoose.Types.ObjectId.isValid(p)) } })
      .select('_id name').lean() as Array<{ _id: unknown; name?: string }>)
      .map((p) => [String(p._id), p.name || '']),
  );

  for (const m of eligible) {
    const typedAt = new Date(m.created_at);
    const deadline = new Date(typedAt.getTime() + thresholdMs);
    const podMsgs = byPod.get(String(m.pod_id)) || [];
    const answered = podMsgs.some((x) => {
      const t = new Date(x.created_at);
      return t > typedAt && t <= deadline
        && String(x.user_id) !== String(m.user_id)
        && botIds.has(String(x.user_id));
    });
    if (answered) continue;

    const user = byId.get(String(m.user_id));
    await openOrExtendEpisode({
      message: m, typedAt, user, now, podName: podNames.get(String(m.pod_id)), result,
    });
  }

  return result;
};

/**
 * Open a new episode, or fold this message into the one already open for the
 * same (user, pod). One stranded conversation is one failure regardless of how
 * many times the person tried.
 */
const openOrExtendEpisode = async ({
  message, typedAt, user, now, podName, result,
}: {
  message: PgMessageRow;
  typedAt: Date;
  user: any;
  now: Date;
  podName?: string;
  result: ScanResult;
}): Promise<void> => {
  const podId = String(message.pod_id);
  const userId = String(message.user_id);

  const existing = await OnboardingSilenceEpisode.findOne({ userId, podId, status: 'open' });
  if (existing) {
    // Absorb, idempotently. Passes overlap by design (a 24h lookback re-run
    // every 5 minutes), so this must be a no-op the second time it sees the
    // same message. The monotone watermark in the FILTER is what makes it one:
    // after the first application `lastAbsorbedAt` is no longer < typedAt, so
    // a replay matches nothing. Doing the comparison in JS and the write
    // separately would leave a window where two passes both increment.
    const absorbed = await OnboardingSilenceEpisode.updateOne(
      {
        _id: existing._id,
        status: 'open',
        firstMessageId: { $ne: String(message.id) },
        $or: [
          { lastAbsorbedAt: { $exists: false } },
          { lastAbsorbedAt: null },
          { lastAbsorbedAt: { $lt: typedAt } },
        ],
      },
      {
        $inc: { messageCount: 1 },
        $set: { lastAbsorbedMessageId: String(message.id), lastAbsorbedAt: typedAt },
      },
    );
    if (absorbed.modifiedCount > 0) result.updated += 1;
    return;
  }

  const eventSnapshot = await snapshotAgentEvents(podId, typedAt, now);
  const accountAgeMinutes = Math.round(
    (typedAt.getTime() - new Date(user?.createdAt || typedAt).getTime()) / MINUTE_MS,
  );

  try {
    const created = await OnboardingSilenceEpisode.create({
      userId,
      username: user?.username,
      podId,
      podName,
      firstMessageId: String(message.id),
      firstTypedAt: typedAt,
      accountAgeMinutes,
      messageCount: 1,
      status: 'open',
      detectedAt: now,
      eventSnapshot,
    });
    result.opened.push({
      episodeId: String(created._id),
      userId,
      username: user?.username,
      podId,
      podName,
      firstMessageId: String(message.id),
      firstTypedAt: typedAt,
      accountAgeMinutes,
      messageCount: 1,
      eventSnapshot,
    });
  } catch (error: any) {
    // The partial unique index is the concurrency guarantee: a second pass
    // racing this one loses here, and losing means "already open", not failure.
    if (error?.code !== 11000) throw error;
  }
};

/**
 * Close episodes that have since been answered, and record which kind of
 * answer it was. A resolved episode also re-arms the pair — the next silence
 * for the same user in the same pod is a genuinely new failure.
 */
const resolveOpenEpisodes = async ({
  now, result,
}: { now: Date; result: ScanResult }): Promise<void> => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const User = require('../models/User');

  // Bounded: see RESOLUTION_WINDOW_DAYS. Episodes older than the window stay
  // open — truthfully — but stop costing a query every five minutes.
  const open = await OnboardingSilenceEpisode.find({
    status: 'open',
    firstTypedAt: { $gte: new Date(now.getTime() - RESOLUTION_WINDOW_DAYS * DAY_MS) },
  }).limit(200).lean();
  if (open.length === 0) return;

  for (const ep of open as Array<Record<string, any>>) {
    const { rows } = await pgQuery(
      'SELECT id, pod_id, user_id, created_at FROM messages'
      + ' WHERE pod_id = $1 AND created_at > $2 AND user_id <> $3'
      + ' ORDER BY created_at ASC LIMIT 25',
      [String(ep.podId), new Date(ep.firstTypedAt), String(ep.userId)],
    );
    if (rows.length === 0) continue;

    const authorIds = [...new Set(rows.map((r) => String(r.user_id)))];
    const botIds = new Set(
      (await User.find({ _id: { $in: authorIds }, ...BOT_FILTER }).select('_id').lean())
        .map((u: any) => String(u._id)),
    );

    const answerer = rows.find((r) => botIds.has(String(r.user_id)));
    const rescuer = rows[0];
    const closing = answerer || rescuer;
    const outcome: 'answered' | 'human-rescued' = answerer ? 'answered' : 'human-rescued';
    const lagSeconds = Math.round(
      (new Date(closing.created_at).getTime() - new Date(ep.firstTypedAt).getTime()) / 1000,
    );

    await OnboardingSilenceEpisode.updateOne(
      { _id: ep._id, status: 'open' },
      {
        $set: {
          status: 'resolved',
          outcome,
          resolvedAt: now,
          resolutionLagSeconds: lagSeconds,
        },
      },
    );
    result.resolved.push({ episodeId: String(ep._id), outcome, lagSeconds });
  }
};

export default { scan, snapshotAgentEvents };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
