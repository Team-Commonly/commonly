// ESM import so CodeQL recognises the limiter on this database-backed read
// route; it runs before auth and the recap aggregation.
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';

// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const Activity = require('../models/Activity');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const ActivityService = require('../services/activityService');
// eslint-disable-next-line global-require
const getAuthenticatedUserId = require('../utils/getAuthenticatedUserId');

interface Req {
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

// Activity queries and actions fan out to multiple projections. Sixty per
// minute leaves room for normal use without an unbounded hot loop.
const activityRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: Request) => cloudflareIpRateLimitKeyGenerator(req),
  handler: (_req: unknown, res: Res) => res.status(429).json({ code: 'rate_limited' }),
});

router.use(activityRateLimit);

router.get('/feed', auth, async (req: Req, res: Res) => {
  try {
    const { limit = '20', before, filter, mode = 'updates' } = req.query || {};
    const userId = getAuthenticatedUserId(req);
    const result = await ActivityService.getUserFeed(userId, { limit: parseInt(limit, 10), before, filter, mode });
    res.json(result);
  } catch (error) {
    console.error('Error fetching activity feed:', error);
    res.status(500).json({ error: 'Failed to fetch activity feed' });
  }
});

router.get('/recap', auth, async (req: Req, res: Res) => {
  try {
    const window = req.query?.window;
    const podId = req.query?.podId;
    if (window !== undefined && window !== 'today' && window !== '7d') {
      return res.status(400).json({ error: 'window must be today or 7d' });
    }
    if (podId !== undefined && typeof podId !== 'string') {
      return res.status(400).json({ error: 'podId must be a string' });
    }
    const userId = getAuthenticatedUserId(req);
    const result = await ActivityService.getRecap(userId, {
      window: window === '7d' ? '7d' : 'today',
      podId,
    });
    return res.json(result);
  } catch (error) {
    const e = error as { message?: string };
    if (e.message === 'Access denied') return res.status(403).json({ error: 'Access denied' });
    console.error('Error fetching activity recap:', error);
    return res.status(500).json({ error: 'Failed to fetch activity recap' });
  }
});

router.get('/pods/:podId', auth, async (req: Req, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { limit = '20', before, filter, mode = 'updates' } = req.query || {};
    const userId = getAuthenticatedUserId(req);
    const result = await ActivityService.getPodFeed(podId, userId, { limit: parseInt(limit, 10), before, filter, mode });
    res.json(result);
  } catch (error) {
    const e = error as { message?: string };
    console.error('Error fetching pod activity:', error);
    if (e.message === 'Access denied') return res.status(403).json({ error: 'Access denied' });
    res.status(500).json({ error: 'Failed to fetch pod activity' });
  }
});

router.get('/approvals', auth, async (req: Req, res: Res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const approvals = await ActivityService.getPendingApprovals(userId) as Array<{
      _id: { toString: () => string };
      content?: string;
      agentMetadata?: { agentName?: string };
      approval?: { requestedScopes?: unknown[] };
      podId?: { toString: () => string };
      createdAt?: Date;
    }>;
    res.json({ approvals: approvals.map((a) => ({ id: a._id.toString(), content: a.content, agentName: a.agentMetadata?.agentName, scopes: a.approval?.requestedScopes || [], podId: a.podId?.toString(), createdAt: a.createdAt })), count: approvals.length });
  } catch (error) {
    console.error('Error fetching approvals:', error);
    res.status(500).json({ error: 'Failed to fetch approvals' });
  }
});

