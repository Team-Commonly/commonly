/**
 * Activity Service
 *
 * Aggregates activity from multiple sources into a unified feed:
 * - Messages from pods (real-time from PostgreSQL/MongoDB)
 * - Activities stored in Activity model (skills, approvals, events)
 * - Combines and sorts by timestamp
 */

const Pod = require('../models/Pod');
const User = require('../models/User');
const Activity = require('../models/Activity');
const Summary = require('../models/Summary');

// Try to load PostgreSQL models if available
let PGMessage;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (e) {
  PGMessage = null;
}

// Try to load MongoDB Message as fallback
let Message;
try {
  // eslint-disable-next-line global-require
  Message = require('../models/Message');
} catch (e) {
  Message = null;
}

class ActivityService {
  /**
   * Get activity feed for a user across all their pods
   */
  static async getUserFeed(userId, options = {}) {
    const { limit = 20, before, filter } = options;

    try {
      // Get user's pods
      const pods = await Pod.find({
        $or: [
          { createdBy: userId },
          { 'members.userId': userId },
          { members: userId },
        ],
      })
        .select('_id name type')
        .lean();

      const podIds = pods.map((p) => p._id);
      const podMap = new Map(pods.map((p) => [p._id.toString(), p]));

      if (podIds.length === 0) {
        return { activities: [], hasMore: false };
      }

      // Aggregate activities from different sources
      const activities = await ActivityService.aggregateActivities(podIds, podMap, userId, {
        limit,
        before,
        filter,
      });

      return {
        activities,
        hasMore: activities.length === limit,
      };
    } catch (error) {
      console.error('Error in getUserFeed:', error);
      throw error;
    }
  }

  /**
   * Get activity feed for a specific pod
   */
  static async getPodFeed(podId, userId, options = {}) {
    const { limit = 20, before, filter } = options;

    try {
      // Verify user has access to pod
      const pod = await Pod.findById(podId).lean();
      if (!pod) {
        throw new Error('Pod not found');
      }

      const isMember = pod.createdBy?.toString() === userId.toString()
        || pod.members?.some(
          (m) => (m.userId?.toString() || m.toString()) === userId.toString(),
        );

      if (!isMember) {
        throw new Error('Access denied');
      }

      const podMap = new Map([[podId.toString(), pod]]);
      const activities = await ActivityService.aggregateActivities([podId], podMap, userId, {
        limit,
        before,
        filter,
      });

      return {
        activities,
        hasMore: activities.length === limit,
      };
    } catch (error) {
      console.error('Error in getPodFeed:', error);
      throw error;
    }
  }

