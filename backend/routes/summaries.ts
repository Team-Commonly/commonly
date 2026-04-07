// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const summarizerService = require('../services/summarizerService');
// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const chatSummarizerService = require('../services/chatSummarizerService');
// eslint-disable-next-line global-require
const schedulerService = require('../services/schedulerService');
// eslint-disable-next-line global-require
const AgentEventService = require('../services/agentEventService');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const dailyDigestService = require('../services/dailyDigestService');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');

interface AuthReq {
  user?: { id: string };
  userId?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

const SummarizerService = summarizerService.constructor;
const ChatSummarizerService = chatSummarizerService.constructor;
const SchedulerService = schedulerService.constructor;

const SUMMARY_AGENT = 'commonly-bot';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getActiveSummaryInstallationsForPod = async (podId: string) => AgentInstallation.find({ agentName: SUMMARY_AGENT, podId, status: 'active' }).select('instanceId').lean();

const waitForSummaryByEventIds = async ({ podId, eventIds, timeoutMs = 9000, intervalMs = 500 }: { podId: string; eventIds: string[]; timeoutMs?: number; intervalMs?: number }) => {
  if (!Array.isArray(eventIds) || eventIds.length === 0) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const summary = await Summary.findOne({ type: 'chats', podId, 'metadata.eventId': { $in: eventIds } }).sort({ createdAt: -1 }).lean();
    if (summary) return summary;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  return null;
};

const isGlobalAdminUser = async (userId: unknown): Promise<boolean> => {
  if (!userId) return false;
  const user = await User.findById(userId).select('role').lean() as { role?: string } | null;
  return Boolean(user && user.role === 'admin');
};

router.get('/', auth, async (req: AuthReq, res: Res) => {
  try {
    const { type, limit = '10' } = req.query || {};
    const summaries = await SummarizerService.getRecentSummaries(type, parseInt(limit, 10));
    res.json(summaries);
  } catch (error) {
    console.error('Error fetching summaries:', error);
    res.status(500).json({ error: 'Failed to fetch summaries' });
  }
});

router.get('/latest', auth, async (_req: AuthReq, res: Res) => {
  try {
    const [postSummaries, chatSummaries] = await Promise.all([SummarizerService.getRecentSummaries('posts', 1), SummarizerService.getRecentSummaries('chats', 1)]);
    let posts = postSummaries[0] || null;
    if (!posts) {
      try { posts = await summarizerService.summarizeAllPosts(); } catch (allPostsError) {
        console.warn('Failed to build on-demand all-posts summary:', (allPostsError as Error).message);
      }
    }
    res.json({ posts, chats: chatSummaries[0] || null });
  } catch (error) {
    console.error('Error fetching latest summaries:', error);
    res.status(500).json({ error: 'Failed to fetch latest summaries' });
  }
});

router.post('/trigger', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = req.user?.id || req.userId;
    if (!(await isGlobalAdminUser(userId))) return res.status(403).json({ error: 'Global admin access required' });
    await SummarizerService.garbageCollectForDigest();
    const [integrationResults, podSummaryDispatch] = await Promise.all([SchedulerService.summarizeIntegrationBuffers(), SchedulerService.dispatchPodSummaryRequests({ trigger: 'manual-refresh', windowMinutes: 60 })]);
    res.json({ message: 'Agent summary refresh triggered successfully', result: { mode: 'agent-event-only', integrationResultsCount: (integrationResults as unknown[]).length, podSummaryDispatch } });
  } catch (error) {
    console.error('Error triggering summarizer:', error);
    res.status(500).json({ error: 'Failed to trigger summarizer' });
  }
});

router.post('/debug', auth, async (_req: AuthReq, res: Res) => {
  try {
    if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'Debug endpoints not available in production' });
    const result = await SchedulerService.triggerSummarizer();
    res.json({ message: 'Debug summarizer triggered successfully', result, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error in debug summarizer:', error);
    res.status(500).json({ error: 'Failed to trigger debug summarizer', details: (error as Error).message });
  }
});

router.get('/status', auth, (_req: AuthReq, res: Res) => {
  try {
    const status = schedulerService.getStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting scheduler status:', error);
    res.status(500).json({ error: 'Failed to get scheduler status' });
  }
});

router.get('/chat-rooms', auth, async (req: AuthReq, res: Res) => {
  try {
    const { limit = '5' } = req.query || {};
    const chatRoomSummaries = await ChatSummarizerService.getRecentChatSummariesByPodType('chat', parseInt(limit, 10));
    res.json(chatRoomSummaries);
  } catch (error) {
    console.error('Error fetching chat room summaries:', error);
    res.status(500).json({ error: 'Failed to fetch chat room summaries' });
  }
});

router.get('/chat-rooms/latest', auth, async (_req: AuthReq, res: Res) => {
  try {
    const latestChatSummary = await ChatSummarizerService.getLatestChatSummary();
    res.json(latestChatSummary);
  } catch (error) {
    console.error('Error fetching latest chat room summary:', error);
    res.status(500).json({ error: 'Failed to fetch latest chat room summary' });
  }
});

router.get('/study-rooms', auth, async (req: AuthReq, res: Res) => {
  try {
    const { limit = '5' } = req.query || {};
    const studyRoomSummaries = await ChatSummarizerService.getRecentChatSummariesByPodType('study', parseInt(limit, 10));
    res.json(studyRoomSummaries);
  } catch (error) {
    console.error('Error fetching study room summaries:', error);
    res.status(500).json({ error: 'Failed to fetch study room summaries' });
  }
});

