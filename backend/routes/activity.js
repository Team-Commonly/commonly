/**
 * Activity Routes
 *
 * API for fetching unified activity feed across pods.
 */

const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const Activity = require('../models/Activity');
const User = require('../models/User');
const ActivityService = require('../services/activityService');

/**
 * GET /api/activity/feed
 * Get activity feed for current user across all their pods
 */
router.get('/feed', auth, async (req, res) => {
  try {
    const {
      limit = 20, before, filter, mode = 'updates',
    } = req.query;
    const userId = req.userId || req.user?.id;

    const result = await ActivityService.getUserFeed(userId, {
      limit: parseInt(limit, 10),
      before,
      filter,
      mode,
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching activity feed:', error);
    res.status(500).json({ error: 'Failed to fetch activity feed' });
  }
});

/**
 * GET /api/activity/pods/:podId
 * Get activity feed for a specific pod
 */
router.get('/pods/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const {
      limit = 20, before, filter, mode = 'updates',
    } = req.query;
    const userId = req.userId || req.user?.id;

    const result = await ActivityService.getPodFeed(podId, userId, {
      limit: parseInt(limit, 10),
      before,
      filter,
      mode,
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching pod activity:', error);
    if (error.message === 'Access denied') {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.status(500).json({ error: 'Failed to fetch pod activity' });
  }
});

/**
 * GET /api/activity/approvals
 * Get pending approval requests for user's admin pods
 */
router.get('/approvals', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.id;
    const approvals = await ActivityService.getPendingApprovals(userId);

    res.json({
      approvals: approvals.map((a) => ({
        id: a._id.toString(),
        content: a.content,
        agentName: a.agentMetadata?.agentName,
        scopes: a.approval?.requestedScopes || [],
        podId: a.podId?.toString(),
        createdAt: a.createdAt,
      })),
      count: approvals.length,
    });
  } catch (error) {
    console.error('Error fetching approvals:', error);
    res.status(500).json({ error: 'Failed to fetch approvals' });
  }
});

/**
 * GET /api/activity/unread-count
 * Get unread activity count for current user
 */
router.get('/unread-count', auth, async (req, res) => {
  try {
    const {
      filter, mode = 'updates',
    } = req.query;
    const userId = req.userId || req.user?.id;
    const result = await ActivityService.getUnreadCount(userId, { filter, mode });
    res.json(result);
  } catch (error) {
    console.error('Error fetching unread activity count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

/**
 * POST /api/activity/mark-read
 * Mark one activity as read or all current activities as read
 */
router.post('/mark-read', auth, async (req, res) => {
  try {
    const { activityId, all = false } = req.body || {};
    const userId = req.userId || req.user?.id;
    if (!all && !activityId) {
      return res.status(400).json({ error: 'activityId is required when all=false' });
    }
    const result = await ActivityService.markRead(userId, {
      activityId: activityId ? String(activityId) : null,
      all: Boolean(all),
    });
    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to mark read' });
    }
    return res.json(result);
  } catch (error) {
    console.error('Error marking activity as read:', error);
    return res.status(500).json({ error: 'Failed to mark activity as read' });
  }
});

/**
 * POST /api/activity/:activityId/like
 * Like an activity
 */
router.post('/:activityId/like', auth, async (req, res) => {
  try {
    const { activityId } = req.params;
    const userId = req.userId || req.user?.id;

    const result = await ActivityService.toggleLike(activityId, userId);
    res.json(result);
  } catch (error) {
    console.error('Error liking activity:', error);
    res.status(500).json({ error: 'Failed to like activity' });
  }
});

/**
 * POST /api/activity/:activityId/reply
 * Reply to an activity
 */
router.post('/:activityId/reply', auth, async (req, res) => {
  try {
    const { activityId } = req.params;
    const { content } = req.body;
    const userId = req.userId || req.user?.id;

    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const result = await ActivityService.addReply(activityId, userId, content);
    res.json(result);
  } catch (error) {
    console.error('Error replying to activity:', error);
    res.status(500).json({ error: 'Failed to reply' });
  }
});

/**
 * POST /api/activity/:activityId/approve
 * Approve an approval request
 */
router.post('/:activityId/approve', auth, async (req, res) => {
  try {
    const { activityId } = req.params;
    const { notes } = req.body;
    const userId = req.userId || req.user?.id;

    const result = await ActivityService.approveActivity(activityId, userId, notes);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (error) {
    console.error('Error approving activity:', error);
    res.status(500).json({ error: 'Failed to approve' });
  }
});

/**
 * POST /api/activity/:activityId/reject
 * Reject an approval request
 */
router.post('/:activityId/reject', auth, async (req, res) => {
  try {
    const { activityId } = req.params;
    const { notes } = req.body;
    const userId = req.userId || req.user?.id;

    const result = await ActivityService.rejectActivity(activityId, userId, notes);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (error) {
    console.error('Error rejecting activity:', error);
    res.status(500).json({ error: 'Failed to reject' });
  }
});

/**
 * POST /api/activity/seed/:podId
 * Seed demo activities for a pod (development only)
 */
router.post('/seed/:podId', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const userId = req.userId || req.user?.id;

    const result = await ActivityService.seedPodActivities(podId, userId);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (error) {
    console.error('Error seeding activities:', error);
    res.status(500).json({ error: 'Failed to seed activities' });
  }
});

/**
 * POST /api/activity/create
 * Create a new activity (for agents and system events)
 */
router.post('/create', auth, async (req, res) => {
  try {
    const {
      type, action, content, podId, target, agentMetadata,
    } = req.body;
    const userId = req.userId || req.user?.id;

    if (!type || !action || !podId) {
      return res.status(400).json({ error: 'type, action, and podId are required' });
    }

    const user = await User.findById(userId).select('username').lean();

    const activity = await Activity.create({
      type,
      actor: {
        id: userId,
        name: user?.username || 'Unknown',
        type: ActivityService.isAgentUsername(user?.username) ? 'agent' : 'human',
        verified: false,
      },
      action,
      content,
      podId,
      target,
      agentMetadata,
    });

    res.json({
      success: true,
      activity: {
        id: activity._id.toString(),
        type: activity.type,
        action: activity.action,
        content: activity.content,
        createdAt: activity.createdAt,
      },
    });
  } catch (error) {
    console.error('Error creating activity:', error);
    res.status(500).json({ error: 'Failed to create activity' });
  }
});

module.exports = router;
