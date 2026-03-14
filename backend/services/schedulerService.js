const cron = require('node-cron');
const crypto = require('crypto');
const { refreshCodexOAuthTokenIfNeeded } = require('./agentProvisionerServiceK8s');
const summarizerService = require('./summarizerService');
const Integration = require('../models/Integration');
const IntegrationSummaryService = require('./integrationSummaryService');
const AgentEventService = require('./agentEventService');
const PodAssetService = require('./podAssetService');
const externalFeedService = require('./externalFeedService');
const { AgentInstallation } = require('../models/AgentRegistry');
const AgentEvent = require('../models/AgentEvent');
const AgentEnsembleService = require('./agentEnsembleService');
const PodCurationService = require('./podCurationService');
const AgentAutoJoinService = require('./agentAutoJoinService');
const PGMessage = require('../models/pg/Message');
const Post = require('../models/Post');

const SummarizerService = summarizerService.constructor;
const chatSummarizerService = require('./chatSummarizerService');
const dailyDigestService = require('./dailyDigestService');

class SchedulerService {
  constructor() {
    this.isRunning = false;
    this.jobs = [];
  }

  start() {
    if (this.isRunning) {
      console.log('Scheduler is already running');
      return;
    }

    console.log('Starting summarizer scheduler...');

    // Run summarizer every hour at minute 0
    const summarizerJob = cron.schedule(
      '0 * * * *',
      async () => {
        console.log('Running hourly summarizer...');
        try {
          await SchedulerService.runSummarizer();
        } catch (error) {
          console.error('Error in scheduled summarizer:', error);
        }
      },
      {
        scheduled: false,
        timezone: 'UTC',
      },
    );

    const externalFeedJob = cron.schedule(
      '*/10 * * * *',
      async () => {
        console.log('Syncing external social feeds...');
        try {
          await externalFeedService.syncExternalFeeds();
        } catch (error) {
          console.error('Error syncing external feeds:', error);
        }
      },
      {
        scheduled: false,
        timezone: 'UTC',
      },
    );

    const agentEventGcJob = cron.schedule(
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
      {
        scheduled: false,
        timezone: 'UTC',
      },
    );

    // Generate daily digests at 6 AM UTC (early morning for most users)
    const dailyDigestJob = cron.schedule(
      '0 6 * * *',
      async () => {
        console.log('Running daily digest generation...');
        try {
          await dailyDigestService.generateAllDailyDigests();
        } catch (error) {
          console.error('Error in scheduled daily digest generation:', error);
        }
      },
      {
        scheduled: false,
        timezone: 'UTC',
      },
    );

    // Clean up old summaries daily at 2 AM UTC
    const cleanupJob = cron.schedule(
      '0 2 * * *',
      async () => {
        console.log('Running daily cleanup...');
        try {
          await SummarizerService.cleanOldSummaries(30); // Keep 30 days of daily digests
        } catch (error) {
          console.error('Error in scheduled cleanup:', error);
        }
      },
      {
        scheduled: false,
        timezone: 'UTC',
      },
    );

    const ensembleJob = cron.schedule(
      '*/5 * * * *',
      async () => {
        console.log('Running ensemble scheduler...');
        try {
          await AgentEnsembleService.processScheduled();
        } catch (error) {
          console.error('Error in scheduled ensemble processing:', error);
        }
      },
      {
        scheduled: false,
        timezone: 'UTC',
      },
    );

    const themedPodAutonomyJob = cron.schedule(
      '15 */2 * * *',
      async () => {
        console.log('Running themed pod autonomy...');
        try {
          const result = await PodCurationService.runThemedPodAutonomy({
            hours: 12,
            minMatches: 4,
          });
          console.log(
            `Themed pod autonomy complete. Created: ${result.createdPods?.length || 0}, `
            + `Triggered: ${result.triggeredPods?.length || 0}`,
          );
        } catch (error) {
          console.error('Error in themed pod autonomy scheduler:', error);
        }
      },
      {
        scheduled: false,
        timezone: 'UTC',
      },
    );

    const agentAutoJoinJob = cron.schedule(
      '45 */2 * * *',
      async () => {
        console.log('Running agent auto-join for agent-owned pods...');
        try {
          const result = await AgentAutoJoinService.runAutoJoinAgentOwnedPods({
            source: 'scheduled-autojoin',
          });
          console.log(`Agent auto-join complete. Installed: ${result.installed}, Sources: ${result.scannedSources}`);
        } catch (error) {
          console.error('Error in agent auto-join scheduler:', error);
        }
      },
      {
        scheduled: false,
        timezone: 'UTC',
      },
    );

    const agentHeartbeatJob = cron.schedule(
      '*/10 * * * *',
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
      {
        scheduled: false,
        timezone: 'UTC',
      },
    );

    const agentSessionResetJob = cron.schedule(
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
      {
        scheduled: false,
        timezone: 'UTC',
      },
    );

    const agentSessionSizeCheckJob = cron.schedule(
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
              + result.oversized.map((o) => `${o.accountId}=${o.kb}KB`).join(', '),
            );
          }
        } catch (error) {
          console.error('Error in agent session size check:', error);
        }
      },
      {
        scheduled: false,
        timezone: 'UTC',
      },
    );

    // Refresh Codex OAuth token daily at 3 AM UTC if expiring within 3 days
    const codexTokenRefreshJob = cron.schedule(
      '0 3 * * *',
      async () => {
        try {
          const result = await refreshCodexOAuthTokenIfNeeded({ thresholdDays: 3 });
          if (result) {
            console.log(`[codex-token-refresh] Refreshed. New expiry: ${new Date(result.expiresAt).toISOString()}`);
          }
        } catch (error) {
          console.error('[codex-token-refresh] Failed:', error.message);
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
    ];
    this.jobs.forEach((job) => job.start());
    this.isRunning = true;

    console.log('Scheduler started successfully');
    console.log('- Summarizer runs every hour');
    console.log('- Cleanup runs daily at 2 AM UTC');
    console.log('- External feeds sync every 10 minutes');
    console.log('- Agent event GC runs every 10 minutes');
    console.log('- Themed pod autonomy runs every 2 hours');
    console.log('- Agent auto-join (agent-owned pods) runs every 2 hours');
    console.log('- Agent heartbeats run every 10 minutes with per-agent intervals');
    console.log(
      `- OpenClaw sessions reset every ${AgentEventService.getSessionResetIntervalHours()} hour(s)`,
    );
    console.log('- Agent session size check runs every 10 minutes (clears if > AGENT_SESSION_MAX_SIZE_KB, default 400 KB)');
    console.log('- Codex OAuth token refresh check runs daily at 3 AM UTC (refreshes if expiring within 3 days)');
    console.log(
      '- Stale agent events are garbage-collected every 10 minutes',
    );
    // Run initial summarizer after a short delay
    setTimeout(() => {
      SchedulerService.runSummarizer().catch((error) => {
        console.error('Error in initial summarizer run:', error);
      });
    }, 5000); // 5 second delay

    setTimeout(() => {
      externalFeedService.syncExternalFeeds().catch((error) => {
        console.error('Error in initial external feed sync:', error);
      });
    }, 7000);

    setTimeout(() => {
      AgentEventService.garbageCollect().catch((error) => {
        console.error('Error in initial agent event GC:', error);
      });
    }, 8000);

    setTimeout(() => {
      PodCurationService.runThemedPodAutonomy({
        hours: 12,
        minMatches: 4,
      }).catch((error) => {
        console.error('Error in initial themed pod autonomy run:', error);
      });
    }, 9000);

    setTimeout(() => {
      SchedulerService.dispatchAgentHeartbeats({
        trigger: 'startup',
        respectIntervals: true,
      }).catch((error) => {
        console.error('Error in initial heartbeat dispatch:', error);
      });
    }, 11000);

    setTimeout(() => {
      if (!AgentEventService.isSessionResetDue()) return;
      AgentEventService.clearOpenClawSessionsForActiveInstallations({
        source: 'startup-session-reset',
        restart: true,
      }).catch((error) => {
        console.error('Error in initial OpenClaw session reset:', error);
      });
    }, 12000);

    setTimeout(() => {
      AgentAutoJoinService.runAutoJoinAgentOwnedPods({
        source: 'startup-autojoin',
      }).catch((error) => {
        console.error('Error in initial auto-join run:', error);
      });
    }, 13000);
  }

  stop() {
    if (!this.isRunning) {
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
    console.log('Scheduler stopped');
  }

  static async runSummarizer() {
    const startTime = Date.now();
    console.log('Starting summarization process...');

    try {
      // Step 0: Garbage collect old summaries for daily digest preparation
      console.log('Step 0: Garbage collecting old summaries...');
      await SummarizerService.garbageCollectForDigest();

      // Step 1: Summarize external integration buffers
      console.log('Step 1: Summarizing external integration buffers...');
      await SchedulerService.summarizeIntegrationBuffers();

      // Step 2: Agent-driven pod summary requests
      console.log('Step 2: Dispatching pod summary requests to commonly-bot...');
      const podSummaryDispatch = await SchedulerService.dispatchPodSummaryRequests();

      // Step 3 (legacy): optional direct summarizers
      let chatRoomSummaries = [];
      let postSummary = { status: 'skipped', reason: 'legacy summarizer disabled' };
      let chatSummary = { status: 'skipped', reason: 'legacy summarizer disabled' };

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

      console.log(`✓ Pod summary requests enqueued: ${podSummaryDispatch.enqueued}`);

      const duration = Date.now() - startTime;
      console.log(`Summarization completed in ${duration}ms`);

      const result = {
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

  /**
   * Sync all active Discord integrations
   * Fetches recent messages from Discord and posts summaries to Commonly pods
   */
  static async syncAllDiscordIntegrations() {
    try {
      // Find all active Discord integrations with webhook listeners enabled
      const discordIntegrations = await Integration.find({
        type: 'discord',
        isActive: true,
        'config.webhookListenerEnabled': true,
      }).populate('platformIntegration');

      console.log(
        `Found ${discordIntegrations.length} active Discord integration(s)`,
      );

      const results = await Promise.allSettled(
        discordIntegrations.map(async (integration) => {
          try {
            // eslint-disable-next-line global-require
            const registry = require('../integrations');
            const provider = registry.get('discord', integration);
            await provider.validateConfig();

            const syncResult = await provider.syncRecent({ hours: 1 }); // 1 hour
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
            console.error(
              `Error syncing Discord integration ${integration._id}:`,
              error,
            );
            return {
              integrationId: integration._id,
              success: false,
              messageCount: 0,
              content: error.message,
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

  /**
   * Summarize buffered messages for external integrations
   */
  static async summarizeIntegrationBuffers() {
    try {
      const integrations = await Integration.find({
        type: { $in: ['discord', 'slack', 'telegram', 'groupme', 'x', 'instagram'] },
        isActive: true,
        'config.messageBuffer.0': { $exists: true },
      }).lean();

      if (!integrations.length) {
        return [];
      }

      const results = await Promise.allSettled(
        integrations.map(async (integration) => {
          if (
            integration.type === 'discord'
            && !integration?.config?.webhookListenerEnabled
          ) {
            return {
              integrationId: integration._id,
              success: false,
              skipped: true,
              reason: 'Auto sync disabled',
            };
          }

          const buffer = integration?.config?.messageBuffer || [];
          if (!buffer.length) {
            return {
              integrationId: integration._id,
              success: true,
              messageCount: 0,
              content: 'No buffered messages',
            };
          }

          const summary = await IntegrationSummaryService.createSummary(
            integration,
            buffer,
          );

          try {
            await PodAssetService.createIntegrationSummaryAsset({
              integration,
              summary,
            });
          } catch (assetError) {
            console.error(
              `Failed to persist pod asset for integration ${integration._id}:`,
              assetError,
            );
          }

          const installations = await AgentInstallation.find({
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
                  integrationId: integration._id.toString(),
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
              content: summary.content,
              messageCount: summary.messageCount,
              timeRange: summary.timeRange,
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
            messageCount: summary.messageCount,
            content: summary.content,
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

  static async dispatchPodSummaryRequests({ trigger = 'scheduled-hourly', windowMinutes = 60 } = {}) {
    const installations = await AgentInstallation.find({
      agentName: 'commonly-bot',
      status: 'active',
    }).select('podId instanceId').lean();

    if (!installations.length) {
      return { enqueued: 0 };
    }

    await Promise.all(
      installations.map((installation) => (
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

    return { enqueued: installations.length };
  }

  // Manual trigger for testing
  static async triggerSummarizer() {
    console.log('Manually triggering summarizer...');
    return SchedulerService.runSummarizer();
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      jobCount: this.jobs.length,
      nextRun: this.jobs.length > 0 ? 'Next hour at minute 0' : 'Not scheduled',
    };
  }

  static resolveHeartbeatIntervalMinutes(installation) {
    const parsed = Number(installation?.config?.heartbeat?.everyMinutes);
    if (!Number.isFinite(parsed) || parsed <= 0) return 60;
    return Math.max(1, Math.min(1440, Math.trunc(parsed)));
  }

  /**
   * Returns a deterministic minute offset (0..intervalMinutes-1) for an agent,
   * derived from a SHA-256 hash of its identity key. Used to stagger first-fire
   * times so all agents don't fire simultaneously after a cold start.
   * The offset is rounded to the nearest 10-minute cron tick boundary.
   */
  static resolveHeartbeatStaggerOffset(agentKey, intervalMinutes) {
    const tickWindow = 10; // scheduler cron runs every 10 min
    const numSlots = Math.max(1, Math.floor(intervalMinutes / tickWindow));
    const digest = crypto.createHash('sha256').update(agentKey).digest();
    const slotIndex = digest.readUInt32BE(0) % numSlots;
    return slotIndex * tickWindow;
  }

  static resolveHeartbeatHintWindowMinutes() {
    const parsed = Number(process.env.AGENT_HEARTBEAT_SIGNAL_WINDOW_MINUTES);
    if (!Number.isFinite(parsed) || parsed <= 0) return 120;
    return Math.max(5, Math.min(1440, Math.trunc(parsed)));
  }

  static async buildHeartbeatActivityHint({ podId, now = new Date() } = {}) {
    if (!podId) return null;
    const lookbackMinutes = this.resolveHeartbeatHintWindowMinutes();
    const since = new Date(now.getTime() - (lookbackMinutes * 60 * 1000));

    const [pgMsgHint, postStats] = await Promise.all([
      PGMessage.findActivityHint(podId, since),
      Post.aggregate([
        {
          $match: {
            podId,
            createdAt: { $gte: since },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            lastAt: { $max: '$createdAt' },
          },
        },
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

  static async dispatchAgentHeartbeats({
    trigger = 'scheduled-hourly',
    respectIntervals = false,
    now = new Date(),
  } = {}) {
    const installations = await AgentInstallation.find({
      status: 'active',
    }).select('agentName instanceId podId config.autonomy config.heartbeat').lean();

    if (!installations.length) {
      return { scanned: 0, enqueued: 0, skippedByInterval: 0 };
    }

    const lastHeartbeatByKey = new Map();
    if (respectIntervals) {
      const latestHeartbeats = await AgentEvent.aggregate([
        { $match: { type: 'heartbeat' } },
        {
          $group: {
            _id: {
              agentName: '$agentName',
              instanceId: '$instanceId',
              podId: '$podId',
            },
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

    // For global agents, compute max last-heartbeat across all pods (agentName:instanceId key)
    const lastHeartbeatByAgentKey = new Map();
    for (const [key, ts] of lastHeartbeatByKey) {
      const colonIdx = key.lastIndexOf(':');
      const agentKey = key.slice(0, colonIdx); // strip :podId
      const existing = lastHeartbeatByAgentKey.get(agentKey);
      if (!existing || ts > existing) lastHeartbeatByAgentKey.set(agentKey, ts);
    }

    // Deduplicate global agents — only one installation fires per agentName:instanceId
    // Sort so fixedPod:true installations are processed first — they always win the dedup slot
    // and pin the heartbeat to their own podId (e.g. DM pod), preventing topic-pod routing.
    const sortedInstallations = [...installations].sort((a, b) => {
      const aFixed = a?.config?.heartbeat?.fixedPod === true ? -1 : 0;
      const bFixed = b?.config?.heartbeat?.fixedPod === true ? -1 : 0;
      return aFixed - bFixed;
    });
    const seenGlobalAgents = new Set();
    const toProcess = [];
    for (const installation of sortedInstallations) {
      const { agentName, instanceId = 'default' } = installation || {};
      if (installation?.config?.heartbeat?.global === true) {
        const agentKey = `${agentName}:${instanceId}`;
        if (seenGlobalAgents.has(agentKey)) continue;
        // Skip disabled installations without claiming the slot — let the enabled one claim it
        if (installation?.config?.heartbeat?.enabled === false) continue;
        seenGlobalAgents.add(agentKey);
        toProcess.push({ installation, isGlobal: true });
      } else {
        toProcess.push({ installation, isGlobal: false });
      }
    }

    // Batch-fetch best pod for each global agent (avoids N+1 per-agent queries)
    const globalHeartbeatPodMap = new Map(); // agentKey -> best podId
    const globalKeys = [...new Set(
      toProcess
        .filter(({ isGlobal }) => isGlobal)
        .map(({ installation }) => {
          const { agentName, instanceId = 'default' } = installation;
          return `${agentName}:${instanceId}`;
        }),
    )];
    if (globalKeys.length > 0) {
      const hintWindowMs = this.resolveHeartbeatHintWindowMinutes() * 60 * 1000;
      const orClauses = globalKeys.map((key) => {
        const colonIdx = key.indexOf(':');
        return {
          agentName: key.slice(0, colonIdx),
          instanceId: key.slice(colonIdx + 1),
          status: 'active',
        };
      });
      // eslint-disable-next-line no-await-in-loop
      const globalInstalls = await AgentInstallation.find({
        $or: orClauses,
        podId: { $exists: true, $ne: null },
      }).select('agentName instanceId podId').lean();
      // Group podIds by agentKey
      const podsByKey = new Map();
      globalInstalls.forEach((inst) => {
        const key = `${inst.agentName}:${inst.instanceId || 'default'}`;
        if (!podsByKey.has(key)) podsByKey.set(key, new Set());
        podsByKey.get(key).add(inst.podId.toString());
      });
      const allGlobalPodIds = [...new Set(globalInstalls.map((i) => i.podId).filter(Boolean))];
      if (allGlobalPodIds.length > 0) {
        const since = new Date(now.getTime() - hintWindowMs);
        // eslint-disable-next-line no-await-in-loop
        const [podActivity, recentPostActivity] = await Promise.all([
          PGMessage.findMostRecentPodActivity(allGlobalPodIds, since),
          Post.aggregate([
            { $match: { podId: { $in: allGlobalPodIds }, createdAt: { $gte: since } } },
            { $group: { _id: '$podId', lastAt: { $max: '$createdAt' } } },
            { $sort: { lastAt: -1 } },
          ]),
        ]);
        // Build a map of podId -> most recent post timestamp
        const postActivityMap = new Map(
          recentPostActivity.map((p) => [p._id.toString(), p.lastAt]),
        );
        // Posts get a recency boost so pods with new posts are preferred over chat-only pods
        const POST_BOOST_MS = 3 * 60 * 60 * 1000; // 3h boost for posts
        // For each global agent, pick pod with most recent activity (message OR post, posts boosted)
        for (const [key, podIdSet] of podsByKey) {
          let bestPodId = null;
          let bestAt = null;
          for (const pid of podIdSet) {
            const msgPod = podActivity.find((p) => p.podId === pid);
            const msgAt = msgPod ? new Date(msgPod.lastAt) : null;
            const postRaw = postActivityMap.has(pid) ? new Date(postActivityMap.get(pid)) : null;
            // Boost post recency so a fresh post beats a pod with only messages
            const postAt = postRaw ? new Date(postRaw.getTime() + POST_BOOST_MS) : null;
            const podBestAt = msgAt && postAt ? (msgAt > postAt ? msgAt : postAt) : (msgAt || postAt);
            if (process.env.DEBUG_POD_SELECTION && (msgAt || postRaw)) {
              console.log(`[pod-select][${key}] pod=${pid.substring(0,8)} msgAt=${msgAt?.toISOString()||'none'} postRaw=${postRaw?.toISOString()||'none'} podBestAt=${podBestAt?.toISOString()||'none'}`);
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
        const heartbeatEnabled = installation?.config?.heartbeat?.enabled;
        if (heartbeatEnabled === false) return { enqueued: 0, skippedByInterval: 0 };
        const autonomyEnabled = installation?.config?.autonomy?.enabled;
        if (autonomyEnabled === false) return { enqueued: 0, skippedByInterval: 0 };
        const {
          agentName,
          podId,
          instanceId = 'default',
        } = installation || {};

        if (respectIntervals) {
          // Global agents share one interval key across all pods
          const key = isGlobal
            ? `${agentName}:${instanceId}`
            : `${agentName}:${instanceId}:${podId}`;
          const lastCreatedAt = isGlobal
            ? lastHeartbeatByAgentKey.get(key)
            : lastHeartbeatByKey.get(key);
          const intervalMinutes = this.resolveHeartbeatIntervalMinutes(installation);
          const nowMinutes = Math.floor(now.getTime() / 60000);
          if (lastCreatedAt) {
            // Compare using whole-minute buckets so cron ticks (every 10m at :00)
            // don't miss by 1-59s when last heartbeat was recorded at :01..:59.
            const lastMinutes = Math.floor(lastCreatedAt.getTime() / 60000);
            const ageMinutes = nowMinutes - lastMinutes;
            if (ageMinutes < intervalMinutes) {
              return { enqueued: 0, skippedByInterval: 1 };
            }
          } else {
            // No prior heartbeat (cold start). Stagger agents so they don't all
            // fire on the first scheduler tick. Each agent gets a deterministic
            // 10-minute slot within the interval, derived from its identity key.
            const staggerOffset = this.resolveHeartbeatStaggerOffset(key, intervalMinutes);
            const minuteWithinInterval = nowMinutes % intervalMinutes;
            if (minuteWithinInterval < staggerOffset || minuteWithinInterval >= staggerOffset + 10) {
              return { enqueued: 0, skippedByInterval: 1 };
            }
          }
        }

        // For global agents, use pre-fetched best pod (avoids per-agent DB queries).
        // fixedPod:true pins heartbeat to the installation's own podId (e.g. DM pod) and skips
        // the activity-based rerouting so narration never lands in a topic pod.
        const useFixedPod = installation?.config?.heartbeat?.fixedPod === true;
        const heartbeatPodId = isGlobal && !useFixedPod
          ? (globalHeartbeatPodMap.get(`${agentName}:${instanceId}`) || podId)
          : podId;

        const activityHint = await this.buildHeartbeatActivityHint({ podId: heartbeatPodId, now });

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
            content: (() => {
              const lines = [
                `Scheduler heartbeat for pod ${String(heartbeatPodId)}.`,
                'Read your HEARTBEAT.md workspace file and follow it exactly.',
                'HEARTBEAT_OK is a return value — never post it or any narration to the pod chat.',
              ];
              return lines.join('\n');
            })(),
          },
        });
        return { enqueued: 1, skippedByInterval: 0 };
      }),
    );
    const enqueued = enqueueResults.reduce((sum, value) => sum + (value?.enqueued || 0), 0);
    const skippedByInterval = enqueueResults.reduce(
      (sum, value) => sum + (value?.skippedByInterval || 0),
      0,
    );

    return {
      scanned: toProcess.length,
      enqueued,
      skippedByInterval,
    };
  }
}

module.exports = new SchedulerService();
