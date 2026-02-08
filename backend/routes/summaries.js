const express = require('express');

const router = express.Router();
const summarizerService = require('../services/summarizerService');
const Summary = require('../models/Summary');
const User = require('../models/User');

const SummarizerService = summarizerService.constructor;
const chatSummarizerService = require('../services/chatSummarizerService');

const ChatSummarizerService = chatSummarizerService.constructor;
const schedulerService = require('../services/schedulerService');
const AgentEventService = require('../services/agentEventService');
const { AgentInstallation } = require('../models/AgentRegistry');

const SchedulerService = schedulerService.constructor;
const dailyDigestService = require('../services/dailyDigestService');
const auth = require('../middleware/auth');

const SUMMARY_AGENT = 'commonly-bot';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getActiveSummaryInstallationsForPod = async (podId) => AgentInstallation.find({
  agentName: SUMMARY_AGENT,
  podId,
  status: 'active',
}).select('instanceId').lean();

const waitForSummaryByEventIds = async ({
  podId,
  eventIds,
  timeoutMs = 9000,
  intervalMs = 500,
}) => {
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return null;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const summary = await Summary.findOne({
      type: 'chats',
      podId,
      'metadata.eventId': { $in: eventIds },
    }).sort({ createdAt: -1 }).lean();
    if (summary) return summary;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  return null;
};

const isGlobalAdminUser = async (userId) => {
  if (!userId) return false;
  const user = await User.findById(userId).select('role').lean();
  return Boolean(user && user.role === 'admin');
};

// GET /api/summaries - Get recent summaries
router.get('/', auth, async (req, res) => {
  try {
    const { type, limit = 10 } = req.query;
    const summaries = await SummarizerService.getRecentSummaries(
      type,
      parseInt(limit, 10),
    );
    res.json(summaries);
  } catch (error) {
    console.error('Error fetching summaries:', error);
    res.status(500).json({ error: 'Failed to fetch summaries' });
  }
});

// GET /api/summaries/latest - Get the latest summary of each type
router.get('/latest', auth, async (req, res) => {
  try {
    const [postSummaries, chatSummaries] = await Promise.all([
      SummarizerService.getRecentSummaries('posts', 1),
      SummarizerService.getRecentSummaries('chats', 1),
    ]);

    let posts = postSummaries[0] || null;
    if (!posts) {
      try {
        posts = await summarizerService.summarizeAllPosts();
      } catch (allPostsError) {
        console.warn('Failed to build on-demand all-posts summary for /latest:', allPostsError.message);
      }
    }

    res.json({
      posts,
      chats: chatSummaries[0] || null,
    });
  } catch (error) {
    console.error('Error fetching latest summaries:', error);
    res.status(500).json({ error: 'Failed to fetch latest summaries' });
  }
});

// POST /api/summaries/trigger - Manually trigger agent summary refresh
router.post('/trigger', auth, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    if (!(await isGlobalAdminUser(userId))) {
      return res.status(403).json({ error: 'Global admin access required' });
    }

    // Manual refresh path now enqueues agent summary events only (no direct legacy summarizer calls).
    await SummarizerService.garbageCollectForDigest();
    const [integrationResults, podSummaryDispatch] = await Promise.all([
      SchedulerService.summarizeIntegrationBuffers(),
      SchedulerService.dispatchPodSummaryRequests({
        trigger: 'manual-refresh',
        windowMinutes: 60,
      }),
    ]);

    res.json({
      message: 'Agent summary refresh triggered successfully',
      result: {
        mode: 'agent-event-only',
        integrationResultsCount: integrationResults.length,
        podSummaryDispatch,
      },
    });
  } catch (error) {
    console.error('Error triggering summarizer:', error);
    res.status(500).json({ error: 'Failed to trigger summarizer' });
  }
});

// POST /api/summaries/debug - Debug endpoint to test summarizer (development only)
router.post('/debug', auth, async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res
        .status(403)
        .json({ error: 'Debug endpoints not available in production' });
    }

    const result = await SchedulerService.triggerSummarizer();
    res.json({
      message: 'Debug summarizer triggered successfully',
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in debug summarizer:', error);
    res.status(500).json({
      error: 'Failed to trigger debug summarizer',
      details: error.message,
    });
  }
});

// GET /api/summaries/status - Get scheduler status
router.get('/status', auth, async (req, res) => {
  try {
    const status = schedulerService.getStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting scheduler status:', error);
    res.status(500).json({ error: 'Failed to get scheduler status' });
  }
});

