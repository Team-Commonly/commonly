// eslint-disable-next-line global-require
const cron = require('node-cron');
const crypto = require('crypto');
// eslint-disable-next-line global-require
const summarizerService = require('./summarizerService');
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const IntegrationSummaryService = require('./integrationSummaryService');
// eslint-disable-next-line global-require
const AgentEventService = require('./agentEventService');
// eslint-disable-next-line global-require
const PodAssetService = require('./podAssetService');
// eslint-disable-next-line global-require
const externalFeedService = require('./externalFeedService');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const AgentEvent = require('../models/AgentEvent');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { listDueForWake } = require('../repositories/agentDigestStateRepository') as
  typeof import('../repositories/agentDigestStateRepository');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { isHostedInstallation, readRuntimeConfig } = require('./hostedRuntimeService') as {
  isHostedInstallation: (installation: unknown) => boolean;
  readRuntimeConfig: (installation: unknown) => Record<string, unknown>;
};
// eslint-disable-next-line global-require
const SchedulerHeartbeatLease = require('../models/SchedulerHeartbeatLease');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { buildHeartbeatContent } = require('./heartbeatCue') as {
  buildHeartbeatContent: (heartbeatPodId: unknown) => string;
};
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { dispatchSchedules } = require('./agentScheduleService') as {
  dispatchSchedules: (now?: Date) => Promise<number>;
};
// eslint-disable-next-line global-require
const PodCurationService = require('./podCurationService');
// eslint-disable-next-line global-require
const AgentAutoJoinService = require('./agentAutoJoinService');
// eslint-disable-next-line global-require
const PGMessage = require('../models/pg/Message');
// eslint-disable-next-line global-require
const Post = require('../models/Post');
// eslint-disable-next-line global-require
const { refreshSkillsIndex } = require('./skillsRefreshService');

// eslint-disable-next-line global-require
const SummarizerService = summarizerService.constructor;
// eslint-disable-next-line global-require
const chatSummarizerService = require('./chatSummarizerService');
// eslint-disable-next-line global-require
const dailyDigestService = require('./dailyDigestService');
// eslint-disable-next-line global-require
const digestEmailService = require('./digestEmailService');
const { logOutboundFailure, warnOutboundFailure } = require('../utils/safeErrorLog');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { performance } = require('perf_hooks') as typeof import('perf_hooks');

interface CronJob {
  start(): void;
  stop(): void;
}

interface InstallationDoc {
  agentName: string;
  instanceId?: string;
  podId?: unknown;
  config?: {
    heartbeat?: {
      enabled?: boolean;
      global?: boolean;
      everyMinutes?: number;
      fixedPod?: boolean;
    };
    autonomy?: {
      enabled?: boolean;
    };
    runtime?: {
      runtimeType?: string;
    };
    digestWake?: {
      afterMinutes?: number;
    };
  };
}

interface HeartbeatActivityHint {
  lookbackMinutes: number;
  since: string;
  messageCount: number;
  postCount: number;
  totalSignals: number;
  /**
   * `null` means WE DO NOT KNOW, not "no activity". The chat-message arm reads
   * Postgres and returns `count: 0` on failure, which is the same value a quiet
   * pod returns; this hint is shipped verbatim into the heartbeat payload the
   * agent reads, so a store outage used to tell every agent the pod was quiet.
   */
  hasRecentActivity: boolean | null;
  /** True when the message-count arm failed, so `messageCount` is not a measurement. */
  messageCountUnavailable: boolean;
  lastMessageAt: string | null;
  lastPostAt: string | null;
  generatedAt: string;
}

interface DispatchHeartbeatsOptions {
  trigger?: string;
  respectIntervals?: boolean;
  now?: Date;
  /**
   * Filled with how long each step took (F633). The scheduled wrapper passes
   * one, so a manual dispatch keeps its result shape.
   */
  timings?: HeartbeatStepTimings;
}

/** Milliseconds per step of one heartbeat dispatch, plus installs checked. */
interface HeartbeatStepTimings {
  installs?: number;
  aggregate?: number;
  globalPick?: number;
  perInstall?: number;
  /** Installs that passed the opt-in gates and reached the per-install checks. */
  checked?: number;
}

interface HeartbeatDispatchTimingsMs {
  total: number;
  lease: number;
  schedules?: number;
  heartbeats?: number;
  installs?: number;
  aggregate?: number;
  globalPick?: number;
  perInstall?: number;
  unread?: number;
  unreadEvents?: number;
  unreadFold?: number;
  unreadInstalls?: number;
  unreadAllowed?: number;
  unreadChecks?: number;
  unreadEnqueue?: number;
}

/**
 * Milliseconds per step of the unread-digest pass, plus how many groups were
 * due (F635). `unreadChecks` covers the wake checks and the enqueue loop, so
 * it includes `unreadEnqueue`, the time spent inside AgentEventService.enqueue.
 */
interface UnreadDigestTimings {
  unreadEvents?: number;
  unreadFold?: number;
  unreadInstalls?: number;
  unreadAllowed?: number;
  unreadChecks?: number;
  unreadEnqueue?: number;
  due?: number;
}

// The order the cron line prints them in. Fixed, so the line stays greppable.
const HEARTBEAT_TIMING_KEYS: Array<keyof HeartbeatDispatchTimingsMs> = [
  'total', 'lease', 'schedules', 'heartbeats', 'installs', 'aggregate', 'globalPick', 'perInstall', 'unread',
  'unreadEvents', 'unreadFold', 'unreadInstalls', 'unreadAllowed', 'unreadChecks', 'unreadEnqueue',
];

const elapsedMs = (since: number): number => performance.now() - since;

interface DispatchHeartbeatsResult {
  scanned: number;
  enqueued: number;
  skippedByInterval: number;
  /** Seats skipped because their previous heartbeat is still undelivered. */
  skippedPending?: number;
}

interface ScheduledDispatchHeartbeatsResult extends DispatchHeartbeatsResult {
  skippedByLease: boolean;
  /** How long each step of this run took (F633). */
  timingsMs?: HeartbeatDispatchTimingsMs;
  /** Installs that reached the per-install checks. */
  checked?: number;
  /** Unread-digest groups that passed the install checks (F635). */
  due?: number;
}

interface DispatchPodSummaryOptions {
  trigger?: string;
  windowMinutes?: number;
  // Installs ("podId:instanceId") that already got an hourly request; the
  // startup top-up passes it, the cron and manual paths never do.
  skipInstallKeys?: Set<string>;
}

interface SummarizeResult {
  success: boolean;
  results: Record<string, unknown>;
  duration: number;
}

const HEARTBEAT_DISPATCH_LEASE_ID = 'agent-heartbeat-dispatch';
const DIGEST_WAKE_DEFAULT_MINUTES = 60;
// The unread-digest pass reads installs for its groups in $or batches of this
// many scopes (F634): a few hundred keeps each query well under Mongo's limits.
const DIGEST_WAKE_INSTALL_CHUNK = 200;
const DIGEST_WAKE_INSTALL_FIELDS = 'agentName instanceId podId config.digestWake config.heartbeat config.runtime';

type DigestWakeScope = { agentName: string; instanceId: string; podId: unknown };
// One non-digest AgentEvent read by the batched wake checks (F635).
type DigestWakeBlockerRow = {
  agentName: string; instanceId: string; podId: unknown;
  status?: string; deliveredAt?: Date | null; updatedAt?: Date | null;
};

// How the old per-group findOne matched: the schema lowercases agentName on
// the query, Mongoose casts podId to an ObjectId (so a string and an ObjectId
// of the same id match), and instanceId is compared as stored.
const digestInstallKey = (agentName: unknown, instanceId: unknown, podId: unknown): string => (
  `${String(agentName ?? '').toLowerCase()}:${String(instanceId)}:${String(podId)}`);
// allowsDigestWake's sibling identity: agentName lowercased, instanceId as stored.
const digestIdentityKey = (agentName: unknown, instanceId: unknown): string => (
  `${String(agentName ?? '').toLowerCase()}:${String(instanceId)}`);

// F668: heartbeat dispatch walks its installs, and enqueues the due ones, this
// many at a time, handing the event loop back between chunks.
const HEARTBEAT_DISPATCH_CHUNK = 100;
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

const chunked = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};
// A rollout briefly runs the old and new schedulers together (~40 seconds).
// Keep the lease long enough to cover that overlap, but shorter than the
// one-minute cron cadence so an otherwise healthy tick is never skipped.
const HEARTBEAT_DISPATCH_LEASE_MS = 55 * 1000;
const SCHEDULER_INSTANCE_ID = `${process.pid}:${crypto.randomUUID()}`;

// The heavier five-minute passes each get their own minute, so they
// never start together. On 2026-11-02 SRE traced two readiness windows to the
// :30 and :35 ticks, where the four passes then here (the retired ensemble
// scheduler was one) started in the same second and stalled-
// connect alone held the tick for about 7s. kernel-sweep keeps :04, :14, …
// (below), so no pass here shares a minute with it. decision-card reconcile,
// the approval-call sweep and the spawn-credential reap stay on */5: each is a
// small query, and none was in the stacked windows.
//
// Spell the minutes out. node-cron 3.0.3 accepts `2-59/5`, then fires it at
// :05, :10, …, the same minutes as every other five-minute pass.
const everyFiveMinutesFrom = (offset: number): string => (
  `${Array.from({ length: 12 }, (_, i) => offset + 5 * i).join(',')} * * * *`
);

export const FIVE_MINUTE_PASS_SCHEDULES = {
  onboardingSilence: everyFiveMinutesFrom(1),
  stalledConnect: everyFiveMinutesFrom(2),
  installableReconcile: everyFiveMinutesFrom(3),
} as const;

// F668: the sparse jobs (hourly, every 10 or every 15 minutes) each own their
// minutes. On 2026-11-26 the prod event loop stalled 3–4 s at 15:00:12 and
// 15:00:22: the hourly summarizer, the social-feed sync, agent-event GC and
// the spend alarm all started on :00, beside the per-minute heartbeat dispatch
// and the */5 passes. Each keeps its frequency; only its phase moved.
//
//   :01         daily digest (stays: catches 08:00 local, incl. half-hour zones)
//   :04, :14, … kernel work sweep (stays)
//   :06, :16, … external social-feed sync (was */10)
//   :08, :18, … agent-event GC (was */10)
//   :09         hourly summarizer (was :00); the summary window is the last
//               60 minutes from when it runs, so no reader needs :00
//   :10, :25, … spend alarm (was */15; also clears :15/:45, the even-hour
//               themed-autonomy and auto-join minutes, and 03:30 pg-mirror)
//   :17         missed-mention sweep (stays) · :39 registry drift (stays)
//
// Minutes ending in 9 are the only ones no five-minute pass touches; the
// summarizer takes :09. The two ten-minute jobs share a minute with one
// five-minute pass each (onboarding-silence, installable-reconcile), never
// with each other or with kernel-sweep. schedulerService.cronMinutes.test.js
// pins the table.
export const SPREAD_JOB_SCHEDULES = {
  summarizer: '9 * * * *',
  externalFeed: '6,16,26,36,46,56 * * * *',
  agentEventGc: '8,18,28,38,48,58 * * * *',
  spendAlarm: '10,25,40,55 * * * *',
} as const;

