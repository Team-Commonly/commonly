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
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
// eslint-disable-next-line global-require
const { createHash } = require('crypto');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const DMService = require('../services/dmService');

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

// Same token/IP keying as the messages-router limiters (#614): key on the
// hashed auth token when present so NATed users don't share a bucket, fall
// back to the IPv6-safe IP key.
const summariesRateLimitKey = (req: { get?: (h: string) => string | undefined; ip?: string }) => {
  const authHeader = req.get?.('authorization');
  if (authHeader) {
    return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
  }
  return req.ip ? ipKeyGenerator(req.ip) : 'anon';
};

// Reads hit Mongo (and canViewPod adds per-pod lookups) — throttle so a
// leaked token can't spray unbounded GETs.
const summariesReadRateLimit = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: summariesRateLimitKey,
  handler: (_req: unknown, res: Res) => {
    res.status(429).json({ error: 'rate limit exceeded: 240 summary reads per 60s' });
  },
});

// Trigger endpoints fan out LLM calls / regenerate summaries — much tighter.
const summariesTriggerRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: summariesRateLimitKey,
  handler: (_req: unknown, res: Res) => {
    res.status(429).json({ error: 'rate limit exceeded: 10 summary triggers per 60s' });
  },
});


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

// Summaries inherit the visibility of the pod they describe (parity with
// the /announcements + /files + /external-links gates on the pods router
// and the canViewPod gate on GET /pod/:podId below). Given a mixed list
// of Summary docs, keep only:
//   - pod-scoped summaries whose pod the caller can view,
//   - the caller's own daily-digest summaries,
//   - global summaries (no podId, not a digest — e.g. all-posts).
const filterSummariesToViewable = async (
  userId: unknown,
  summaries: unknown[],
): Promise<unknown[]> => {
  const list = (summaries || []).filter(Boolean) as Array<{
    podId?: unknown;
    type?: string;
    metadata?: { userId?: string };
  }>;
  const podIds = [...new Set(list.filter((s) => s.podId).map((s) => String(s.podId)))];
  const allowed = new Set<string>();
  if (podIds.length > 0) {
    const pods = await Pod.find({ _id: { $in: podIds } }).select('_id members type').lean() as Array<{ _id: unknown; members?: unknown[]; type?: string }>;
    await Promise.all(pods.map(async (pod) => {
      if (await DMService.canViewPod(userId, pod)) allowed.add(String(pod._id));
    }));
  }
  return list.filter((s) => {
    if (s.podId) return allowed.has(String(s.podId));
    if (s.type === 'daily-digest') return String(s.metadata?.userId || '') === String(userId);
    return true;
  });
};

router.get('/', summariesReadRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const { type, limit = '10' } = req.query || {};
    const cappedLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
    const userId = req.userId || req.user?.id;
    const summaries = await SummarizerService.getRecentSummaries(type, cappedLimit);
    res.json(await filterSummariesToViewable(userId, summaries));
  } catch (error) {
    console.error('Error fetching summaries:', error);
    res.status(500).json({ error: 'Failed to fetch summaries' });
  }
});

router.get('/latest', summariesReadRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = req.userId || req.user?.id;
    const [postSummaries, chatSummaries] = await Promise.all([SummarizerService.getRecentSummaries('posts', 1), SummarizerService.getRecentSummaries('chats', 20)]);
    let posts = postSummaries[0] || null;
    if (!posts) {
      try { posts = await summarizerService.summarizeAllPosts(); } catch (allPostsError) {
        console.warn('Failed to build on-demand all-posts summary:', (allPostsError as Error).message);
      }
    }
    const viewableChats = await filterSummariesToViewable(userId, chatSummaries);
    res.json({ posts, chats: viewableChats[0] || null });
  } catch (error) {
    console.error('Error fetching latest summaries:', error);
    res.status(500).json({ error: 'Failed to fetch latest summaries' });
  }
});

router.post('/trigger', summariesTriggerRateLimit, auth, async (req: AuthReq, res: Res) => {
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

router.post('/debug', summariesTriggerRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    // Admin-only: the live cluster runs with NODE_ENV=development, so an
    // env check alone leaves this trigger open to every authed user.
    if (!(await isGlobalAdminUser(req.user?.id || req.userId))) return res.status(403).json({ error: 'Global admin access required' });
    if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'Debug endpoints not available in production' });
    const result = await SchedulerService.triggerSummarizer();
    res.json({ message: 'Debug summarizer triggered successfully', result, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error in debug summarizer:', error);
    res.status(500).json({ error: 'Failed to trigger debug summarizer', details: (error as Error).message });
  }
});

router.get('/status', summariesReadRateLimit, auth, (_req: AuthReq, res: Res) => {
  try {
    const status = schedulerService.getStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting scheduler status:', error);
    res.status(500).json({ error: 'Failed to get scheduler status' });
  }
});

router.get('/chat-rooms', summariesReadRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const { limit = '5' } = req.query || {};
    const userId = req.userId || req.user?.id;
    const chatRoomSummaries = await ChatSummarizerService.getRecentChatSummariesByPodType('chat', Math.max(1, Math.min(50, parseInt(limit, 10) || 5)));
    res.json(await filterSummariesToViewable(userId, chatRoomSummaries));
  } catch (error) {
    console.error('Error fetching chat room summaries:', error);
    res.status(500).json({ error: 'Failed to fetch chat room summaries' });
  }
});