// GET /api/summaries/chat-rooms - Get recent chat room summaries
router.get('/chat-rooms', auth, async (req, res) => {
  try {
    const { limit = 5 } = req.query;
    const chatRoomSummaries = await ChatSummarizerService.getRecentChatSummariesByPodType(
      'chat',
      parseInt(limit, 10),
    );
    res.json(chatRoomSummaries);
  } catch (error) {
    console.error('Error fetching chat room summaries:', error);
    res.status(500).json({ error: 'Failed to fetch chat room summaries' });
  }
});

// GET /api/summaries/chat-rooms/latest - Get the latest chat room summary
router.get('/chat-rooms/latest', auth, async (req, res) => {
  try {
    const latestChatSummary = await ChatSummarizerService.getLatestChatSummary();
    res.json(latestChatSummary);
  } catch (error) {
    console.error('Error fetching latest chat room summary:', error);
    res.status(500).json({ error: 'Failed to fetch latest chat room summary' });
  }
});

// GET /api/summaries/study-rooms - Get recent study room summaries
router.get('/study-rooms', auth, async (req, res) => {
  try {
    const { limit = 5 } = req.query;
    const studyRoomSummaries = await ChatSummarizerService.getRecentChatSummariesByPodType(
      'study',
      parseInt(limit, 10),
    );
    res.json(studyRoomSummaries);
  } catch (error) {
    console.error('Error fetching study room summaries:', error);
    res.status(500).json({ error: 'Failed to fetch study room summaries' });
  }
});

// GET /api/summaries/game-rooms - Get recent game room summaries
router.get('/game-rooms', auth, async (req, res) => {
  try {
    const { limit = 5 } = req.query;
    const gameRoomSummaries = await ChatSummarizerService.getRecentChatSummariesByPodType(
      'games',
      parseInt(limit, 10),
    );
    res.json(gameRoomSummaries);
  } catch (error) {
    console.error('Error fetching game room summaries:', error);
    res.status(500).json({ error: 'Failed to fetch game room summaries' });
  }
});

// GET /api/summaries/all-posts - Get a summary of all existing posts
router.get('/all-posts', auth, async (req, res) => {
  try {
    const allPostsSummary = await summarizerService.summarizeAllPosts();
    res.json(allPostsSummary);
  } catch (error) {
    console.error('Error generating all posts summary:', error);
    res.status(500).json({ error: 'Failed to generate all posts summary' });
  }
});

// GET /api/summaries/pod/:podId - Get the latest summary for a specific pod
router.get('/pod/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const podSummary = await ChatSummarizerService.getLatestPodSummary(podId);
    res.json(podSummary);
  } catch (error) {
    console.error('Error fetching pod summary:', error);
    res.status(500).json({ error: 'Failed to fetch pod summary' });
  }
});

// GET /api/summaries/pods - Get summaries for multiple pods
router.get('/pods', auth, async (req, res) => {
  try {
    const { podIds } = req.query; // Expected as comma-separated string
    if (!podIds) {
      return res.status(400).json({ error: 'podIds parameter is required' });
    }

    const podIdArray = podIds.split(',').map((id) => id.trim());
    const podSummaries = await ChatSummarizerService.getMultiplePodSummaries(podIdArray);
    res.json(podSummaries);
  } catch (error) {
    console.error('Error fetching pod summaries:', error);
    res.status(500).json({ error: 'Failed to fetch pod summaries' });
  }
});