// Cron jobs are process-local. Keep one module-private owner so a second
// SchedulerService instance cannot start a duplicate job set in this process.
let activeScheduler: SchedulerService | null = null;

// F628: shorter than the hourly cadence, so the next cron tick is never skipped.
const STARTUP_SUMMARIZER_SKIP_WINDOW_MINUTES = 45;

class SchedulerService {
  isRunning: boolean;

  jobs: CronJob[];

  // One-shot startup runs (5–30 s after start). stop() clears them, so a
  // stopped scheduler never fires them later in the same process.
  startupTimers: NodeJS.Timeout[];

  constructor() {
    this.isRunning = false;
    this.jobs = [];
    this.startupTimers = [];
  }

  start(): void {
    if (activeScheduler) {
      console.log('Scheduler is already running');
      return;
    }

    console.log('Starting summarizer scheduler...');

    const summarizerJob: CronJob = cron.schedule(
      SPREAD_JOB_SCHEDULES.summarizer,
      async () => {
        console.log('Running hourly summarizer...');
        try {
          await SchedulerService.runSummarizer();
        } catch (error) {
          logOutboundFailure('Error in scheduled summarizer:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const externalFeedJob: CronJob = cron.schedule(
      SPREAD_JOB_SCHEDULES.externalFeed,
      async () => {
        console.log('Syncing external social feeds...');
        try {
          await externalFeedService.syncExternalFeeds();
        } catch (error) {
          logOutboundFailure('Error syncing external feeds:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const agentEventGcJob: CronJob = cron.schedule(
      SPREAD_JOB_SCHEDULES.agentEventGc,
      async () => {
        console.log('Running agent event garbage collection...');
        try {
          const result = await AgentEventService.garbageCollect();
          if (result.totalDeleted > 0) {
            console.log(
              `Agent event GC removed ${result.totalDeleted} event(s) `
              + `(delivered=${result.deletedDelivered}, failed=${result.deletedFailed})`,
            );
          }
          if (result.expiredPending > 0) {
            console.log(`Agent event GC marked ${result.expiredPending} unclaimed pending event(s) expired`);
          }
        } catch (error) {
          logOutboundFailure('Error in scheduled agent event GC:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // Hourly, at minute 1: each run sends to the people whose 08:00 began in
    // the last three hours (06:00 UTC when their zone is unknown), at most once
    // a day (dailyDigestService), so a run missed during a restart is made up.
    // A minute past the hour still lands inside 08:00 in the half-hour zones
    // (India's 08:30 at 03:01 UTC).
    const dailyDigestJob: CronJob = cron.schedule(
      '1 * * * *',
      async () => {
        console.log('Running daily digest generation...');
        try {
          const digestResults = await dailyDigestService.generateAllDailyDigests();
          await digestEmailService.sendDigestEmails(digestResults);
        } catch (error) {
          logOutboundFailure('Error in scheduled daily digest generation:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const cleanupJob: CronJob = cron.schedule(
      '0 2 * * *',
      async () => {
        console.log('Running daily cleanup...');
        try {
          await SummarizerService.cleanOldSummaries(30);
        } catch (error) {
          logOutboundFailure('Error in scheduled cleanup:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const themedPodAutonomyJob: CronJob = cron.schedule(
      '15 */2 * * *',
      async () => {
        console.log('Running themed pod autonomy...');
        try {
          const result = await PodCurationService.runThemedPodAutonomy({ hours: 12, minMatches: 4 });
          console.log(
            `Themed pod autonomy complete. Created: ${result.createdPods?.length || 0}, `
            + `Triggered: ${result.triggeredPods?.length || 0}`,
          );
        } catch (error) {
          logOutboundFailure('Error in themed pod autonomy scheduler:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const agentAutoJoinJob: CronJob = cron.schedule(
      '45 */2 * * *',
      async () => {
        console.log('Running agent auto-join for agent-owned pods...');
        try {
          const result = await AgentAutoJoinService.runAutoJoinAgentOwnedPods({ source: 'scheduled-autojoin' });
          console.log(`Agent auto-join complete. Installed: ${result.installed}, Sources: ${result.scannedSources}`);
        } catch (error) {
          logOutboundFailure('Error in agent auto-join scheduler:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const agentHeartbeatJob: CronJob = cron.schedule(
      '* * * * *',
      async () => {
        console.log('Dispatching agent heartbeat events...');
        try {
          const result = await SchedulerService.dispatchScheduledAgentHeartbeats({
            trigger: 'scheduled-interval',
            respectIntervals: true,
          });
          console.log(SchedulerService.formatHeartbeatDispatchLine(result));
        } catch (error) {
          logOutboundFailure('Error dispatching agent heartbeats:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // Refresh the skill marketplace catalog every 6 hours: re-read the local
    // catalog (or SKILLS_UPSTREAM_INDEX_URL, when set) and overlay fresh star
    // counts. See backend/services/skillsRefreshService.ts.
    const skillsRefreshJob: CronJob = cron.schedule(
      '0 */6 * * *',
      async () => {
        console.log('[skills-refresh] Running scheduled refresh...');
        try {
          const result = await refreshSkillsIndex();
          console.log(
            `[skills-refresh] Done: refreshed=${result.refreshed} `
            + `repos=${result.reposUpdated}/${result.reposTotal} `
            + `errors=${result.errors.length} duration=${result.durationMs}ms`,
          );
        } catch (error) {
          logOutboundFailure('[skills-refresh] Unhandled error:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // "Signed up, typed, got no reply" — the onboarding-silence alert
    // (W4 item 2). Every onboarding defect found on 2026-08-14 was found by a
    // human choosing to read production; this is the part that does not need
    // anyone to choose. See backend/services/onboardingSilenceService.ts for
    // the calibration behind the 15-minute threshold.
    //
    // Every 5 minutes, not every 15: the threshold is how long silence must
    // last before it counts, and the period is how long we then wait to say
    // so. Matching them would double the worst-case time-to-alert.
    const onboardingSilenceJob: CronJob = cron.schedule(
      FIVE_MINUTE_PASS_SCHEDULES.onboardingSilence,
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const onboardingAlertService = require('./onboardingAlertService');
          const result = await onboardingAlertService.runOnce();
          if (result.opened.length > 0 || result.resolved.length > 0) {
            console.log(
              `[onboarding-silence] scanned=${result.scannedMessages} `
              + `opened=${result.opened.length} absorbed=${result.updated} `
              + `resolved=${result.resolved.length} skippedNoAgent=${result.skippedNoAgent} `
              + `delivered=${result.delivered} rollup=${result.rollup}`,
            );
          }
        } catch (error) {
          logOutboundFailure('[onboarding-silence] Unhandled error:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // Stalled-connect nudge (W4 item 3). Tells a USER their seat was never
    // started — the population the onboarding-silence alert is blind to,
    // because they never typed. A cron rather than a delayed event on purpose:
    // re-deriving from state each pass is drop-proof, where a delayed
    // AgentEvent inherited the pending-GC caveat (#993 removed it; the cron
    // is still right, for the drop-proofness rather than the deletion).
    // An agent's mention with no thread reply for a week leaves the needs-you
    // queue as `missed` (attentionItemService.sweepMissedAgentMentions). Hourly
    // is plenty for a week-long window.
    const missedAgentMentionJob: CronJob = cron.schedule(
      '17 * * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { sweepMissedAgentMentions } = require('./attentionItemService');
          const r = await sweepMissedAgentMentions();
          console.log(`[attention] missed-mention pass scanned=${r.scanned} eligible=${r.eligible} missed=${r.missed}`);
        } catch (error) {
          logOutboundFailure('[attention] missed-mention pass failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // F512: a person's @mention emails the recipient if they haven't opened
    // the pod about 15 minutes later (mentionEmailService). Every five minutes
    // gives 15 to 20; one indexed query, so it stays off the staggered set.
    const mentionEmailJob: CronJob = cron.schedule(
      '*/5 * * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { sweepMentionEmails } = require('./mentionEmailService');
          const r = await sweepMentionEmails();
          if (r.scanned || r.failed) {
            console.log(`[mention-email] pass scanned=${r.scanned} sent=${r.sent} skipped=${r.skipped} failed=${r.failed}`);
          }
        } catch (error) {
          logOutboundFailure('[mention-email] pass failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );
    // F522: a person waiting on an agent that never connected tells its owner,
    // at most once per agent per 24h (waitingOwnerEmailService). Same cadence
    // as the mention email; one bounded read of the open episodes.
    const waitingOwnerEmailJob: CronJob = cron.schedule(
      '*/5 * * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { sweepWaitingOwnerEmails } = require('./waitingOwnerEmailService');
          const r = await sweepWaitingOwnerEmails();
          if (r.sent || r.failed) {
            console.log(`[waiting-email] pass scanned=${r.scanned} sent=${r.sent} skipped=${r.skipped} failed=${r.failed}`);
          }
        } catch (error) {
          logOutboundFailure('[waiting-email] pass failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const stalledConnectJob: CronJob = cron.schedule(
      FIVE_MINUTE_PASS_SCHEDULES.stalledConnect,
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const stalledConnectService = require('./stalledConnectService');
          const r = await stalledConnectService.scan();
          // Unconditional, for the same reason the silence pass logs
          // unconditionally: a detector nobody can see is indistinguishable
          // from a dead one.
          console.log(
            `[stalled-connect] pass candidates=${r.candidates} nudged=${r.nudged.length} `
            + `resolved=${r.resolved.length} tooRecent=${r.skippedTooRecent} `
            + `notStalled=${r.skippedNotStalled} guests=${r.skippedGuest} sameToken=${r.skippedSameToken} `
            + `noListener=${r.skippedNoListener}`,
          );
        } catch (error) {
          logOutboundFailure('[stalled-connect] Unhandled error:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // #1044 kernel work sweep. De-phased from the on-the-minute jobs (:04 etc)
    // so its DB pass never stacks on the heartbeat dispatcher's. Every 10
    // minutes: the sweep period intentionally EQUALS the 30-min lease's
    // renewal cadence divisor, giving lapse-to-rescue a ≤40-min worst case —
    // fable's "bounded rather than open-ended" bar — while the CAS inside the
    // rescue makes a period-vs-lease race harmless.
    const kernelWorkSweepJob: CronJob = cron.schedule(
      '4,14,24,34,44,54 * * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const KernelWorkSweepService = require('./kernelWorkSweepService');
          await KernelWorkSweepService.sweep();
        } catch (error) {
          logOutboundFailure('[kernel-sweep] pass failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // TASK-469: completion timestamps provide the five-minute due time. The
    // per-identity Mongo CAS in the service bounds overlap between replicas.
    const assignedTaskWakeJob: CronJob = cron.schedule(
      '* * * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { dispatchAssignedTaskWakes } = require('./assignedTaskWakeService');
          const result = await dispatchAssignedTaskWakes();
          if (result.eligible) console.log('[assigned-task-wake]', result);
        } catch (error) {
          logOutboundFailure('[assigned-task-wake] dispatch failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // Installable cleanup is deliberately lease-free. A rollout can run this
    // on two replicas, but every sweep mutation is a status+claimId CAS and
    // revoke/delete is idempotent. A duplicate pass is wasted work, never a
    // duplicate side effect. Heartbeat dispatch differs: it enqueues events,
    // so that job retains its cross-replica lease.
    const installableReconcileJob: CronJob = cron.schedule(
      FIVE_MINUTE_PASS_SCHEDULES.installableReconcile,
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const reconciler = require('./installable/installableReconciler');
          await reconciler.sweep();
        } catch (error) {
          logOutboundFailure('[installable-reconciler] scheduled sweep failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // AgentRegistry -> Installable backfill (ADR-001 Phase 3). Lease-free for
    // the same reason as above: every write is a $setOnInsert upsert, so two
    // replicas racing insert one row and the loser's E11000 is a no-op.
    // Hourly at :39, a minute no five-minute pass or hourly job uses.
    // Off unless INSTALLABLE_REGISTRY_SWEEP=1: prod turns it on only after a
    // fresh backup. The per-request mirrors run regardless.
    const registryDriftJob: CronJob = cron.schedule(
      '39 * * * *',
      async () => {
        // Read-path counters ride this line (ADR-001 Phase 3 PR B): '' while off and unused.
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const { formatReadPathCounters } = require('./installable/registryReader');
        const readPath = formatReadPathCounters();
        if (process.env.INSTALLABLE_REGISTRY_SWEEP !== '1') {
          console.log(`[registry-reconciler] skipped: INSTALLABLE_REGISTRY_SWEEP is not 1${readPath}`);
          return;
        }
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { sweepRegistryDrift } = require('./installable/registryReconciler');
          const r = await sweepRegistryDrift({ dryRun: false });
          console.log(
            `[registry-reconciler] pass scanned=${r.scanned} inserted=${r.inserted} existing=${r.existing} `
            + `refreshed=${r.refreshed} `
            + `skipped=${r.skipped} errors=${r.errors} `
            + `statusDrift=${r.mismatches.status} statsDrift=${r.mismatches.stats}${readPath}`,
          );
        } catch (error) {
          logOutboundFailure('[registry-reconciler] scheduled sweep failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // Decision card receipts are durable until the fork settles. Reconcile
    // every five minutes: close rows whose decision was ruled or removed, and
    // prune receipts seven days after their closedAt mark.
    const decisionCardReconcileJob: CronJob = cron.schedule(
      '*/5 * * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { sweepDecisionCards } = require('./decisionCardReconcileService');
          const result = await sweepDecisionCards();
          if (result.stamped || result.removed) {
            console.log(`[decision-card] sweep stamped=${result.stamped} removed=${result.removed}`);
          }
        } catch (error) {
          logOutboundFailure('[decision-card] scheduled sweep failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // ADR-034 D3: re-copy (or finish deleting) every flagged document of each
    // model in dual or pg-read. A model in mongo or pg costs nothing here; in
    // dual it is one query on the sparse pgPending index. Lease-free: each
    // repair step is version-conditional in both stores (dualStoreRegistry.ts).
    const dualStoreRepairJob: CronJob = cron.schedule(
      '*/5 * * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { repairDualStoredModels } = require('../repositories/dualStoreRegistry');
          await repairDualStoredModels();
        } catch (error) {
          logOutboundFailure('[dual-store] scheduled repair failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // Parked broker calls own their expiry: unlike legacy approval actions,
    // an abandoned tool_call must be terminal and have its canonical args
    // scrubbed. The decide path also checks the deadline for sweep races.
    const approvalToolCallSweepJob: CronJob = cron.schedule(
      '*/5 * * * *',
      async () => {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const {
          sweepExpiredToolCallApprovals, sweepCardlessToolCallApprovals,
        } = require('./approvalActionService');
        // Each sweep frees slots on its own, so one failing never skips the other.
        try {
          const expired = await sweepExpiredToolCallApprovals();
          if (expired) console.log(`[approval] expired tool calls=${expired}`);
        } catch (error) {
          logOutboundFailure('[approval] tool-call expiry sweep failed:', error);
        }
        try {
          // F184: a row whose card never posted holds a seat's open slot.
          const mooted = await sweepCardlessToolCallApprovals();
          if (mooted) console.log(`[approval] mooted cardless tool calls=${mooted}`);
        } catch (error) {
          logOutboundFailure('[approval] tool-call cardless sweep failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // A late upload can outlive the deletion request and fail its own cleanup.
    // Durable intents contain only opaque user ids; this sweep can retry after
    // the User row is gone. Deletes are idempotent across backend replicas.
    const accountDeletionUploadJob: CronJob = cron.schedule(
      '* * * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { sweepAccountDeletions } = require('./accountDeletionService');
          await sweepAccountDeletions();
        } catch (error) {
          const errorName = error instanceof AggregateError ? error.message
            : error instanceof Error ? error.name : 'Unknown error';
          console.error('[account-deletion] sweep failed:', errorName);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const spawnCredentialReapJob: CronJob = cron.schedule(
      '*/5 * * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { reapSpawnCredentials } = require('./spawnCredentialReaper');
          const removed = await reapSpawnCredentials();
          if (removed) console.log(`[spawn-credentials] reaped=${removed}`);
        } catch (error) {
          logOutboundFailure('[spawn-credentials] reap failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // TASK-260: remove the stranger journey's throwaway accounts (they cannot
    // delete themselves). Half an hour after each 02:17/14:17 journey run;
    // only accounts older than two hours, so a run in flight is never touched.
    // Off unless the deployment opts in (values-dev).
    const syntheticAccountPurgeJob: CronJob = cron.schedule(
      '47 2,14 * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { purgeSyntheticAccounts } = require('./syntheticAccountPurgeService');
          const report = await purgeSyntheticAccounts({ apply: true });
          const refused = report.accounts.filter((a: { refused?: string }) => a.refused);
          console.log(`[synthetic-purge] accounts=${report.accounts.length - refused.length} `
            + `refused=${refused.length} counts=${JSON.stringify(report.counts)}`);
          refused.forEach((a: { username: string; refused?: string }) => console.warn(`[synthetic-purge] refused ${a.username}: ${a.refused}`));
        } catch (error) {
          logOutboundFailure('[synthetic-purge] failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // TASK-263: price each user's model turns for the UTC day and log one
    // `alarm: user_spend` line per user past SPEND_ALARM_USD_PER_DAY ($2).
    // Reports only; the run ceilings enforce (services/spendAlarmService.ts).
    const spendAlarmJob: CronJob = cron.schedule(
      SPREAD_JOB_SCHEDULES.spendAlarm,
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { checkSpend } = require('./spendAlarmService');
          await checkSpend();
        } catch (error) {
          logOutboundFailure('[spend-alarm] check failed:', error);
        }
        // TASK-555: warn at 80% of any LiteLLM key budget (litellmBudgetAlarmService).
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { checkLiteLLMBudgets } = require('./litellmBudgetAlarmService');
          await checkLiteLLMBudgets();
        } catch (error) {
          console.error('[budget-alarm] check failed:', (error as Error).message);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // F84: unset run text and tool args/results after 30 days; rows stay
    // (services/agentRunContentWindow.ts). Off unless the deployment opts in.
    const runContentWindowJob: CronJob = cron.schedule(
      '23 4 * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { redactExpiredRunContent } = require('./agentRunContentWindow');
          const report = await redactExpiredRunContent({ apply: true });
          console.log(`[run-content] redacted=${report.redacted} matched=${report.matched} `
            + `cutoff=${report.cutoff.toISOString()}`);
        } catch (error) {
          logOutboundFailure('[run-content] redaction failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // F183: repair the PG mirror (pods, pod_members, users) from Mongo,
    // nightly at 03:30 UTC (services/pgMirrorRepairService.ts). Registered only
    // when the deployment opts in; report-only unless PG_MIRROR_REPAIR_APPLY=1,
    // which the service reads itself. An advisory lock keeps two replicas from
    // overlapping.
    const pgMirrorRepairJob: CronJob = cron.schedule(
      '30 3 * * *',
      async () => {
        try {
          // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
          const { runPgMirrorRepair } = require('./pgMirrorRepairService');
          await runPgMirrorRepair();
        } catch (error) {
          logOutboundFailure('[pg-mirror-repair] run failed:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    this.jobs = [
      summarizerJob,
      externalFeedJob,
      agentEventGcJob,
      dailyDigestJob,
      cleanupJob,
      themedPodAutonomyJob,
      agentAutoJoinJob,
      agentHeartbeatJob,
      skillsRefreshJob,
      onboardingSilenceJob,
      stalledConnectJob,
      mentionEmailJob,
      waitingOwnerEmailJob,
      missedAgentMentionJob,
      kernelWorkSweepJob,
      assignedTaskWakeJob,
      installableReconcileJob,
      registryDriftJob,
      decisionCardReconcileJob,
      dualStoreRepairJob,
      approvalToolCallSweepJob,
      spawnCredentialReapJob,
      accountDeletionUploadJob,
      spendAlarmJob,
      ...(process.env.SYNTHETIC_ACCOUNT_PURGE === 'true' ? [syntheticAccountPurgeJob] : []),
      ...(process.env.AGENT_RUN_CONTENT_WINDOW === 'true' ? [runContentWindowJob] : []),
      ...(process.env.PG_MIRROR_REPAIR === 'true' ? [pgMirrorRepairJob] : []),
    ];
    this.jobs.forEach((job) => job.start());
    this.isRunning = true;
    activeScheduler = this;

    console.log('Scheduler started successfully');
    console.log('- Summarizer runs every hour at :09');
    console.log('- Cleanup runs daily at 2 AM UTC');
    console.log('- External feeds sync every 10 minutes');
    console.log('- Agent event GC runs every 10 minutes');
    console.log('- Themed pod autonomy runs every 2 hours');
    console.log('- Agent auto-join (agent-owned pods) runs every 2 hours');
    // Names the opt-in gate on purpose. Every other line in this banner
    // describes a job that simply runs; this one describes a job that runs
    // only for installs that asked for it (#800 made it opt-in after 166 of
    // 245 active installs were found ticking hourly on a default nobody set).
    // The old line read "run every 10 minutes with per-agent intervals",
    // which is true about the dispatcher and silent about the gate — and it
    // sent a reader straight to resolveHeartbeatIntervalMinutes to compute a
    // fleet-wide wake rate off a field that is never reached for a seat that
    // never opted in.
    console.log(
      '- Agent heartbeats dispatch every 10 minutes; only installs with'
      + ' config.heartbeat.enabled === true fire, each on its own interval'
      + ' (config.heartbeat.everyMinutes, default 60)',
    );
    console.log('- Stale agent events are garbage-collected every 10 minutes');
    console.log('- Stalled-connect nudge scan runs every 5 minutes');
    console.log(
      '- Onboarding-silence scan runs every 5 minutes'
      + `${process.env.ONBOARDING_ALERT_EMAIL ? '' : ' (LOG-ONLY: ONBOARDING_ALERT_EMAIL unset)'}`,
    );
    console.log('- Skills catalog refreshes every 6 hours (stars re-fetched via GitHub API)');
    console.log('- Installable reconciliation runs every 5 minutes (CAS/idempotent; no lease required)');
    console.log(
      '- AgentRegistry -> Installable backfill runs hourly at :39 (inserts, refreshes marked rows; idempotent, no lease required)'
      + `${process.env.INSTALLABLE_REGISTRY_SWEEP === '1' ? '' : ' (OFF: INSTALLABLE_REGISTRY_SWEEP unset)'}`,
    );

    this.startupTimers.push(setTimeout(() => {
      SchedulerService.runStartupSummarizer().catch((error) => {
        logOutboundFailure('Error in initial summarizer run:', error);
      });
    }, 5000));

    this.startupTimers.push(setTimeout(() => {
      externalFeedService.syncExternalFeeds().catch((error: unknown) => {
        logOutboundFailure('Error in initial external feed sync:', error);
      });
    }, 7000));

    this.startupTimers.push(setTimeout(() => {
      AgentEventService.garbageCollect().catch((error: unknown) => {
        logOutboundFailure('Error in initial agent event GC:', error);
      });
    }, 8000));

    this.startupTimers.push(setTimeout(() => {
      PodCurationService.runThemedPodAutonomy({ hours: 12, minMatches: 4 }).catch((error: unknown) => {
        logOutboundFailure('Error in initial themed pod autonomy run:', error);
      });
    }, 9000));

    this.startupTimers.push(setTimeout(() => {
      SchedulerService.dispatchScheduledAgentHeartbeats({
        trigger: 'startup',
        respectIntervals: true,
      }).catch((error: unknown) => {
        logOutboundFailure('Error in initial heartbeat dispatch:', error);
      });
    }, 11000));

    this.startupTimers.push(setTimeout(() => {
      AgentAutoJoinService.runAutoJoinAgentOwnedPods({ source: 'startup-autojoin' }).catch((error: unknown) => {
        logOutboundFailure('Error in initial auto-join run:', error);
      });
    }, 13000));

    // Kick a skill catalog refresh 30s after startup so dev gets fresh data
    // without waiting for the first 6-hourly cron window.
    this.startupTimers.push(setTimeout(() => {
      refreshSkillsIndex()
        .then((result: { refreshed: number; reposUpdated: number; reposTotal: number; errors: Error[] }) => {
          console.log(
            `[skills-refresh] Startup refresh done: refreshed=${result.refreshed} `
            + `repos=${result.reposUpdated}/${result.reposTotal} errors=${result.errors.length}`,
          );
        })
        .catch((error: unknown) => {
          logOutboundFailure('[skills-refresh] Startup refresh failed:', error);
        });
    }, 30000));
  }

  stop(): void {
    if (activeScheduler !== this) {
      console.log('Scheduler is not running');
      return;
    }

    console.log('Stopping scheduler...');
    this.jobs.forEach((job) => {
      if (job) {
        job.stop();
      }
    });
    this.startupTimers.forEach((timer) => clearTimeout(timer));
    this.startupTimers = [];
    this.jobs = [];
    this.isRunning = false;
    activeScheduler = null;
    console.log('Scheduler stopped');
  }

  // F628: the startup run tops up per install. An install that already got a
  // scheduled-hourly summary.request inside the window is left out, so a
  // restart does not re-send every pod a request, and a restart mid-sweep
  // still reaches the pods the first sweep never got to. The signal is the
  // event rows themselves: the sweep writes them, they survive a restart, and
  // the read is bounded (about one row per install per hour). A failed read
  // runs the full sweep.
  static startupSummarizerSkipWindowMs(): number {
    const minutes = Number(process.env.SUMMARIZER_STARTUP_SKIP_WINDOW_MINUTES);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : STARTUP_SUMMARIZER_SKIP_WINDOW_MINUTES) * 60 * 1000;
  }

  static summaryInstallKey(podId: unknown, instanceId?: string | null): string {
    return `${String(podId)}:${instanceId || 'default'}`;
  }

  static async runStartupSummarizer(): Promise<SummarizeResult | null> {
    let skipInstallKeys: Set<string> | undefined;
    try {
      const since = new Date(Date.now() - SchedulerService.startupSummarizerSkipWindowMs());
      const recent: Array<{ podId: unknown; instanceId?: string }> = await AgentEvent.find({
        agentName: 'commonly-bot',
        type: 'summary.request',
        'payload.trigger': 'scheduled-hourly',
        createdAt: { $gte: since },
      }).select('podId instanceId').lean();
      if (recent.length) {
        const keys = new Set(recent.map((row) => SchedulerService.summaryInstallKey(row.podId, row.instanceId)));
        const installations: Array<{ podId: unknown; instanceId?: string }> = await AgentInstallation.find({
          agentName: 'commonly-bot',
          status: 'active',
        }).select('podId instanceId').lean();
        const uncovered = installations.filter(
          (i) => !keys.has(SchedulerService.summaryInstallKey(i.podId, i.instanceId)),
        ).length;
        if (!uncovered) {
          console.log(
            `Skipping startup summarizer: all ${installations.length} installs were requested within the last `
            + `${Math.round(SchedulerService.startupSummarizerSkipWindowMs() / 60000)} min`,
          );
          return null;
        }
        skipInstallKeys = keys;
      }
    } catch (error) {
      skipInstallKeys = undefined;
      logOutboundFailure('Startup summarizer recency check failed, running the sweep:', error);
    }
    return SchedulerService.runSummarizer(skipInstallKeys ? { skipInstallKeys } : {});
  }

  static async runSummarizer(options: { skipInstallKeys?: Set<string> } = {}): Promise<SummarizeResult> {
    const startTime = Date.now();
    console.log('Starting summarization process...');

    try {
      console.log('Step 0: Garbage collecting old summaries...');
      await SummarizerService.garbageCollectForDigest();

      console.log('Step 1: Summarizing external integration buffers...');
      await SchedulerService.summarizeIntegrationBuffers();

      console.log('Step 2: Dispatching pod summary requests to commonly-bot...');
      const podSummaryDispatch = await SchedulerService.dispatchPodSummaryRequests(
        options.skipInstallKeys ? { skipInstallKeys: options.skipInstallKeys } : {},
      );

      let chatRoomSummaries: unknown[] = [];
      let postSummary: unknown = { status: 'skipped', reason: 'legacy summarizer disabled' };
      let chatSummary: unknown = { status: 'skipped', reason: 'legacy summarizer disabled' };

      if (process.env.LEGACY_SUMMARIZER_ENABLED === '1') {
        console.log('Step 3: Running legacy summarizers...');
        chatRoomSummaries = await chatSummarizerService.summarizeAllActiveChats();
        [postSummary, chatSummary] = await Promise.allSettled([
          summarizerService.summarizePosts(),
          summarizerService.summarizeChats(),
        ]);
      } else {
        console.log('Step 3: Legacy summarizers disabled (agent-first mode)');
      }

      console.log(`✓ Pod summary requests enqueued: ${(podSummaryDispatch as { enqueued: number }).enqueued}`);

      const duration = Date.now() - startTime;
      console.log(`Summarization completed in ${duration}ms`);

      const result: SummarizeResult = {
        success: true,
        results: {
          podSummaryDispatch,
          chatRooms: chatRoomSummaries,
          posts: postSummary,
          chats: chatSummary,
        },
        duration,
      };

      console.log('Summarizer completed successfully');
      return result;
    } catch (error) {
      logOutboundFailure('Summarization process failed:', error);
      throw error;
    }
  }

  static async syncAllDiscordIntegrations(): Promise<unknown[]> {
    try {
      const discordIntegrations: Array<Record<string, unknown>> = await Integration.find({
        type: 'discord',
        isActive: true,
        'config.webhookListenerEnabled': true,
      }).populate('platformIntegration');

      console.log(`Found ${discordIntegrations.length} active Discord integration(s)`);

      const results = await Promise.allSettled(
        discordIntegrations.map(async (integration) => {
          try {
            // eslint-disable-next-line global-require
            const registry = require('../integrations');
            const provider = registry.get('discord', integration);
            await provider.validateConfig();

            const syncResult = await provider.syncRecent({ hours: 1 });
            const result = {
              integrationId: integration._id,
              success: syncResult.success,
              messageCount: syncResult.messageCount,
              content: syncResult.content,
            };

            if (syncResult.success && syncResult.messageCount > 0) {
              console.log(`✓ Discord sync successful: ${syncResult.content}`);
            }

            return result;
          } catch (error) {
            const err = error as { message?: string };
            logOutboundFailure(`Error syncing Discord integration ${integration._id}:`, error);
            return {
              integrationId: integration._id,
              success: false,
              messageCount: 0,
              content: err.message,
            };
          }
        }),
      ).then((settled) => settled.map((result) => (result.status === 'fulfilled' ? result.value : result.reason)));

      return results;
    } catch (error) {
      logOutboundFailure('Error in Discord integration sync:', error);
      return [];
    }
  }

  static async summarizeIntegrationBuffers(): Promise<unknown[]> {
    try {
      const integrations: Array<Record<string, unknown>> = await Integration.find({
        type: { $in: ['discord', 'slack', 'telegram', 'groupme', 'x', 'instagram'] },
        isActive: true,
        'config.messageBuffer.0': { $exists: true },
      }).lean();

      if (!integrations.length) {
        return [];
      }

      const results = await Promise.allSettled(
        integrations.map(async (integration) => {
          const config = integration.config as Record<string, unknown>;

          if (integration.type === 'discord' && !config?.webhookListenerEnabled) {
            return {
              integrationId: integration._id,
              success: false,
              skipped: true,
              reason: 'Auto sync disabled',
            };
          }

          const buffer = (config?.messageBuffer as unknown[]) || [];
          if (!buffer.length) {
            return {
              integrationId: integration._id,
              success: true,
              messageCount: 0,
              content: 'No buffered messages',
            };
          }

          const summary = await IntegrationSummaryService.createSummary(integration, buffer);

          try {
            await PodAssetService.createIntegrationSummaryAsset({ integration, summary });
          } catch (assetError) {
            console.error(`Failed to persist pod asset for integration ${integration._id}:`, assetError);
          }

          const installations: Array<{ instanceId?: string }> = await AgentInstallation.find({
            agentName: 'commonly-bot',
            podId: integration.podId,
            status: 'active',
          }).lean();

          const targets = installations.length > 0 ? installations : [{ instanceId: 'default' }];

          await Promise.all(
            targets.map((installation) => (
              AgentEventService.enqueue({
                agentName: 'commonly-bot',
                instanceId: installation.instanceId || 'default',
                podId: integration.podId,
                type: integration.type === 'discord' ? 'discord.summary' : 'integration.summary',
                payload: {
                  summary,
                  integrationId: String(integration._id),
                  source: integration.type,
                  trigger: 'scheduled-hourly',
                  silent: true,
                },
              })
            )),
          );

          if (integration.type === 'discord') {
            // eslint-disable-next-line global-require
            const { recordDiscordSummary } = require('../repositories/discordSummaryHistoryRepository');
            await recordDiscordSummary({
              integrationId: integration._id,
              summaryType: 'hourly',
              content: (summary as Record<string, unknown>).content,
              messageCount: (summary as Record<string, unknown>).messageCount,
              timeRange: (summary as Record<string, unknown>).timeRange,
              postedToCommonly: false,
              postedToDiscord: false,
            });
          }

          await Integration.findByIdAndUpdate(integration._id, {
            'config.messageBuffer': [],
            'config.lastSummaryAt': new Date(),
          });

          return {
            integrationId: integration._id,
            success: true,
            messageCount: (summary as Record<string, unknown>).messageCount,
            content: (summary as Record<string, unknown>).content,
          };
        }),
      ).then((settled) => settled.map((result) => (
        result.status === 'fulfilled' ? result.value : result.reason
      )));

      return results;
    } catch (error) {
      logOutboundFailure('Error summarizing integration buffers:', error);
      return [];
    }
  }

  static async dispatchPodSummaryRequests(
    options: DispatchPodSummaryOptions = {},
  ): Promise<{ enqueued: number }> {
    const { trigger = 'scheduled-hourly', windowMinutes = 60, skipInstallKeys } = options;

    let installations: Array<{ podId: unknown; instanceId?: string }> = await AgentInstallation.find({
      agentName: 'commonly-bot',
      status: 'active',
    }).select('podId instanceId').lean();

    if (skipInstallKeys?.size) {
      const all = installations.length;
      installations = installations.filter(
        (i) => !skipInstallKeys.has(SchedulerService.summaryInstallKey(i.podId, i.instanceId)),
      );
      console.log(`Summary dispatch: skipped ${all - installations.length} installs recently requested`);
    }

    if (!installations.length) {
      return { enqueued: 0 };
    }

    // #454 follow-up: chunk the fanout. A bare Promise.all over all
    // installations means 60+ events become ready at the exact same
    // instant; the agent runtime then races to process them, and each
    // downstream summary handler queries PG for messages — which under
    // pg.Pool max=10 (pre-#455) saturated the pool and hung user-facing
    // /api/pods. PR #455 raised the pool ceiling, but the burst itself
    // is still wasteful: better to spread enqueue (and therefore the
    // downstream processing window) over a few seconds. Batches of 10
    // with a 500ms gap caps peak concurrency on the consumer side while
    // keeping total wall time well under the next hourly tick.
    const BATCH_SIZE = parseInt(process.env.SUMMARIZER_FANOUT_BATCH_SIZE || '10', 10) || 10;
    const BATCH_PAUSE_MS = parseInt(process.env.SUMMARIZER_FANOUT_BATCH_PAUSE_MS || '500', 10) || 500;

    for (let i = 0; i < installations.length; i += BATCH_SIZE) {
      const batch = installations.slice(i, i + BATCH_SIZE);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        batch.map((installation) => (
          AgentEventService.enqueue({
            agentName: 'commonly-bot',
            instanceId: installation.instanceId || 'default',
            podId: installation.podId,
            type: 'summary.request',
            payload: {
              source: 'pod',
              trigger,
              windowMinutes,
              includeDigest: true,
              silent: true,
            },
          })
        )),
      );
      // Sleep between batches; skip the final pause.
      if (i + BATCH_SIZE < installations.length && BATCH_PAUSE_MS > 0) {
        // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
        await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }

    return { enqueued: installations.length };
  }

  static async triggerSummarizer(): Promise<SummarizeResult> {
    console.log('Manually triggering summarizer...');
    return SchedulerService.runSummarizer();
  }

  getStatus(): Record<string, unknown> {
    return {
      isRunning: this.isRunning,
      jobCount: this.jobs.length,
      nextRun: this.jobs.length > 0 ? 'Next hour at minute 0' : 'Not scheduled',
    };
  }

  static resolveHeartbeatIntervalMinutes(installation: InstallationDoc): number {
    const parsed = Number(installation?.config?.heartbeat?.everyMinutes);
    if (!Number.isFinite(parsed) || parsed <= 0) return 60;
    return Math.max(1, Math.min(1440, Math.trunc(parsed)));
  }

  static resolveHeartbeatStaggerOffset(agentKey: string, intervalMinutes: number): number {
    const digest: Buffer = crypto.createHash('sha256').update(agentKey).digest();
    return digest.readUInt32BE(0) % intervalMinutes;
  }

  static resolveHeartbeatHintWindowMinutes(): number {
    const parsed = Number(process.env.AGENT_HEARTBEAT_SIGNAL_WINDOW_MINUTES);
    if (!Number.isFinite(parsed) || parsed <= 0) return 120;
    return Math.max(5, Math.min(1440, Math.trunc(parsed)));
  }

  static async buildHeartbeatActivityHint(
    options: { podId?: unknown; now?: Date } = {},
  ): Promise<HeartbeatActivityHint | null> {
    const { podId, now = new Date() } = options;
    if (!podId) return null;
    const lookbackMinutes = SchedulerService.resolveHeartbeatHintWindowMinutes();
    const since = new Date(now.getTime() - (lookbackMinutes * 60 * 1000));

    const [pgMsgHint, postStats]: [
      { count: number; lastAt?: string | Date; unavailable?: boolean },
      Array<{ _id: unknown; count: number; lastAt?: Date }>
    ] = await Promise.all([
      PGMessage.findActivityHint(podId, since),
      Post.aggregate([
        { $match: { podId, createdAt: { $gte: since } } },
        { $group: { _id: null, count: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
      ]),
    ]);

    const messageCount = pgMsgHint.count;
    const messageCountUnavailable = pgMsgHint.unavailable === true;
    const postCount = Number(postStats?.[0]?.count || 0);
    const totalSignals = messageCount + postCount;

    // A positive signal is still positive even if the other arm failed; only a
    // ZERO is unknowable, because we did not manage to look.
    const hasRecentActivity = totalSignals > 0
      ? true
      : (messageCountUnavailable ? null : false);

    return {
      lookbackMinutes,
      since: since.toISOString(),
      messageCount,
      postCount,
      totalSignals,
      hasRecentActivity,
      messageCountUnavailable,
      lastMessageAt: pgMsgHint.lastAt ? new Date(pgMsgHint.lastAt).toISOString() : null,
      lastPostAt: postStats?.[0]?.lastAt ? new Date(postStats[0].lastAt).toISOString() : null,
      generatedAt: now.toISOString(),
    };
  }

  /**
   * Atomically take the cluster-wide heartbeat slot. A duplicate-key error is
   * the normal losing result when two scheduler pods try to create the lease
   * during a rollout; every other database error must still surface. We do
   * not release early: that would let the other rollout replica run the same
   * automatic tick after this dispatcher finishes.
   */
  static async tryAcquireHeartbeatDispatchLease(now = new Date()): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + HEARTBEAT_DISPATCH_LEASE_MS);
    try {
      await SchedulerHeartbeatLease.findOneAndUpdate(
        {
          _id: HEARTBEAT_DISPATCH_LEASE_ID,
          expiresAt: { $lte: now },
        },
        {
          $set: {
            ownerId: SCHEDULER_INSTANCE_ID,
            expiresAt,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      return true;
    } catch (error: unknown) {
      if ((error as { code?: number })?.code === 11000) return false;
      throw error;
    }
  }

  /**
   * Scheduler-only wrapper. Direct/manual dispatch intentionally stays
   * available through dispatchAgentHeartbeats; only automatic triggers need
   * the distributed lease that survives two backend replicas during rollout.
   */
  static async dispatchScheduledAgentHeartbeats(
    options: DispatchHeartbeatsOptions = {},
  ): Promise<ScheduledDispatchHeartbeatsResult> {
    const startedAt = performance.now();
    const now = options.now || new Date();
    let stepAt = performance.now();
    const acquired = await SchedulerService.tryAcquireHeartbeatDispatchLease(now);
    const lease = elapsedMs(stepAt);
    if (!acquired) {
      return {
        scanned: 0,
        enqueued: 0,
        skippedByInterval: 0,
        skippedByLease: true,
        timingsMs: { total: elapsedMs(startedAt), lease },
      };
    }

    // First and on its own: a daily wake that misses its hour is lost, where a
    // heartbeat just comes round again.
    stepAt = performance.now();
    const scheduledWakes = await dispatchSchedules(now).catch((error: Error) => {
      console.error('Scheduled agent wakes failed:', error.message);
      return 0;
    });
    const schedules = elapsedMs(stepAt);
    const steps: HeartbeatStepTimings = {};
    stepAt = performance.now();
    const result = await SchedulerService.dispatchAgentHeartbeats({ ...options, now, timings: steps });
    const heartbeats = elapsedMs(stepAt);
    stepAt = performance.now();
    const unreadSteps: UnreadDigestTimings = {};
    const unreadWakes = await SchedulerService.dispatchUnreadDigestHeartbeats(now, unreadSteps);
    const unread = elapsedMs(stepAt);
    return {
      ...result,
      enqueued: result.enqueued + unreadWakes + scheduledWakes,
      skippedByLease: false,
      checked: steps.checked ?? 0,
      due: unreadSteps.due ?? 0,
      timingsMs: {
        total: elapsedMs(startedAt),
        lease,
        schedules,
        heartbeats,
        installs: steps.installs ?? 0,
        aggregate: steps.aggregate ?? 0,
        globalPick: steps.globalPick ?? 0,
        perInstall: steps.perInstall ?? 0,
        unread,
        unreadEvents: unreadSteps.unreadEvents ?? 0,
        unreadFold: unreadSteps.unreadFold ?? 0,
        unreadInstalls: unreadSteps.unreadInstalls ?? 0,
        unreadAllowed: unreadSteps.unreadAllowed ?? 0,
        unreadChecks: unreadSteps.unreadChecks ?? 0,
        unreadEnqueue: unreadSteps.unreadEnqueue ?? 0,
      },
    };
  }

  /**
   * The cron's one line per run. It starts with `Agent heartbeats enqueued: <n>`
   * exactly, because ops greps that prefix; the step timings follow as whole
   * milliseconds in a fixed order, numbers only (F633).
   */
  static formatHeartbeatDispatchLine(result: ScheduledDispatchHeartbeatsResult): string {
    const leaseSuffix = result.skippedByLease ? ' (another scheduler holds the lease)' : '';
    const line = `Agent heartbeats enqueued: ${result.enqueued}${leaseSuffix}`;
    const timings = result.timingsMs;
    if (!timings) return line;
    const parts = HEARTBEAT_TIMING_KEYS
      .filter((key) => typeof timings[key] === 'number')
      .map((key) => `${key}=${Math.round(timings[key] as number)}`);
    const counts = [
      typeof result.checked === 'number' ? `checked=${result.checked}` : '',
      typeof result.due === 'number' ? `due=${result.due}` : '',
    ].filter(Boolean).join(' ');
    return `${line} (ms ${parts.join(' ')}${counts ? `; ${counts}` : ''})`;
  }

  /**
   * How long digest may sit unread before it wakes the seat:
   * `config.digestWake.afterMinutes`, 60 by default, clamped to 60..1440.
   * A seat whose digest wakes rarely produce anything can be given a longer
   * wait; its digest stays unread and rides its next wake of any kind.
   */
  static resolveDigestWakeAfterMinutes(installation?: InstallationDoc | null): number {
    const raw = Number(installation?.config?.digestWake?.afterMinutes);
    if (!Number.isFinite(raw)) return DIGEST_WAKE_DEFAULT_MINUTES;
    return Math.max(DIGEST_WAKE_DEFAULT_MINUTES, Math.min(1440, Math.trunc(raw)));
  }

  /**
   * Whether this install may take a digest wake (F194). A hosted install's
   * turns are paid by its owner, so it takes one only when the owner turned
   * its heartbeat on; its digest otherwise rides its next wake of any kind.
   * Every other runtime (native first-party apps, BYO, webhook, fleet seats)
   * keeps the hourly digest wake. A projection with no runtime of its own
   * routes as its identity's newest configured row, as
   * AgentEventService.resolveEffectiveInstallation does; the heartbeat is the
   * projection's own, which withInheritedRuntime never inherits.
   */
  static async allowsDigestWake(installation: InstallationDoc): Promise<boolean> {
    if (installation?.config?.heartbeat?.enabled === true) return true;
    if (readRuntimeConfig(installation).runtimeType) return !isHostedInstallation(installation);
    const sibling = await AgentInstallation.findOne({
      agentName: String(installation.agentName || '').toLowerCase(),
      instanceId: String(installation.instanceId || 'default'),
      status: 'active',
      'config.runtime.runtimeType': { $exists: true },
    }).sort({ createdAt: -1 }).select('config.runtime').lean();
    return !isHostedInstallation(sibling);
  }

  /**
   * Every active, autonomy-on install for these scopes, read in $or batches
   * and keyed as the old per-group findOne matched (digestInstallKey). The
   * unique index on (agentName, podId, instanceId) allows one row per scope;
   * should a legacy duplicate exist, the oldest _id wins, where findOne
   * returned whichever it met first.
   */
  static async findActiveDigestInstalls(scopes: DigestWakeScope[]): Promise<Map<string, InstallationDoc>> {
    const unique = new Map<string, DigestWakeScope>();
    scopes.forEach((scope) => {
      unique.set(digestInstallKey(scope.agentName, scope.instanceId, scope.podId), scope);
    });
    const batches = await Promise.all(chunked([...unique.values()], DIGEST_WAKE_INSTALL_CHUNK).map((chunk) => (
      AgentInstallation.find({
        status: 'active',
        'config.autonomy.enabled': { $ne: false },
        $or: chunk.map(({ agentName, instanceId, podId }) => ({ agentName, instanceId, podId })),
      }).select(DIGEST_WAKE_INSTALL_FIELDS).sort({ _id: 1 }).lean() as Promise<InstallationDoc[]>)));
    const byKey = new Map<string, InstallationDoc>();
    batches.flat().forEach((doc) => {
      const key = digestInstallKey(doc.agentName, doc.instanceId, doc.podId);
      if (!byKey.has(key)) byKey.set(key, doc);
    });
    return byKey;
  }

  /**
   * allowsDigestWake for many installs, with the sibling reads batched (F634):
   * the same rule and the same sibling, the identity's newest active row with
   * a runtimeType. When a sibling chunk fails, only that chunk's installs fall
   * back to allowsDigestWake one by one, and the failure logs once; an install
   * is held only if its own lookup fails too, as a failed allowsDigestWake
   * always was. Chunks that succeeded keep their decisions.
   */
  static async allowsDigestWakeBatch(
    installs: InstallationDoc[],
    chunkSize: number = DIGEST_WAKE_INSTALL_CHUNK,
  ): Promise<Map<InstallationDoc, boolean>> {
    const allowed = new Map<InstallationDoc, boolean>();
    const needSibling: Array<{ install: InstallationDoc; key: string }> = [];
    const pairs = new Map<string, { agentName: string; instanceId: string }>();
    installs.forEach((install) => {
      if (install?.config?.heartbeat?.enabled === true) {
        allowed.set(install, true);
      } else if (readRuntimeConfig(install).runtimeType) {
        allowed.set(install, !isHostedInstallation(install));
      } else {
        const agentName = String(install.agentName || '').toLowerCase();
        const instanceId = String(install.instanceId || 'default');
        const key = digestIdentityKey(agentName, instanceId);
        needSibling.push({ install, key });
        pairs.set(key, { agentName, instanceId });
      }
    });
    if (!needSibling.length) return allowed;
    const chunks = chunked([...pairs.entries()], chunkSize);
    const results = await Promise.allSettled(chunks.map((chunk) => (
      // A synchronous throw from find() becomes this chunk's rejection.
      Promise.resolve().then(() => AgentInstallation.find({
        status: 'active',
        'config.runtime.runtimeType': { $exists: true },
        $or: chunk.map(([, pair]) => pair),
      }).select('agentName instanceId config.runtime').sort({ createdAt: -1, _id: -1 })
        .lean() as Promise<InstallationDoc[]>))));
    // Each chunk is sorted newest first, and a pair sits in one chunk only,
    // so the first row seen for a pair is its newest.
    const newest = new Map<string, InstallationDoc>();
    const failedKeys = new Set<string>();
    let firstError: unknown = null;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        result.value.forEach((doc) => {
          const key = digestIdentityKey(doc.agentName, doc.instanceId);
          if (!newest.has(key)) newest.set(key, doc);
        });
      } else {
        firstError ??= result.reason;
        chunks[i].forEach(([key]) => failedKeys.add(key));
      }
    });
    if (failedKeys.size) {
      warnOutboundFailure('[scheduler] digest wake runtime lookup failed; checking those groups one by one:',
        firstError);
    }
    await Promise.all(needSibling.map(async ({ install, key }) => {
      if (!failedKeys.has(key)) {
        allowed.set(install, !isHostedInstallation(newest.get(key) ?? null));
        return;
      }
      // A failed lookup holds this wake for one tick rather than spend an
      // owner's turn it may not owe; the digest stays unread.
      allowed.set(install, await SchedulerService.allowsDigestWake(install).catch(() => false));
    }));
    return allowed;
  }

  /**
   * The old per-group install read and runtime check, used only when the
   * batched install read fails, so a failed batch never drops wakes.
   */
  static async lookupDigestInstallPerGroup(scope: DigestWakeScope): Promise<{
    active: InstallationDoc | null; allowed: boolean;
  }> {
    const active: InstallationDoc | null = await AgentInstallation.findOne({
      ...scope, status: 'active', 'config.autonomy.enabled': { $ne: false },
    }).select(DIGEST_WAKE_INSTALL_FIELDS).lean();
    if (!active) return { active: null, allowed: false };
    // A failed runtime lookup holds this wake for one tick rather than
    // spend an owner's turn it may not owe; the digest stays unread.
    const allowed = await SchedulerService.allowsDigestWake(active).catch((err: Error) => {
      console.warn('[scheduler] digest wake runtime lookup failed:', err.message);
      return false;
    });
    return { active, allowed };
  }

  /**
   * The non-digest wakes for these scopes, read in $or batches before the
   * wake loop (F635) instead of two `exists` per group: every pending one,
   * and every delivered, acked or failed one inside the scope's own window.
   * The recent read is one top-level $or with a clause per scope, each with
   * its own bound, so every clause can use the scope index and a long wait on
   * one scope never widens the read for the others. Should two entries share
   * a scope, its clause takes the earliest window; each group still applies
   * its own window to the rows. Keyed as the per-group `exists` matched
   * (digestInstallKey): the schema lowercases agentName on the query,
   * Mongoose casts podId, instanceId is compared as stored.
   */
  static async findDigestWakeBlockers(
    entries: Array<{ scope: DigestWakeScope; windowStart: Date }>,
  ): Promise<{
    pending: Set<string>; recent: Map<string, DigestWakeBlockerRow[]>;
  }> {
    const unique = new Map<string, { scope: DigestWakeScope; windowStart: Date }>();
    entries.forEach(({ scope, windowStart }) => {
      const key = digestInstallKey(scope.agentName, scope.instanceId, scope.podId);
      const existing = unique.get(key);
      if (!existing || windowStart < existing.windowStart) unique.set(key, { scope, windowStart });
    });
    const reads = chunked([...unique.values()], DIGEST_WAKE_INSTALL_CHUNK).flatMap((chunk) => {
      const scopeOr = chunk.map(({ scope: { agentName, instanceId, podId } }) => ({ agentName, instanceId, podId }));
      const recentOr = chunk.map(({ scope: { agentName, instanceId, podId }, windowStart }) => ({
        agentName,
        instanceId,
        podId,
        deliveryMode: { $ne: 'digest' },
        $or: [
          { status: { $in: ['delivered', 'acked'] }, deliveredAt: { $gte: windowStart } },
          { status: 'failed', updatedAt: { $gte: windowStart } },
        ],
      }));
      return [
        // A synchronous throw from find() becomes this read's rejection.
        Promise.resolve().then(() => AgentEvent.find({
          status: 'pending', deliveryMode: { $ne: 'digest' }, $or: scopeOr,
        }).select('agentName instanceId podId').lean() as Promise<DigestWakeBlockerRow[]>)
          .then((rows) => ({ kind: 'pending' as const, rows })),
        Promise.resolve().then(() => AgentEvent.find({ $or: recentOr })
          .select('agentName instanceId podId status deliveredAt updatedAt')
          .lean() as Promise<DigestWakeBlockerRow[]>)
          .then((rows) => ({ kind: 'recent' as const, rows })),
      ];
    });
    const pending = new Set<string>();
    const recent = new Map<string, DigestWakeBlockerRow[]>();
    (await Promise.all(reads)).forEach(({ kind, rows }) => {
      rows.forEach((row) => {
        const key = digestInstallKey(row.agentName, row.instanceId, row.podId);
        if (kind === 'pending') {
          pending.add(key);
          return;
        }
        const list = recent.get(key);
        if (list) list.push(row);
        else recent.set(key, [row]);
      });
    });
    return { pending, recent };
  }

  /** One slow wake for a pod with unread digest, never for an empty inbox. */
  static async dispatchUnreadDigestHeartbeats(
    now: Date = new Date(),
    timings: UnreadDigestTimings = {},
  ): Promise<number> {
    // The default is also the shortest wait, so this query finds every candidate.
    const threshold = new Date(now.getTime() - DIGEST_WAKE_DEFAULT_MINUTES * 60 * 1000);
    let stepAt = performance.now();
    const rawGroups = await AgentEvent.aggregate([
      { $match: { status: 'pending', deliveryMode: 'digest', createdAt: { $lte: threshold } } },
      { $group: {
        _id: { agentName: '$agentName', instanceId: '$instanceId', podId: '$podId' },
        oldestAt: { $min: '$createdAt' },
      } },
    ]) as Array<{ _id: { agentName: string; instanceId: string; podId: unknown }; oldestAt: Date }>;
    timings.unreadEvents = elapsedMs(stepAt);
    stepAt = performance.now();
    const foldedGroups = await listDueForWake(threshold);
    timings.unreadFold = elapsedMs(stepAt);
    const groups = new Map<string, { scope: { agentName: string; instanceId: string; podId: unknown }; oldestAt: Date }>();
    const addGroup = (scope: { agentName: string; instanceId: string; podId: unknown }, at: Date) => {
      const key = `${scope.agentName}:${scope.instanceId}:${scope.podId}`;
      const existing = groups.get(key);
      if (!existing || at < existing.oldestAt) groups.set(key, { scope, oldestAt: at });
    };
    rawGroups.forEach((row) => addGroup(row._id, new Date(row.oldestAt)));
    foldedGroups.forEach(({ agentName, instanceId, podId, unreadSince }) => (
      addGroup({ agentName, instanceId, podId }, new Date(unreadSince))));
    const candidates = [...groups.values()].map(({ scope: rowScope, oldestAt }) => ({
      scope: {
        agentName: rowScope.agentName,
        instanceId: rowScope.instanceId || 'default',
        podId: rowScope.podId,
      } as DigestWakeScope,
      oldestAt,
    }));
    const waitMsOf = (active: InstallationDoc) => SchedulerService.resolveDigestWakeAfterMinutes(active) * 60 * 1000;
    const waited = (active: InstallationDoc, oldestAt: Date) => (
      now.getTime() - oldestAt.getTime() >= waitMsOf(active));

    // A retired projection has no listener. Its old digest remains for GC, but
    // must not create a new wake every hour. Most groups have no active
    // install, and each used to cost a round trip per minute just to be
    // skipped; one batched read finds them all (F634). The checks below are
    // the old ones, in a cheaper order: none depends on another.
    const due: Array<{ scope: DigestWakeScope; active: InstallationDoc }> = [];
    let installs: Map<string, InstallationDoc> | null = null;
    stepAt = performance.now();
    try {
      installs = await SchedulerService.findActiveDigestInstalls(candidates.map(({ scope }) => scope));
    } catch (err) {
      // Toward over-delivery (review-checklist rule 19): a failed batch falls
      // back to the old per-group reads for this pass, never drops the wakes.
      logOutboundFailure('[scheduler] digest wake install batch read failed; reading per group this pass:', err);
    }
    if (installs) {
      const found = installs;
      const waitedCandidates = candidates.flatMap(({ scope, oldestAt }) => {
        const active = found.get(digestInstallKey(scope.agentName, scope.instanceId, scope.podId));
        return active && waited(active, oldestAt) ? [{ scope, active }] : [];
      });
      timings.unreadInstalls = elapsedMs(stepAt);
      stepAt = performance.now();
      const allowed = await SchedulerService.allowsDigestWakeBatch(
        [...new Set(waitedCandidates.map(({ active }) => active))],
      );
      waitedCandidates.forEach((candidate) => {
        if (allowed.get(candidate.active) === true) due.push(candidate);
      });
      timings.unreadAllowed = elapsedMs(stepAt);
    } else {
      // One scope whose lookup throws is skipped this pass; it never holds back
      // the groups after it. Logged once per pass, not once per scope.
      let lookupFailureLogged = false;
      for (const { scope, oldestAt } of candidates) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { active, allowed } = await SchedulerService.lookupDigestInstallPerGroup(scope);
          if (active && allowed && waited(active, oldestAt)) due.push({ scope, active });
        } catch (err) {
          if (!lookupFailureLogged) {
            logOutboundFailure('[scheduler] digest wake per-group lookup failed; skipping that group this pass:', err);
            lookupFailureLogged = true;
          }
        }
      }
      // The per-group fallback reads each install and its runtime together.
      timings.unreadInstalls = elapsedMs(stepAt);
      timings.unreadAllowed = 0;
    }
    timings.due = due.length;

    // An existing wake will carry the digest. A recent completed wake says the
    // seat has already had a turn inside this install's wait. Both are read
    // for every due group at once (F635), each scope bounded by its own
    // window; each group then applies its own window to those rows, as its
    // own query did. Groups still go one at a time, in order, and a scope this
    // pass just woke counts as pending, so two groups that land on one scope
    // wake it once. (enqueue writes the heartbeat with the default
    // deliveryMode, 'wake': pending for an external seat, delivered now for a
    // native one. The old next `exists` found either.)
    stepAt = performance.now();
    let enqueueMs = 0;
    const windowStartOf = (active: InstallationDoc) => new Date(now.getTime() - waitMsOf(active));
    let blockers: { pending: Set<string>; recent: Map<string, DigestWakeBlockerRow[]> } | null = null;
    if (due.length) {
      try {
        blockers = await SchedulerService.findDigestWakeBlockers(
          due.map(({ scope, active }) => ({ scope, windowStart: windowStartOf(active) })),
        );
      } catch (err) {
        // Toward over-delivery (review-checklist rule 19): a failed batch falls
        // back to the old per-group checks for this pass, never drops a wake.
        logOutboundFailure('[scheduler] digest wake check batch read failed; checking per group this pass:', err);
      }
    }
    const atOrAfter = (at: Date | null | undefined, windowStart: Date) => (
      at != null && new Date(at).getTime() >= windowStart.getTime());
    const isRecentWake = (row: DigestWakeBlockerRow, windowStart: Date) => (
      ((row.status === 'delivered' || row.status === 'acked') && atOrAfter(row.deliveredAt, windowStart))
      || (row.status === 'failed' && atOrAfter(row.updatedAt, windowStart)));

    let enqueued = 0;
    for (const { scope, active } of due) {
      const windowStart = windowStartOf(active);
      const key = digestInstallKey(scope.agentName, scope.instanceId, scope.podId);
      let pendingWake: unknown;
      let recentWake: unknown;
      if (blockers) {
        pendingWake = blockers.pending.has(key);
        recentWake = (blockers.recent.get(key) || []).some((row) => isRecentWake(row, windowStart));
      } else {
        // eslint-disable-next-line no-await-in-loop
        [pendingWake, recentWake] = await Promise.all([
          AgentEvent.exists({ ...scope, status: 'pending', deliveryMode: { $ne: 'digest' } }),
          AgentEvent.exists({ ...scope, deliveryMode: { $ne: 'digest' }, $or: [
            { status: { $in: ['delivered', 'acked'] }, deliveredAt: { $gte: windowStart } },
            // AgentEvent timestamps update on every failed transition, including
            // failures before delivery and failures after an older delivery.
            { status: 'failed', updatedAt: { $gte: windowStart } },
          ] }),
        ]);
      }
      if (pendingWake || recentWake) continue;
      const enqueueAt = performance.now();
      try {
        // eslint-disable-next-line no-await-in-loop
        await AgentEventService.enqueue({
          ...scope,
          type: 'heartbeat',
          payload: {
            trigger: 'unread-digest',
            podId: String(scope.podId),
            generatedAt: now.toISOString(),
            content: '[Unread pod activity is waiting. Read the digest in this inbox batch; respond only if useful.]',
          },
        });
      } finally {
        enqueueMs += elapsedMs(enqueueAt);
      }
      blockers?.pending.add(key);
      enqueued += 1;
    }
    timings.unreadEnqueue = enqueueMs;
    timings.unreadChecks = elapsedMs(stepAt);
    return enqueued;
  }

  static async dispatchAgentHeartbeats(
    options: DispatchHeartbeatsOptions = {},
  ): Promise<DispatchHeartbeatsResult> {
    const {
      trigger = 'scheduled-hourly', respectIntervals = false, now = new Date(), timings = {},
    } = options;

    // F668: ask Mongo only for opted-in installs. Every other row was loaded,
    // decoded and walked each minute only to be dropped by the opt-in check
    // below (which stays, as the contract). Autonomy is deliberately not in
    // the filter: a global agent's dedupe picks its first opted-in install
    // before the autonomy check, and filtering autonomy here would change
    // which sibling wins.
    let stepAt = performance.now();
    const installations: InstallationDoc[] = await AgentInstallation.find({
      status: 'active',
      'config.heartbeat.enabled': true,
    }).select('agentName instanceId podId config.autonomy config.heartbeat').lean();
    timings.installs = elapsedMs(stepAt);

    if (!installations.length) {
      return { scanned: 0, enqueued: 0, skippedByInterval: 0 };
    }

    const lastHeartbeatByKey = new Map<string, Date>();
    stepAt = performance.now();
    if (respectIntervals) {
      // Only the opted-in agents' heartbeats can decide anything below. Both
      // spellings, because the event schema lowercases agentName on write.
      const agentNames = [...new Set(installations.flatMap((inst) => {
        const name = String(inst?.agentName || '');
        return [name, name.toLowerCase()];
      }))];
      const latestHeartbeats: Array<{
        _id: { agentName?: string; instanceId?: string; podId?: string };
        lastCreatedAt: Date;
      }> = await AgentEvent.aggregate([
        { $match: { type: 'heartbeat', agentName: { $in: agentNames } } },
        {
          $group: {
            _id: { agentName: '$agentName', instanceId: '$instanceId', podId: '$podId' },
            lastCreatedAt: { $max: '$createdAt' },
          },
        },
      ]);
      latestHeartbeats.forEach((row) => {
        const key = `${row?._id?.agentName || ''}:${row?._id?.instanceId || 'default'}:${row?._id?.podId || ''}`;
        if (key && row?.lastCreatedAt) {
          lastHeartbeatByKey.set(key, new Date(row.lastCreatedAt));
        }
      });
    }

    timings.aggregate = elapsedMs(stepAt);

    const lastHeartbeatByAgentKey = new Map<string, Date>();
    for (const [key, ts] of lastHeartbeatByKey) {
      const colonIdx = key.lastIndexOf(':');
      const agentKey = key.slice(0, colonIdx);
      const existing = lastHeartbeatByAgentKey.get(agentKey);
      if (!existing || ts > existing) lastHeartbeatByAgentKey.set(agentKey, ts);
    }

    const sortedInstallations = [...installations].sort((a, b) => {
      const aFixed = a?.config?.heartbeat?.fixedPod === true ? -1 : 0;
      const bFixed = b?.config?.heartbeat?.fixedPod === true ? -1 : 0;
      return aFixed - bFixed;
    });

    const seenGlobalAgents = new Set<string>();
    const toProcess: Array<{ installation: InstallationDoc; isGlobal: boolean }> = [];

    for (const installation of sortedInstallations) {
      const { agentName, instanceId = 'default' } = installation || {};
      if (installation?.config?.heartbeat?.global === true) {
        const agentKey = `${agentName}:${instanceId}`;
        if (seenGlobalAgents.has(agentKey)) continue;
        if (installation?.config?.heartbeat?.enabled !== true) continue;
        seenGlobalAgents.add(agentKey);
        toProcess.push({ installation, isGlobal: true });
      } else {
        toProcess.push({ installation, isGlobal: false });
      }
    }

    // F668: decide who is due first, from what is already in memory, and only
    // then do the per-pod reads (the global pod pick, the pending check, the
    // activity hint) for those. A minute where nothing is due now ends here.
    let checked = 0;
    let skippedByInterval = 0;
    const due: Array<{ installation: InstallationDoc; isGlobal: boolean }> = [];
    stepAt = performance.now();
    const nowMinutes = Math.floor(now.getTime() / 60000);
    for (let i = 0; i < toProcess.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (i > 0 && i % HEARTBEAT_DISPATCH_CHUNK === 0) await yieldToEventLoop();
      const { installation, isGlobal } = toProcess[i];
      // Opt-in, not opt-out. `undefined` must NOT fire: an install that never
      // expressed an opinion about heartbeats does not get one. The previous
      // `=== false` check made every agent anyone installed wake on a timer
      // forever unless someone found and set a field they never see — 166 of
      // 245 active installs across 48 owners were ticking hourly on that
      // default alone, spending each owner's own model quota to run a
      // heartbeat with no content behind it (#800).
      if (installation?.config?.heartbeat?.enabled !== true) continue;
      if (installation?.config?.autonomy?.enabled === false) continue;
      checked += 1;

      if (respectIntervals) {
        const { agentName, podId, instanceId = 'default' } = installation || {};
        const key = isGlobal
          ? `${agentName}:${instanceId}`
          : `${agentName}:${instanceId}:${String(podId)}`;
        const lastCreatedAt = isGlobal
          ? lastHeartbeatByAgentKey.get(key)
          : lastHeartbeatByKey.get(key);
        const intervalMinutes = SchedulerService.resolveHeartbeatIntervalMinutes(installation);

        if (lastCreatedAt) {
          const lastMinutes = Math.floor(lastCreatedAt.getTime() / 60000);
          const ageMinutes = nowMinutes - lastMinutes;
          if (ageMinutes < intervalMinutes) {
            skippedByInterval += 1;
            continue;
          }
        } else {
          const staggerOffset = SchedulerService.resolveHeartbeatStaggerOffset(key, intervalMinutes);
          const minuteWithinInterval = nowMinutes % intervalMinutes;
          if (minuteWithinInterval !== staggerOffset) {
            skippedByInterval += 1;
            continue;
          }
        }
      }
      due.push({ installation, isGlobal });
    }
    const dueCheckMs = elapsedMs(stepAt);

    const globalHeartbeatPodMap = new Map<string, string>();
    const globalKeys = [...new Set(
      due
        .filter(({ isGlobal, installation }) => isGlobal && installation?.config?.heartbeat?.fixedPod !== true)
        .map(({ installation }) => {
          const { agentName, instanceId = 'default' } = installation;
          return `${agentName}:${instanceId}`;
        }),
    )];

    stepAt = performance.now();
    if (globalKeys.length > 0) {
      const hintWindowMs = SchedulerService.resolveHeartbeatHintWindowMinutes() * 60 * 1000;
      const orClauses = globalKeys.map((key) => {
        const colonIdx = key.indexOf(':');
        return {
          agentName: key.slice(0, colonIdx),
          instanceId: key.slice(colonIdx + 1),
          status: 'active',
        };
      });

      const globalInstalls: Array<{ agentName: string; instanceId?: string; podId: unknown }> = await AgentInstallation.find({
        $or: orClauses,
        podId: { $exists: true, $ne: null },
      }).select('agentName instanceId podId').lean();

      const podsByKey = new Map<string, Set<string>>();
      globalInstalls.forEach((inst) => {
        const key = `${inst.agentName}:${inst.instanceId || 'default'}`;
        if (!podsByKey.has(key)) podsByKey.set(key, new Set());
        podsByKey.get(key)!.add(String(inst.podId));
      });

      const allGlobalPodIds = [...new Set(globalInstalls.map((i) => i.podId).filter(Boolean))];

      if (allGlobalPodIds.length > 0) {
        const since = new Date(now.getTime() - hintWindowMs);
        const [podActivity, recentPostActivity]: [
          Array<{ podId: string; lastAt: string }>,
          Array<{ _id: unknown; lastAt: Date }>
        ] = await Promise.all([
          PGMessage.findMostRecentPodActivity(allGlobalPodIds, since),
          Post.aggregate([
            { $match: { podId: { $in: allGlobalPodIds }, createdAt: { $gte: since } } },
            { $group: { _id: '$podId', lastAt: { $max: '$createdAt' } } },
            { $sort: { lastAt: -1 } },
          ]),
        ]);

        const postActivityMap = new Map<string, Date>(
          recentPostActivity.map((p) => [String(p._id), p.lastAt]),
        );
        // A Map, not podActivity.find per pod: that was keys × pods × rows.
        // First row wins, as find did.
        const msgActivityMap = new Map<string, string>();
        podActivity.forEach((p) => {
          if (!msgActivityMap.has(p.podId)) msgActivityMap.set(p.podId, p.lastAt);
        });

        const POST_BOOST_MS = 3 * 60 * 60 * 1000;

        for (const [key, podIdSet] of podsByKey) {
          let bestPodId: string | null = null;
          let bestAt: Date | null = null;

          for (const pid of podIdSet) {
            const msgLastAt = msgActivityMap.get(pid);
            const msgAt = msgLastAt !== undefined ? new Date(msgLastAt) : null;
            const postRaw = postActivityMap.has(pid) ? new Date(postActivityMap.get(pid)!) : null;
            const postAt = postRaw ? new Date(postRaw.getTime() + POST_BOOST_MS) : null;
            const podBestAt = msgAt && postAt ? (msgAt > postAt ? msgAt : postAt) : (msgAt || postAt);

            if (process.env.DEBUG_POD_SELECTION && (msgAt || postRaw)) {
              console.log(`[pod-select][${key}] pod=${pid.substring(0, 8)} msgAt=${msgAt?.toISOString() || 'none'} postRaw=${postRaw?.toISOString() || 'none'} podBestAt=${podBestAt?.toISOString() || 'none'}`);
            }

            if (podBestAt && (!bestAt || podBestAt > bestAt)) {
              bestAt = podBestAt;
              bestPodId = pid;
            }
          }

          if (bestPodId) globalHeartbeatPodMap.set(key, bestPodId);
        }
      }
    }

    timings.globalPick = elapsedMs(stepAt);

    const enqueueOne = async (
      { installation, isGlobal }: { installation: InstallationDoc; isGlobal: boolean },
    ): Promise<{ enqueued: number; skippedPending?: number }> => {
      const {
        agentName,
        podId,
        instanceId = 'default',
      } = installation || {};

      const useFixedPod = installation?.config?.heartbeat?.fixedPod === true;
      const heartbeatPodId = isGlobal && !useFixedPod
        ? (globalHeartbeatPodMap.get(`${agentName}:${instanceId}`) || podId)
        : podId;

      // A seat with no listener never drains its queue, so each interval
      // used to add another heartbeat: one dead seat had 168 queued and
      // still read as activity (2026-10-14). One undelivered heartbeat says
      // everything the next would; skip until the seat picks it up.
      const alreadyPending = await AgentEvent.exists({
        agentName: String(agentName || '').toLowerCase(),
        instanceId,
        podId: heartbeatPodId,
        type: 'heartbeat',
        status: 'pending',
      });
      if (alreadyPending) return { enqueued: 0, skippedPending: 1 };

      const activityHint = await SchedulerService.buildHeartbeatActivityHint({ podId: heartbeatPodId, now });

      await AgentEventService.enqueue({
        agentName,
        instanceId,
        podId: heartbeatPodId,
        type: 'heartbeat',
        payload: {
          trigger,
          generatedAt: new Date().toISOString(),
          podId: String(heartbeatPodId),
          activityHint,
          policy: {
            noFetchWhenIdle: true,
            silentOnReadFailure: true,
          },
          // ADR-012 §10.3: inline HEARTBEAT cue. Parallel to the §9 DM
          // frame — narrative directive at the start of payload.content
          // beats structured metadata for behavior steering. Lives in
          // services/heartbeatCue.ts with its own test: it is a contract
          // with every agent, and it already drifted once from the
          // HEARTBEAT.md trailer in registry/presets.ts at real cost
          // (PR #295, 2026-05-04 — see that module's header).
          content: buildHeartbeatContent(heartbeatPodId),
        },
      });
      return { enqueued: 1 };
    };

    // F668: one chunk in flight at a time, yielding between chunks, so a
    // minute with many due seats neither fans out unbounded reads nor holds
    // the loop for the whole batch.
    // A seat that fails never stops the seats after it: every chunk is
    // attempted, as when one Promise.all started them all, and the first
    // failure is raised only once all of them have run.
    const results: Array<{ enqueued: number; skippedPending?: number }> = [];
    let firstFailure: unknown;
    let failed = false;
    stepAt = performance.now();
    for (let i = 0; i < due.length; i += HEARTBEAT_DISPATCH_CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      if (i > 0) await yieldToEventLoop();
      // eslint-disable-next-line no-await-in-loop
      const settled = await Promise.allSettled(due.slice(i, i + HEARTBEAT_DISPATCH_CHUNK).map(enqueueOne));
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') results.push(outcome.value);
        else if (!failed) { failed = true; firstFailure = outcome.reason; }
      }
    }
    if (failed) throw firstFailure;
    const enqueued = results.reduce((sum, r) => sum + r.enqueued, 0);
    const skippedPending = results.reduce((sum, r) => sum + (r.skippedPending || 0), 0);
    timings.perInstall = dueCheckMs + elapsedMs(stepAt);
    timings.checked = checked;

    return {
      scanned: toProcess.length,
      enqueued,
      skippedByInterval,
      skippedPending,
    };
  }
}

export default new SchedulerService();
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