router.get('/chat-rooms/latest', summariesReadRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = req.userId || req.user?.id;
    const recentChatSummaries = await ChatSummarizerService.getRecentChatSummariesByPodType('chat', 20);
    const viewable = await filterSummariesToViewable(userId, recentChatSummaries);
    res.json(viewable[0] || null);
  } catch (error) {
    console.error('Error fetching latest chat room summary:', error);
    res.status(500).json({ error: 'Failed to fetch latest chat room summary' });
  }
});

router.get('/study-rooms', summariesReadRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const { limit = '5' } = req.query || {};
    const userId = req.userId || req.user?.id;
    const studyRoomSummaries = await ChatSummarizerService.getRecentChatSummariesByPodType('study', Math.max(1, Math.min(50, parseInt(limit, 10) || 5)));
    res.json(await filterSummariesToViewable(userId, studyRoomSummaries));
  } catch (error) {
    console.error('Error fetching study room summaries:', error);
    res.status(500).json({ error: 'Failed to fetch study room summaries' });
  }
});

router.get('/game-rooms', summariesReadRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const { limit = '5' } = req.query || {};
    const userId = req.userId || req.user?.id;
    const gameRoomSummaries = await ChatSummarizerService.getRecentChatSummariesByPodType('games', Math.max(1, Math.min(50, parseInt(limit, 10) || 5)));
    res.json(await filterSummariesToViewable(userId, gameRoomSummaries));
  } catch (error) {
    console.error('Error fetching game room summaries:', error);
    res.status(500).json({ error: 'Failed to fetch game room summaries' });
  }
});

router.get('/all-posts', summariesReadRateLimit, auth, async (_req: AuthReq, res: Res) => {
  try {
    const allPostsSummary = await summarizerService.summarizeAllPosts();
    res.json(allPostsSummary);
  } catch (error) {
    // Fail closed: the summarizer no longer fabricates filler when the LLM is
    // unavailable, so this is a service-unavailable, not a server bug.
    console.error('All posts summary unavailable:', (error as Error).message);
    res.status(503).json({ error: 'summary_unavailable' });
  }
});

router.get('/pod/:podId', summariesReadRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    // Pod-scoped summaries inherit pod visibility — non-members of personal
    // pods (agent-room / agent-dm / agent-admin) must not learn pod
    // existence or its summarized content. Parity with the /announcements
    // + /files + /external-links gates on the pods router.
    const pod = await Pod.findById(podId).select('_id members type').lean();
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    const userId = req.userId || req.user?.id;
    const canView = await DMService.canViewPod(userId, pod);
    if (!canView) return res.status(403).json({ error: 'Not authorized to view this pod summary' });
    const podSummary = await ChatSummarizerService.getLatestPodSummary(podId);
    res.json(podSummary);
  } catch (error) {
    console.error('Error fetching pod summary:', error);
    res.status(500).json({ error: 'Failed to fetch pod summary' });
  }
});

router.get('/pods', summariesReadRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const { podIds } = req.query || {};
    if (!podIds) return res.status(400).json({ error: 'podIds parameter is required' });
    const podIdArray = [...new Set(podIds.split(',').map((id) => id.trim()).filter(Boolean))].slice(0, 50);
    // Same visibility rule as GET /pod/:podId — silently drop pods the
    // caller can't view rather than 403ing the whole batch, so a mixed
    // sidebar request still resolves for the viewable subset.
    const userId = req.userId || req.user?.id;
    const pods = await Pod.find({ _id: { $in: podIdArray } }).select('_id members type').lean() as Array<{ _id: unknown; members?: unknown[]; type?: string }>;
    const viewablePodIds: string[] = [];
    await Promise.all(pods.map(async (pod) => {
      if (await DMService.canViewPod(userId, pod)) viewablePodIds.push(String(pod._id));
    }));
    if (viewablePodIds.length === 0) return res.json({});
    const podSummaries = await chatSummarizerService.getMultiplePodSummaries(viewablePodIds);
    res.json(podSummaries);
  } catch (error) {
    console.error('Error fetching pod summaries:', error);
    res.status(500).json({ error: 'Failed to fetch pod summaries' });
  }
});

router.post('/pod/:podId/refresh', summariesTriggerRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    // Refresh both reads pod content (the generated summary is returned
    // in the response) and burns LLM budget — gate it exactly like the
    // GET /pod/:podId read above.
    const pod = await Pod.findById(podId).select('_id members type').lean();
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    const callerId = req.userId || req.user?.id;
    if (!(await DMService.canViewPod(callerId, pod))) return res.status(403).json({ error: 'Not authorized to refresh this pod summary' });
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

router.get('/daily-digest', summariesReadRateLimit, auth, async (req: AuthReq, res: Res) => {
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

router.post('/daily-digest/generate', summariesTriggerRateLimit, auth, async (req: AuthReq, res: Res) => {
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

router.get('/daily-digest/history', summariesReadRateLimit, auth, async (req: AuthReq, res: Res) => {
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

router.post('/daily-digest/trigger-all', summariesTriggerRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    // Fans out digest generation (and LLM calls) for every user — admin-only.
    if (!(await isGlobalAdminUser(req.user?.id || req.userId))) return res.status(403).json({ error: 'Global admin access required' });
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

export {};