// POST /api/summaries/pod/:podId/refresh - Manually generate a fresh summary for a specific pod
router.post('/pod/:podId/refresh', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    console.log(`Manual summary refresh requested for pod: ${podId}`);
    const windowMinutes = Math.max(5, Math.min(240, parseInt(req.body?.windowMinutes, 10) || 60));
    const installations = await getActiveSummaryInstallationsForPod(podId);
    if (!installations.length) {
      const fallbackSummary = await chatSummarizerService.summarizePodMessages(podId);
      return res.json({
        message: 'Summary refreshed successfully (fallback mode)',
        summary: fallbackSummary || null,
        queued: false,
        fallback: true,
      });
    }

    const enqueueResults = await Promise.allSettled(
      installations.map((installation) => AgentEventService.enqueue({
        agentName: SUMMARY_AGENT,
        instanceId: installation.instanceId || 'default',
        podId,
        type: 'summary.request',
        payload: {
          source: 'pod',
          trigger: 'manual-pod-refresh',
          windowMinutes,
          includeDigest: true,
          silent: true,
        },
      })),
    );

    const enqueueErrors = enqueueResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason?.message || 'Unknown enqueue error');
    if (enqueueErrors.length > 0) {
      console.warn('Summary refresh enqueue failures:', {
        podId,
        failures: enqueueErrors,
      });
    }

    const eventIds = enqueueResults
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value?._id?.toString())
      .filter(Boolean);

    if (!eventIds.length) {
      const fallbackSummary = await chatSummarizerService.summarizePodMessages(podId);
      const latestSummary = fallbackSummary || await ChatSummarizerService.getLatestPodSummary(podId);
      return res.json({
        message: 'Summary refresh could not enqueue agent events; fallback summary returned',
        summary: latestSummary || null,
        queued: false,
        fallback: true,
        warning: 'summary-enqueue-failed',
      });
    }

    const summary = await waitForSummaryByEventIds({
      podId,
      eventIds,
    });

    if (!summary) {
      const fallbackSummary = await chatSummarizerService.summarizePodMessages(podId);
      const latestSummary = fallbackSummary || await ChatSummarizerService.getLatestPodSummary(podId);
      return res.json({
        message: 'Summary request queued; fallback summary generated',
        summary: latestSummary || null,
        queued: true,
        fallback: true,
      });
    }

    res.json({
      message: 'Summary refreshed successfully (agent-generated)',
      summary,
      queued: false,
    });
  } catch (error) {
    console.error('Error refreshing pod summary:', error);
    res.status(500).json({ error: 'Failed to refresh pod summary' });
  }
});

// GET /api/summaries/daily-digest - Get user's daily digest
router.get('/daily-digest', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get the most recent daily digest for this user
    const dailyDigest = await Summary.findOne({
      type: 'daily-digest',
      'metadata.userId': userId,
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!dailyDigest) {
      return res
        .status(404)
        .json({
          error:
            'No daily digest found. Daily digests are generated every morning at 6 AM UTC.',
        });
    }

    res.json(dailyDigest);
  } catch (error) {
    console.error('Error fetching daily digest:', error);
    res.status(500).json({ error: 'Failed to fetch daily digest' });
  }
});

// POST /api/summaries/daily-digest/generate - Manually generate daily digest for current user
router.post('/daily-digest/generate', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    console.log(`Manual daily digest generation requested for user: ${userId}`);

    // Trigger garbage collection first
    await SummarizerService.garbageCollectForDigest();

    // Generate fresh daily digest
    const digest = await dailyDigestService.generateUserDailyDigest(userId);

    res.json({
      message: 'Daily digest generated successfully',
      digest,
    });
  } catch (error) {
    console.error('Error generating daily digest:', error);
    res.status(500).json({ error: 'Failed to generate daily digest' });
  }
});

// GET /api/summaries/daily-digest/history - Get user's daily digest history
router.get('/daily-digest/history', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 7 } = req.query; // Default to last 7 days

    const digestHistory = await Summary.find({
      type: 'daily-digest',
      'metadata.userId': userId,
    })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit, 10))
      .select(
        'title content createdAt timeRange metadata.totalItems metadata.subscribedPods',
      )
      .lean();

    res.json(digestHistory);
  } catch (error) {
    console.error('Error fetching daily digest history:', error);
    res.status(500).json({ error: 'Failed to fetch daily digest history' });
  }
});

// POST /api/summaries/daily-digest/trigger-all - Manually trigger daily digest generation for all users (admin only)
router.post('/daily-digest/trigger-all', auth, async (req, res) => {
  try {
    // In production, you should check admin privileges here

    console.log('Manual daily digest generation requested for all users');

    // Trigger garbage collection first
    await SummarizerService.garbageCollectForDigest();

    // Generate daily digests for all users
    const results = await dailyDigestService.generateAllDailyDigests();

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    res.json({
      message: 'Daily digest generation completed',
      results: {
        total: results.length,
        successful,
        failed,
        details: results,
      },
    });
  } catch (error) {
    console.error(
      'Error triggering daily digest generation for all users:',
      error,
    );
    res
      .status(500)
      .json({ error: 'Failed to trigger daily digest generation' });
  }
});

module.exports = router;
