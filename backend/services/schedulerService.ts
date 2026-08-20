// eslint-disable-next-line global-require
const cron = require('node-cron');
const crypto = require('crypto');
// eslint-disable-next-line global-require
const { refreshCodexOAuthTokenIfNeeded } = require('./agentProvisionerServiceK8s');
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
// eslint-disable-next-line global-require
const AgentEnsembleService = require('./agentEnsembleService');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { buildHeartbeatContent } = require('./heartbeatCue') as {
  buildHeartbeatContent: (heartbeatPodId: unknown) => string;
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
  };
}

interface HeartbeatActivityHint {
  lookbackMinutes: number;
  since: string;
  messageCount: number;
  postCount: number;
  totalSignals: number;
  hasRecentActivity: boolean;
  lastMessageAt: string | null;
  lastPostAt: string | null;
  generatedAt: string;
}

interface DispatchHeartbeatsOptions {
  trigger?: string;
  respectIntervals?: boolean;
  now?: Date;
}

interface DispatchHeartbeatsResult {
  scanned: number;
  enqueued: number;
  skippedByInterval: number;
}

interface DispatchPodSummaryOptions {
  trigger?: string;
  windowMinutes?: number;
}

interface SummarizeResult {
  success: boolean;
  results: Record<string, unknown>;
  duration: number;
}

interface CodexRefreshResult {
  suffix?: string;
  expiresAt: number;
}

// Cron jobs are process-local. Keep one module-private owner so a second
// SchedulerService instance cannot start a duplicate job set in this process.
let activeScheduler: SchedulerService | null = null;

class SchedulerService {
  isRunning: boolean;

  jobs: CronJob[];

  constructor() {
    this.isRunning = false;
    this.jobs = [];
  }