router.get('/game-rooms', auth, async (req: AuthReq, res: Res) => {
  try {
    const { limit = '5' } = req.query || {};
    const gameRoomSummaries = await ChatSummarizerService.getRecentChatSummariesByPodType('games', parseInt(limit, 10));
    res.json(gameRoomSummaries);
  } catch (error) {
    console.error('Error fetching game room summaries:', error);
    res.status(500).json({ error: 'Failed to fetch game room summaries' });
  }
});

router.get('/all-posts', auth, async (_req: AuthReq, res: Res) => {
  try {
    const allPostsSummary = await summarizerService.summarizeAllPosts();
    res.json(allPostsSummary);
  } catch (error) {
    console.error('Error generating all posts summary:', error);
    res.status(500).json({ error: 'Failed to generate all posts summary' });
  }
});

router.get('/pod/:podId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const podSummary = await ChatSummarizerService.getLatestPodSummary(podId);
    res.json(podSummary);
  } catch (error) {
    console.error('Error fetching pod summary:', error);
    res.status(500).json({ error: 'Failed to fetch pod summary' });
  }
});

router.get('/pods', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podIds } = req.query || {};
    if (!podIds) return res.status(400).json({ error: 'podIds parameter is required' });
    const podIdArray = podIds.split(',').map((id) => id.trim());
    const podSummaries = await chatSummarizerService.getMultiplePodSummaries(podIdArray);
    res.json(podSummaries);
  } catch (error) {
    console.error('Error fetching pod summaries:', error);
    res.status(500).json({ error: 'Failed to fetch pod summaries' });
  }
});

router.post('/pod/:podId/refresh', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const windowMinutes = Math.max(5, Math.min(240, parseInt((req.body?.windowMinutes as string) || '60', 10) || 60));
    const installations = await getActiveSummaryInstallationsForPod(podId || '') as Array<{ instanceId?: string }>;
    if (!installations.length) {
      const fallbackSummary = await chatSummarizerService.summarizePodMessages(podId);
      return res.json({ message: 'Summary refreshed successfully (fallback mode)', summary: fallbackSummary || null, queued: false, fallback: true });
    }
    const enqueueResults = await Promise.allSettled(installations.map((installation) => AgentEventService.enqueue({ agentName: SUMMARY_AGENT, instanceId: installation.instanceId || 'default', podId, type: 'summary.request', payload: { source: 'pod', trigger: 'manual-pod-refresh', windowMinutes, includeDigest: true, silent: true } })));
    const enqueueErrors = enqueueResults.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason?.message || 'Unknown enqueue error');
    if (enqueueErrors.length > 0) console.warn('Summary refresh enqueue failures:', { podId, failures: enqueueErrors });
    const eventIds = enqueueResults.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ _id?: { toString: () => string } }>).value?._id?.toString()).filter(Boolean) as string[];
    if (!eventIds.length) {
      const fallbackSummary = await chatSummarizerService.summarizePodMessages(podId);
      const latestSummary = fallbackSummary || await ChatSummarizerService.getLatestPodSummary(podId);
      return res.json({ message: 'Summary refresh could not enqueue agent events; fallback summary returned', summary: latestSummary || null, queued: false, fallback: true, warning: 'summary-enqueue-failed' });
    }
    const summary = await waitForSummaryByEventIds({ podId: podId || '', eventIds });
    if (!summary) {
      const fallbackSummary = await chatSummarizerService.summarizePodMessages(podId);
      const latestSummary = fallbackSummary || await ChatSummarizerService.getLatestPodSummary(podId);
      return res.json({ message: 'Summary request queued; fallback summary generated', summary: latestSummary || null, queued: true, fallback: true });
    }
    res.json({ message: 'Summary refreshed successfully (agent-generated)', summary, queued: false });
  } catch (error) {
    console.error('Error refreshing pod summary:', error);
    res.status(500).json({ error: 'Failed to refresh pod summary' });
  }
});

router.get('/daily-digest', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = req.user?.id;
    const dailyDigest = await Summary.findOne({ type: 'daily-digest', 'metadata.userId': userId }).sort({ createdAt: -1 }).lean();
    if (!dailyDigest) return res.status(404).json({ error: 'No daily digest found. Daily digests are generated every morning at 6 AM UTC.' });
    res.json(dailyDigest);
  } catch (error) {
    console.error('Error fetching daily digest:', error);
    res.status(500).json({ error: 'Failed to fetch daily digest' });
  }
});

router.post('/daily-digest/generate', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = req.user?.id;
    await SummarizerService.garbageCollectForDigest();
    const digest = await dailyDigestService.generateUserDailyDigest(userId);
    res.json({ message: 'Daily digest generated successfully', digest });
  } catch (error) {
    console.error('Error generating daily digest:', error);
    res.status(500).json({ error: 'Failed to generate daily digest' });
  }
});

router.get('/daily-digest/history', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = req.user?.id;
    const { limit = '7' } = req.query || {};
    const digestHistory = await Summary.find({ type: 'daily-digest', 'metadata.userId': userId }).sort({ createdAt: -1 }).limit(parseInt(limit, 10)).select('title content createdAt timeRange metadata.totalItems metadata.subscribedPods').lean();
    res.json(digestHistory);
  } catch (error) {
    console.error('Error fetching daily digest history:', error);
    res.status(500).json({ error: 'Failed to fetch daily digest history' });
  }
});

router.post('/daily-digest/trigger-all', auth, async (_req: AuthReq, res: Res) => {
  try {
    await SummarizerService.garbageCollectForDigest();
    const results = await dailyDigestService.generateAllDailyDigests() as Array<{ success: boolean }>;
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    res.json({ message: 'Daily digest generation completed', results: { total: results.length, successful, failed, details: results } });
  } catch (error) {
    console.error('Error triggering daily digest generation for all users:', error);
    res.status(500).json({ error: 'Failed to trigger daily digest generation' });
  }
});

module.exports = router;