router.get('/unread-count', auth, async (req: Req, res: Res) => {
  try {
    const { filter, mode = 'updates' } = req.query || {};
    const userId = getAuthenticatedUserId(req);
    const result = await ActivityService.getUnreadCount(userId, { filter, mode });
    res.json(result);
  } catch (error) {
    console.error('Error fetching unread activity count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

router.post('/mark-read', auth, async (req: Req, res: Res) => {
  try {
    const { activityId, all = false } = (req.body || {}) as { activityId?: string; all?: boolean };
    const userId = getAuthenticatedUserId(req);
    if (!all && !activityId) return res.status(400).json({ error: 'activityId is required when all=false' });
    const result = await ActivityService.markRead(userId, { activityId: activityId ? String(activityId) : null, all: Boolean(all) });
    if (!(result as { success?: boolean }).success) return res.status(400).json({ error: (result as { error?: string }).error || 'Failed to mark read' });
    return res.json(result);
  } catch (error) {
    console.error('Error marking activity as read:', error);
    return res.status(500).json({ error: 'Failed to mark activity as read' });
  }
});

router.post('/:activityId/acknowledge', auth, async (req: Req, res: Res) => {
  try {
    const { activityId } = req.params || {};
    const userId = getAuthenticatedUserId(req);
    const result = await ActivityService.acknowledgeMention(userId, String(activityId)) as { success?: boolean; error?: string };
    if (!result.success) return res.status(400).json({ error: result.error || 'Failed to acknowledge mention' });
    return res.json(result);
  } catch (error) {
    console.error('Error acknowledging activity mention:', error);
    return res.status(500).json({ error: 'Failed to acknowledge mention' });
  }
});

router.post('/:activityId/like', auth, async (req: Req, res: Res) => {
  try {
    const { activityId } = req.params || {};
    const userId = getAuthenticatedUserId(req);
    const result = await ActivityService.toggleLike(activityId, userId);
    res.json(result);
  } catch (error) {
    console.error('Error liking activity:', error);
    res.status(500).json({ error: 'Failed to like activity' });
  }
});

router.post('/:activityId/reply', auth, async (req: Req, res: Res) => {
  try {
    const { activityId } = req.params || {};
    const { content } = (req.body || {}) as { content?: string };
    const userId = getAuthenticatedUserId(req);
    if (!content) return res.status(400).json({ error: 'Content is required' });
    const result = await ActivityService.addReply(activityId, userId, content);
    return res.json(result);
  } catch (error) {
    console.error('Error replying to activity:', error);
    return res.status(500).json({ error: 'Failed to reply' });
  }
});

router.post('/:activityId/approve', auth, async (req: Req, res: Res) => {
  try {
    const { activityId } = req.params || {};
    const { notes } = (req.body || {}) as { notes?: string };
    const userId = getAuthenticatedUserId(req);
    const result = await ActivityService.approveActivity(activityId, userId, notes) as { success?: boolean; error?: string };
    if (!result.success) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (error) {
    console.error('Error approving activity:', error);
    return res.status(500).json({ error: 'Failed to approve' });
  }
});

router.post('/:activityId/reject', auth, async (req: Req, res: Res) => {
  try {
    const { activityId } = req.params || {};
    const { notes } = (req.body || {}) as { notes?: string };
    const userId = getAuthenticatedUserId(req);
    const result = await ActivityService.rejectActivity(activityId, userId, notes) as { success?: boolean; error?: string };
    if (!result.success) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (error) {
    console.error('Error rejecting activity:', error);
    return res.status(500).json({ error: 'Failed to reject' });
  }
});

router.post('/seed/:podId', auth, async (req: Req, res: Res) => {
  try {
    const { podId } = req.params || {};
    const userId = getAuthenticatedUserId(req);
    const result = await ActivityService.seedPodActivities(podId, userId) as { success?: boolean; error?: string };
    if (!result.success) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (error) {
    console.error('Error seeding activities:', error);
    return res.status(500).json({ error: 'Failed to seed activities' });
  }
});

router.post('/create', auth, async (req: Req, res: Res) => {
  try {
    const { type, action, content, podId, target, agentMetadata } = (req.body || {}) as Record<string, unknown>;
    const userId = getAuthenticatedUserId(req);
    if (!type || !action || !podId) return res.status(400).json({ error: 'type, action, and podId are required' });
    const user = await User.findById(userId).select('username').lean() as { username?: string } | null;
    const activity = await Activity.create({ type, actor: { id: userId, name: user?.username || 'Unknown', type: ActivityService.isAgentUsername(user?.username) ? 'agent' : 'human', verified: false }, action, content, podId, target, agentMetadata });
    return res.json({ success: true, activity: { id: activity._id.toString(), type: activity.type, action: activity.action, content: activity.content, createdAt: activity.createdAt } });
  } catch (error) {
    console.error('Error creating activity:', error);
    return res.status(500).json({ error: 'Failed to create activity' });
  }
});

module.exports = router;

export {};