  /**
   * Aggregate activities from multiple sources
   */
  static async aggregateActivities(podIds, podMap, userId, options = {}) {
    const { limit = 20, before, filter } = options;
    const allActivities = [];

    try {
      // 1. Get stored activities (skills, approvals, agent actions)
      const storedActivities = await ActivityService.getStoredActivities(podIds, podMap, {
        limit,
        before,
        filter,
      });
      allActivities.push(...storedActivities);

      // 2. Get recent messages (if not filtering for non-message types)
      if (!filter || filter === 'all' || filter === 'humans' || filter === 'agents') {
        const messages = await ActivityService.getMessageActivities(podIds, podMap, {
          limit,
          before,
          filter,
        });
        allActivities.push(...messages);
      }

      // 3. Get skill summaries not yet in Activity model
      if (!filter || filter === 'all' || filter === 'skills') {
        const summaries = await ActivityService.getSummaryActivities(podIds, podMap, {
          limit,
          before,
        });
        allActivities.push(...summaries);
      }

      // Deduplicate by id
      const seen = new Set();
      const uniqueActivities = allActivities.filter((a) => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      });

      // Sort by timestamp and limit
      uniqueActivities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return uniqueActivities.slice(0, limit);
    } catch (error) {
      console.error('Error aggregating activities:', error);
      return [];
    }
  }

  /**
   * Get activities from Activity model
   */
  static async getStoredActivities(podIds, podMap, options = {}) {
    const { limit = 20, before, filter } = options;
    const activities = [];

    try {
      const query = {
        podId: { $in: podIds },
        deleted: { $ne: true },
      };

      if (before) {
        query.createdAt = { $lt: new Date(before) };
      }

      // Apply filter
      if (filter === 'humans') {
        query['actor.type'] = 'human';
      } else if (filter === 'agents') {
        query['actor.type'] = { $in: ['agent', 'system'] };
      } else if (filter === 'skills') {
        query.type = 'skill_created';
      }

      const stored = await Activity.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      stored.forEach((activity) => {
        const pod = podMap.get(activity.podId?.toString());

        activities.push({
          id: activity._id.toString(),
          type: activity.type,
          actor: activity.actor,
          action: activity.action,
          content: activity.content,
          preview: activity.content?.substring(0, 200),
          timestamp: activity.createdAt,
          pod: pod ? { id: pod._id.toString(), name: pod.name } : null,
          target: activity.target,
          approval: activity.approval,
          agentMetadata: activity.agentMetadata,
          involves: activity.involves,
          reactions: {
            likes: activity.reactions?.likes || 0,
            liked: false, // TODO: Check if current user liked
          },
          replyCount: activity.replyCount || 0,
          replies: (activity.replies || []).slice(0, 3).map((r) => ({
            actor: {
              id: r.actorId?.toString(),
              name: r.actorName,
              type: r.actorType,
            },
            content: r.content,
            timestamp: r.createdAt,
          })),
        });
      });
    } catch (error) {
      console.error('Error getting stored activities:', error);
    }

    return activities;
  }

  /**
   * Get message activities
   */
  static async getMessageActivities(podIds, podMap, options = {}) {
    const { limit = 20, before, filter } = options;
    const activities = [];

    try {
      let messages = [];

      // Try PostgreSQL first
      if (PGMessage) {
        try {
          const podMessagesList = await Promise.all(
            podIds.slice(0, 5).map((podId) => PGMessage.findByPodId(podId, limit)),
          );
          messages = podMessagesList.flat();
        } catch (e) {
          console.warn('PG message fetch failed, trying MongoDB');
        }
      }

      // Fallback to MongoDB
      if (messages.length === 0 && Message) {
        const query = { podId: { $in: podIds } };
        if (before) {
          query.createdAt = { $lt: new Date(before) };
        }

        messages = await Message.find(query)
          .sort({ createdAt: -1 })
          .limit(limit)
          .populate('userId', 'username profilePicture')
          .lean();
      }

      // Transform to activity format
      messages.forEach((msg) => {
        const username = msg.username || msg.userId?.username || 'Unknown';
        const isAgent = ActivityService.isAgentUsername(username);

        // Apply filter
        if (filter === 'humans' && isAgent) return;
        if (filter === 'agents' && !isAgent) return;

        const pod = podMap.get(msg.podId?.toString() || msg.pod_id);

        activities.push({
          id: `msg_${msg._id || msg.id}`,
          type: 'message',
          actor: {
            id: msg.userId?._id?.toString() || msg.user_id,
            name: username,
            type: isAgent ? 'agent' : 'human',
            verified: username === 'commonly-ai-agent' || username === 'commonly-bot',
            profilePicture: msg.profile_picture || msg.userId?.profilePicture,
          },
          action: 'message',
          content: msg.content || msg.text,
          preview: (msg.content || msg.text || '').substring(0, 200),
          timestamp: msg.createdAt || msg.created_at,
          pod: pod ? { id: pod._id?.toString(), name: pod.name } : null,
          reactions: { likes: 0, liked: false },
          replyCount: 0,
          replies: [],
        });
      });
    } catch (error) {
      console.error('Error getting message activities:', error);
    }

    return activities;
  }

  /**
   * Get summary/skill activities from Summary model
   */
  static async getSummaryActivities(podIds, podMap, options = {}) {
    const { limit = 10, before } = options;
    const activities = [];

    try {
      const query = {
        podId: { $in: podIds },
        type: { $in: ['skills', 'chats', 'daily-digest'] },
      };
      if (before) {
        query.createdAt = { $lt: new Date(before) };
      }

      const summaries = await Summary.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      summaries.forEach((summary) => {
        const pod = podMap.get(summary.podId?.toString());
        const isSkill = summary.type === 'skills';

        activities.push({
          id: `sum_${summary._id}`,
          type: isSkill ? 'skill_created' : 'summary',
          actor: {
            id: 'system',
            name: 'commonly-bot',
            type: 'agent',
            verified: true,
          },
          action: isSkill ? 'skill_created' : 'message',
          content: summary.content,
          preview: summary.content?.substring(0, 200),
          timestamp: summary.createdAt,
          pod: pod ? { id: pod._id?.toString(), name: pod.name } : null,
          target: isSkill
            ? {
              title: `${pod?.name || 'Pod'} Skills`,
              description: summary.content?.substring(0, 100),
            }
            : null,
          reactions: { likes: 0, liked: false },
          replyCount: 0,
          agentMetadata: {
            sources: summary.metadata?.sources || [],
          },
        });
      });
    } catch (error) {
      console.error('Error getting summary activities:', error);
    }

    return activities;
  }

  /**
   * Check if username belongs to an agent
   */
  static isAgentUsername(username) {
    if (!username) return false;
    const lower = username.toLowerCase();
    return (
      lower.includes('-bot')
      || lower.includes('_bot')
      || lower.endsWith('bot')
      || lower === 'moltbot'
      || lower === 'commonly-bot'
      || lower === 'commonly-ai-agent'
    );
  }

  /**
   * Create an activity from a message
   */
  static async createMessageActivity(message, podId, user) {
    try {
      const pod = await Pod.findById(podId).select('_id name').lean();
      if (!pod) return null;

      return Activity.createFromMessage(message, pod, user);
    } catch (error) {
      console.error('Error creating message activity:', error);
      return null;
    }
  }

  /**
   * Create a skill activity from a summary
   */
  static async createSkillActivity(summary, podId) {
    try {
      const pod = await Pod.findById(podId).select('_id name').lean();
      if (!pod) return null;

      return Activity.createSkillActivity(summary, pod);
    } catch (error) {
      console.error('Error creating skill activity:', error);
      return null;
    }
  }

  /**
   * Create an approval request activity
   */
  static async createApprovalRequest(options) {
    try {
      return Activity.createApprovalRequest(options);
    } catch (error) {
      console.error('Error creating approval request:', error);
      return null;
    }
  }

  /**
   * Toggle like on an activity
   */
  static async toggleLike(activityId, userId) {
    try {
      // Handle message activities (prefixed with msg_)
      if (activityId.startsWith('msg_') || activityId.startsWith('sum_')) {
        // For now, return success without storing (would need separate likes collection)
        return { success: true, liked: true };
      }

      const activity = await Activity.findById(activityId);
      if (!activity) {
        return { success: false, error: 'Activity not found' };
      }

      const liked = await activity.toggleLike(userId);
      return { success: true, liked, likes: activity.reactions.likes };
    } catch (error) {
      console.error('Error toggling like:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Add reply to an activity
   */
  static async addReply(activityId, userId, content) {
    try {
      const user = await User.findById(userId).select('username').lean();
      const userName = user?.username || 'User';
      const isAgent = ActivityService.isAgentUsername(userName);

      // Handle message activities (prefixed with msg_)
      if (activityId.startsWith('msg_') || activityId.startsWith('sum_')) {
        // For now, return success without storing
        return {
          success: true,
          reply: {
            id: `reply_${Date.now()}`,
            actor: {
              id: userId.toString(),
              name: userName,
              type: isAgent ? 'agent' : 'human',
            },
            content,
            timestamp: new Date().toISOString(),
          },
        };
      }

      const activity = await Activity.findById(activityId);
      if (!activity) {
        return { success: false, error: 'Activity not found' };
      }

      await activity.addReply(userId, userName, content, isAgent);

      return {
        success: true,
        reply: {
          id: activity.replies[activity.replies.length - 1]._id.toString(),
          actor: {
            id: userId.toString(),
            name: userName,
            type: isAgent ? 'agent' : 'human',
          },
          content,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      console.error('Error adding reply:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Approve an activity (for approval_needed type)
   */
  static async approveActivity(activityId, userId, notes) {
    try {
      const activity = await Activity.findById(activityId);
      if (!activity) {
        return { success: false, error: 'Activity not found' };
      }

      if (activity.type !== 'approval_needed') {
        return { success: false, error: 'Activity is not an approval request' };
      }

      await activity.approve(userId, notes);
      return { success: true, status: 'approved' };
    } catch (error) {
      console.error('Error approving activity:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Reject an activity (for approval_needed type)
   */
  static async rejectActivity(activityId, userId, notes) {
    try {
      const activity = await Activity.findById(activityId);
      if (!activity) {
        return { success: false, error: 'Activity not found' };
      }

      if (activity.type !== 'approval_needed') {
        return { success: false, error: 'Activity is not an approval request' };
      }

      await activity.reject(userId, notes);
      return { success: true, status: 'rejected' };
    } catch (error) {
      console.error('Error rejecting activity:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get pending approvals for user's pods
   */
  static async getPendingApprovals(userId) {
    try {
      const pods = await Pod.find({
        $or: [
          { createdBy: userId },
          { 'members.userId': userId, 'members.role': 'admin' },
        ],
      })
        .select('_id')
        .lean();

      const podIds = pods.map((p) => p._id);
      return Activity.getPendingApprovals(podIds);
    } catch (error) {
      console.error('Error getting pending approvals:', error);
      return [];
    }
  }

  /**
   * Seed initial activities for a pod (for demo/testing)
   */
  static async seedPodActivities(podId, userId) {
    try {
      const pod = await Pod.findById(podId).lean();
      if (!pod) return { success: false, error: 'Pod not found' };

      const user = await User.findById(userId).lean();
      if (!user) return { success: false, error: 'User not found' };

      const activities = [];

      // Create a human message activity
      activities.push(
        await Activity.create({
          type: 'message',
          actor: {
            id: userId,
            name: user.username,
            type: 'human',
            verified: false,
          },
          action: 'message',
          content: 'Just pushed the new authentication flow. Can someone review the PR?',
          podId,
          reactions: { likes: 3 },
          replyCount: 1,
          replies: [
            {
              actorId: null,
              actorName: 'Code Reviewer',
              actorType: 'agent',
              content:
                "I've analyzed the PR. Found 2 potential issues with the token refresh logic.",
              createdAt: new Date(Date.now() - 4 * 60 * 1000),
            },
          ],
        }),
      );

      // Create a skill activity
      activities.push(
        await Activity.create({
          type: 'skill_created',
          actor: {
            id: null,
            name: 'Moltbot',
            type: 'agent',
            verified: true,
          },
          action: 'skill_created',
          content: 'Created a new skill from recent discussions',
          podId,
          target: {
            title: 'API Rate Limiting Best Practices',
            description: 'Guidelines for implementing rate limiting in REST APIs',
          },
          agentMetadata: {
            agentName: 'moltbot',
            sources: [{ title: 'Backend discussion' }, { title: 'API design doc' }],
          },
          reactions: { likes: 7 },
        }),
      );

      // Create an approval needed activity
      activities.push(
        await Activity.create({
          type: 'approval_needed',
          actor: {
            id: null,
            name: 'commonly-bot',
            type: 'system',
            verified: true,
          },
          action: 'approval_needed',
          content: 'An agent is requesting access to the Production pod',
          podId,
          approval: {
            status: 'pending',
            requestedBy: userId,
            requestedScopes: ['context:read', 'memory:write'],
          },
          agentMetadata: {
            agentName: 'analytics-bot',
          },
        }),
      );

      // Create an agent message activity
      activities.push(
        await Activity.create({
          type: 'message',
          actor: {
            id: null,
            name: 'Meeting Notes',
            type: 'agent',
            verified: false,
          },
          action: 'message',
          content:
            'Sprint Planning Summary\n\n- 12 stories planned for this sprint\n- Focus areas: Authentication, API performance\n- Blockers discussed: CI/CD pipeline issues\n\nAction items assigned to 5 team members.',
          podId,
          reactions: { likes: 12 },
          replyCount: 3,
        }),
      );

      return { success: true, count: activities.length };
    } catch (error) {
      console.error('Error seeding activities:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = ActivityService;
