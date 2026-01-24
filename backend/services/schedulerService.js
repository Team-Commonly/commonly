const cron = require('node-cron');
const summarizerService = require('./summarizerService');
const Integration = require('../models/Integration');

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

    this.jobs = [summarizerJob, dailyDigestJob, cleanupJob];
    this.jobs.forEach((job) => job.start());
    this.isRunning = true;

    console.log('Scheduler started successfully');
    console.log('- Summarizer runs every hour');
    console.log('- Cleanup runs daily at 2 AM UTC');

    // Run initial summarizer after a short delay
    setTimeout(() => {
      SchedulerService.runSummarizer().catch((error) => {
        console.error('Error in initial summarizer run:', error);
      });
    }, 5000); // 5 second delay
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

      // Step 1: Sync Discord integrations (fetch recent messages and post to pods)
      console.log('Step 1: Syncing Discord integrations...');
      await SchedulerService.syncAllDiscordIntegrations();

      // Step 2: Summarize individual chat rooms
      console.log('Step 2: Summarizing individual chat rooms...');
      const chatRoomSummaries = await chatSummarizerService.summarizeAllActiveChats();

      // Step 3: Run main summarizers (posts and overall chat summary)
      console.log('Step 3: Running main summarizers...');
      const [postSummary, chatSummary] = await Promise.allSettled([
        summarizerService.summarizePosts(),
        summarizerService.summarizeChats(),
      ]);

      // Log results
      console.log(
        `✓ Created ${chatRoomSummaries.length} individual chat room summaries`,
      );

      if (postSummary.status === 'fulfilled') {
        console.log(`✓ Posts summary created: "${postSummary.value.title}"`);
      } else {
        console.error('✗ Posts summary failed:', postSummary.reason);
      }

      if (chatSummary.status === 'fulfilled') {
        console.log(
          `✓ Overall chat summary created: "${chatSummary.value.title}"`,
        );
      } else {
        console.error('✗ Overall chat summary failed:', chatSummary.reason);
      }

      const duration = Date.now() - startTime;
      console.log(`Summarization completed in ${duration}ms`);

      const result = {
        success: true,
        results: {
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
      });

      console.log(
        `Found ${discordIntegrations.length} active Discord integration(s)`,
      );

      const results = await Promise.allSettled(
        discordIntegrations.map(async (integration) => {
          try {
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
}

module.exports = new SchedulerService();