  start(): void {
    if (activeScheduler) {
      console.log('Scheduler is already running');
      return;
    }

    console.log('Starting summarizer scheduler...');

    const summarizerJob: CronJob = cron.schedule(
      '0 * * * *',
      async () => {
        console.log('Running hourly summarizer...');
        try {
          await SchedulerService.runSummarizer();
        } catch (error) {
          console.error('Error in scheduled summarizer:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const externalFeedJob: CronJob = cron.schedule(
      '*/10 * * * *',
      async () => {
        console.log('Syncing external social feeds...');
        try {
          await externalFeedService.syncExternalFeeds();
        } catch (error) {
          console.error('Error syncing external feeds:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const agentEventGcJob: CronJob = cron.schedule(
      '*/10 * * * *',
      async () => {
        console.log('Running agent event garbage collection...');
        try {
          const result = await AgentEventService.garbageCollect();
          if (result.totalDeleted > 0) {
            console.log(
              `Agent event GC removed ${result.totalDeleted} event(s) `
              + `(pending=${result.deletedPending}, delivered=${result.deletedDelivered}, `
              + `failed=${result.deletedFailed})`,
            );
          }
        } catch (error) {
          console.error('Error in scheduled agent event GC:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const dailyDigestJob: CronJob = cron.schedule(
      '0 6 * * *',
      async () => {
        console.log('Running daily digest generation...');
        try {
          const digestResults = await dailyDigestService.generateAllDailyDigests();
          await digestEmailService.sendDigestEmails(digestResults);
        } catch (error) {
          console.error('Error in scheduled daily digest generation:', error);
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
          console.error('Error in scheduled cleanup:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const ensembleJob: CronJob = cron.schedule(
      '*/5 * * * *',
      async () => {
        console.log('Running ensemble scheduler...');
        try {
          await AgentEnsembleService.processScheduled();
        } catch (error) {
          console.error('Error in scheduled ensemble processing:', error);
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
          console.error('Error in themed pod autonomy scheduler:', error);
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
          console.error('Error in agent auto-join scheduler:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const agentHeartbeatJob: CronJob = cron.schedule(
      '* * * * *',
      async () => {
        console.log('Dispatching agent heartbeat events...');
        try {
          const result = await SchedulerService.dispatchAgentHeartbeats({
            trigger: 'scheduled-interval',
            respectIntervals: true,
          });
          console.log(`Agent heartbeats enqueued: ${result.enqueued}`);
        } catch (error) {
          console.error('Error dispatching agent heartbeats:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const agentSessionResetJob: CronJob = cron.schedule(
      '0 * * * *',
      async () => {
        if (!AgentEventService.isSessionResetDue()) return;
        console.log('Running scheduled OpenClaw session reset...');
        try {
          const result = await AgentEventService.clearOpenClawSessionsForActiveInstallations({
            source: 'scheduled-session-reset',
            restart: true,
          });
          console.log(
            'OpenClaw session reset complete. '
            + `Targeted=${result.targetedInstances}, Cleared=${result.clearedCount}, Failed=${result.failedCount}`,
          );
        } catch (error) {
          console.error('Error in scheduled OpenClaw session reset:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const agentSessionSizeCheckJob: CronJob = cron.schedule(
      '*/10 * * * *',
      async () => {
        try {
          const result = await AgentEventService.clearOversizedAgentSessions({
            source: 'scheduled-size-check',
            restart: false,
          });
          if (result.cleared > 0) {
            console.log(
              `[session-size-check] Cleared ${result.cleared} oversized session(s) `
              + `(threshold: ${result.thresholdKb} KB): `
              + result.oversized.map((o: { accountId: string; kb: number }) => `${o.accountId}=${o.kb}KB`).join(', '),
            );
          }
        } catch (error) {
          console.error('Error in agent session size check:', error);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    const codexTokenRefreshJob: CronJob = cron.schedule(
      '0 3 * * *',
      async () => {
        try {
          const results: CodexRefreshResult[] | null = await refreshCodexOAuthTokenIfNeeded({ thresholdDays: 3 });
          if (results && results.length > 0) {
            results.forEach((r) => {
              console.log(`[codex-token-refresh] Refreshed account${r.suffix || '1'}. New expiry: ${new Date(r.expiresAt).toISOString()}`);
            });
          }
        } catch (error) {
          const err = error as { message?: string };
          console.error('[codex-token-refresh] Failed:', err.message);
        }
      },
      { scheduled: false, timezone: 'UTC' },
    );

    // Refresh the skill marketplace catalog from the upstream openclaw/skills
    // repo every 6 hours — pulls the latest JSON and overlays fresh star
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
          console.error('[skills-refresh] Unhandled error:', error);
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
      '*/5 * * * *',
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
          console.error('[onboarding-silence] Unhandled error:', error);
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
    const stalledConnectJob: CronJob = cron.schedule(
      '*/5 * * * *',
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
            + `notStalled=${r.skippedNotStalled}`,
          );
        } catch (error) {
          console.error('[stalled-connect] Unhandled error:', error);
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
          console.error('[kernel-sweep] pass failed:', error);
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
      ensembleJob,
      themedPodAutonomyJob,
      agentAutoJoinJob,
      agentHeartbeatJob,
      agentSessionResetJob,
      agentSessionSizeCheckJob,
      codexTokenRefreshJob,
      skillsRefreshJob,
      onboardingSilenceJob,
      stalledConnectJob,
      kernelWorkSweepJob,
    ];
    this.jobs.forEach((job) => job.start());
    this.isRunning = true;
    activeScheduler = this;

    console.log('Scheduler started successfully');
    console.log('- Summarizer runs every hour');
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
    console.log(
      `- OpenClaw sessions reset every ${AgentEventService.getSessionResetIntervalHours()} hour(s)`,
    );
    console.log('- Agent session size check runs every 10 minutes (clears if > AGENT_SESSION_MAX_SIZE_KB, default 400 KB)');
    console.log('- Codex OAuth token refresh check runs daily at 3 AM UTC (refreshes if expiring within 3 days)');
    console.log('- Stale agent events are garbage-collected every 10 minutes');
    console.log('- Stalled-connect nudge scan runs every 5 minutes');
    console.log(
      '- Onboarding-silence scan runs every 5 minutes'
      + `${process.env.ONBOARDING_ALERT_EMAIL ? '' : ' (LOG-ONLY: ONBOARDING_ALERT_EMAIL unset)'}`,
    );
    console.log('- Skills catalog refreshes from upstream every 6 hours (stars re-fetched via GitHub API)');

    setTimeout(() => {
      SchedulerService.runSummarizer().catch((error) => {
        console.error('Error in initial summarizer run:', error);
      });
    }, 5000);

    setTimeout(() => {
      externalFeedService.syncExternalFeeds().catch((error: unknown) => {
        console.error('Error in initial external feed sync:', error);
      });
    }, 7000);

    setTimeout(() => {
      AgentEventService.garbageCollect().catch((error: unknown) => {
        console.error('Error in initial agent event GC:', error);
      });
    }, 8000);

    setTimeout(() => {
      PodCurationService.runThemedPodAutonomy({ hours: 12, minMatches: 4 }).catch((error: unknown) => {
        console.error('Error in initial themed pod autonomy run:', error);
      });
    }, 9000);

    setTimeout(() => {
      SchedulerService.dispatchAgentHeartbeats({
        trigger: 'startup',
        respectIntervals: true,
      }).catch((error: unknown) => {
        console.error('Error in initial heartbeat dispatch:', error);
      });
    }, 11000);

    setTimeout(() => {
      if (!AgentEventService.isSessionResetDue()) return;
      AgentEventService.clearOpenClawSessionsForActiveInstallations({
        source: 'startup-session-reset',
        restart: true,
      }).catch((error: unknown) => {
        console.error('Error in initial OpenClaw session reset:', error);
      });
    }, 12000);

    setTimeout(() => {
      AgentAutoJoinService.runAutoJoinAgentOwnedPods({ source: 'startup-autojoin' }).catch((error: unknown) => {
        console.error('Error in initial auto-join run:', error);
      });
    }, 13000);

    // Kick a skill catalog refresh 30s after startup so dev gets fresh data
    // without waiting for the first 6-hourly cron window.
    setTimeout(() => {
      refreshSkillsIndex()
        .then((result: { refreshed: number; reposUpdated: number; reposTotal: number; errors: Error[] }) => {
          console.log(
            `[skills-refresh] Startup refresh done: refreshed=${result.refreshed} `
            + `repos=${result.reposUpdated}/${result.reposTotal} errors=${result.errors.length}`,
          );
        })
        .catch((error: unknown) => {
          console.error('[skills-refresh] Startup refresh failed:', error);
        });
    }, 30000);
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
    this.jobs = [];
    this.isRunning = false;
    activeScheduler = null;
    console.log('Scheduler stopped');
  }

  static async runSummarizer(): Promise<SummarizeResult> {
    const startTime = Date.now();
    console.log('Starting summarization process...');

    try {
      console.log('Step 0: Garbage collecting old summaries...');
      await SummarizerService.garbageCollectForDigest();

      console.log('Step 1: Summarizing external integration buffers...');
      await SchedulerService.summarizeIntegrationBuffers();

      console.log('Step 2: Dispatching pod summary requests to commonly-bot...');
      const podSummaryDispatch = await SchedulerService.dispatchPodSummaryRequests();

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
      console.error('Summarization process failed:', error);
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
            console.error(`Error syncing Discord integration ${integration._id}:`, error);
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
      console.error('Error in Discord integration sync:', error);
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
            const DiscordSummaryHistory = require('../models/DiscordSummaryHistory');
            const history = new DiscordSummaryHistory({
              integrationId: integration._id,
              summaryType: 'hourly',
              content: (summary as Record<string, unknown>).content,
              messageCount: (summary as Record<string, unknown>).messageCount,
              timeRange: (summary as Record<string, unknown>).timeRange,
              postedToCommonly: false,
              postedToDiscord: false,
            });
            await history.save();
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
      console.error('Error summarizing integration buffers:', error);
      return [];
    }
  }

  static async dispatchPodSummaryRequests(
    options: DispatchPodSummaryOptions = {},
  ): Promise<{ enqueued: number }> {
    const { trigger = 'scheduled-hourly', windowMinutes = 60 } = options;

    const installations: Array<{ podId: unknown; instanceId?: string }> = await AgentInstallation.find({
      agentName: 'commonly-bot',
      status: 'active',
    }).select('podId instanceId').lean();

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
      { count: number; lastAt?: string | Date },
      Array<{ _id: unknown; count: number; lastAt?: Date }>
    ] = await Promise.all([
      PGMessage.findActivityHint(podId, since),
      Post.aggregate([
        { $match: { podId, createdAt: { $gte: since } } },
        { $group: { _id: null, count: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
      ]),
    ]);

    const messageCount = pgMsgHint.count;
    const postCount = Number(postStats?.[0]?.count || 0);
    const totalSignals = messageCount + postCount;

    return {
      lookbackMinutes,
      since: since.toISOString(),
      messageCount,
      postCount,
      totalSignals,
      hasRecentActivity: totalSignals > 0,
      lastMessageAt: pgMsgHint.lastAt ? new Date(pgMsgHint.lastAt).toISOString() : null,
      lastPostAt: postStats?.[0]?.lastAt ? new Date(postStats[0].lastAt).toISOString() : null,
      generatedAt: now.toISOString(),
    };
  }

  static async dispatchAgentHeartbeats(
    options: DispatchHeartbeatsOptions = {},
  ): Promise<DispatchHeartbeatsResult> {
    const { trigger = 'scheduled-hourly', respectIntervals = false, now = new Date() } = options;

    const installations: InstallationDoc[] = await AgentInstallation.find({
      status: 'active',
    }).select('agentName instanceId podId config.autonomy config.heartbeat').lean();

    if (!installations.length) {
      return { scanned: 0, enqueued: 0, skippedByInterval: 0 };
    }

    const lastHeartbeatByKey = new Map<string, Date>();
    if (respectIntervals) {
      const latestHeartbeats: Array<{
        _id: { agentName?: string; instanceId?: string; podId?: string };
        lastCreatedAt: Date;
      }> = await AgentEvent.aggregate([
        { $match: { type: 'heartbeat' } },
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

    const globalHeartbeatPodMap = new Map<string, string>();
    const globalKeys = [...new Set(
      toProcess
        .filter(({ isGlobal }) => isGlobal)
        .map(({ installation }) => {
          const { agentName, instanceId = 'default' } = installation;
          return `${agentName}:${instanceId}`;
        }),
    )];

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

      // eslint-disable-next-line no-await-in-loop
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
        // eslint-disable-next-line no-await-in-loop
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

        const POST_BOOST_MS = 3 * 60 * 60 * 1000;

        for (const [key, podIdSet] of podsByKey) {
          let bestPodId: string | null = null;
          let bestAt: Date | null = null;

          for (const pid of podIdSet) {
            const msgPod = podActivity.find((p) => p.podId === pid);
            const msgAt = msgPod ? new Date(msgPod.lastAt) : null;
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

    const enqueueResults = await Promise.all(
      toProcess.map(async ({ installation, isGlobal }) => {
        // Opt-in, not opt-out. `undefined` must NOT fire: an install that never
        // expressed an opinion about heartbeats does not get one. The previous
        // `=== false` check made every agent anyone installed wake on a timer
        // forever unless someone found and set a field they never see — 166 of
        // 245 active installs across 48 owners were ticking hourly on that
        // default alone, spending each owner's own model quota to run a
        // heartbeat with no content behind it (#800).
        const heartbeatEnabled = installation?.config?.heartbeat?.enabled;
        if (heartbeatEnabled !== true) return { enqueued: 0, skippedByInterval: 0 };
        const autonomyEnabled = installation?.config?.autonomy?.enabled;
        if (autonomyEnabled === false) return { enqueued: 0, skippedByInterval: 0 };

        const {
          agentName,
          podId,
          instanceId = 'default',
        } = installation || {};

        if (respectIntervals) {
          const key = isGlobal
            ? `${agentName}:${instanceId}`
            : `${agentName}:${instanceId}:${String(podId)}`;
          const lastCreatedAt = isGlobal
            ? lastHeartbeatByAgentKey.get(key)
            : lastHeartbeatByKey.get(key);
          const intervalMinutes = SchedulerService.resolveHeartbeatIntervalMinutes(installation);
          const nowMinutes = Math.floor(now.getTime() / 60000);

          if (lastCreatedAt) {
            const lastMinutes = Math.floor(lastCreatedAt.getTime() / 60000);
            const ageMinutes = nowMinutes - lastMinutes;
            if (ageMinutes < intervalMinutes) {
              return { enqueued: 0, skippedByInterval: 1 };
            }
          } else {
            const staggerOffset = SchedulerService.resolveHeartbeatStaggerOffset(key, intervalMinutes);
            const minuteWithinInterval = nowMinutes % intervalMinutes;
            if (minuteWithinInterval !== staggerOffset) {
              return { enqueued: 0, skippedByInterval: 1 };
            }
          }
        }

        const useFixedPod = installation?.config?.heartbeat?.fixedPod === true;
        const heartbeatPodId = isGlobal && !useFixedPod
          ? (globalHeartbeatPodMap.get(`${agentName}:${instanceId}`) || podId)
          : podId;

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
        return { enqueued: 1, skippedByInterval: 0 };
      }),
    );

    const enqueued = enqueueResults.reduce(
      (sum, value) => sum + ((value as { enqueued?: number })?.enqueued || 0),
      0,
    );
    const skippedByInterval = enqueueResults.reduce(
      (sum, value) => sum + ((value as { skippedByInterval?: number })?.skippedByInterval || 0),
      0,
    );

    return {
      scanned: toProcess.length,
      enqueued,
      skippedByInterval,
    };
  }
}

export default new SchedulerService();
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
