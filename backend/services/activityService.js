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
const Post = require('../models/Post');

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
    const {
      limit = 20, before, filter, mode = 'updates',
    } = options;

    try {
      const user = await User.findById(userId)
        .select('_id username following followers followedThreads')
        .lean();
      if (!user) {
        return { activities: [], hasMore: false, quick: null };
      }

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

      // Aggregate activities from different sources
      const activities = await ActivityService.aggregateActivities(podIds, podMap, user, {
        limit,
        before,
        filter,
        mode,
      });
      const readState = user.activityFeed || {};
      const withReadState = ActivityService.annotateReadState(activities, readState);

      const quick = await ActivityService.getQuickOverview(user, pods);

      return {
        activities: withReadState,
        hasMore: withReadState.length === limit,
        quick,
        unreadCount: withReadState.filter((item) => !item.read).length,
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
    const {
      limit = 20, before, filter, mode = 'updates',
    } = options;

    try {
      const user = await User.findById(userId)
        .select('_id username following followers followedThreads')
        .lean();
      if (!user) {
        throw new Error('Access denied');
      }

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
      const activities = await ActivityService.aggregateActivities([podId], podMap, user, {
        limit,
        before,
        filter,
        mode,
      });
      const withReadState = ActivityService.annotateReadState(activities, user.activityFeed || {});

      return {
        activities: withReadState,
        hasMore: withReadState.length === limit,
      };
    } catch (error) {
      console.error('Error in getPodFeed:', error);
      throw error;
    }
  }

  /**
   * Aggregate activities from multiple sources
   */
  static async aggregateActivities(podIds, podMap, user, options = {}) {
    const {
      limit = 20, before, filter, mode = 'updates',
    } = options;
    const allActivities = [];

    try {
      const followingIds = new Set((user.following || []).map((id) => id.toString()));
      const username = user.username || '';

      // 1. Get stored activities (skills, approvals, agent actions)
      const storedActivities = await ActivityService.getStoredActivities(podIds, podMap, user, {
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
          username,
          followingIds,
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

      // 4. Get followed thread updates
      if (!filter || ['all', 'threads', 'following', 'mentions'].includes(filter)) {
        const threadUpdates = await ActivityService.getFollowedThreadActivities(user, {
          limit,
          before,
          podMap,
          followingIds,
          username,
        });
        allActivities.push(...threadUpdates);
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
      const filtered = uniqueActivities.filter((activity) => ActivityService.matchesModeAndFilter(activity, {
        mode,
        filter,
      }));

      return filtered.slice(0, limit);
    } catch (error) {
      console.error('Error aggregating activities:', error);
      return [];
    }
  }

  /**
   * Get activities from Activity model
   */
  static async getStoredActivities(podIds, podMap, user, options = {}) {
    const { limit = 20, before, filter } = options;
    const activities = [];

    try {
      const query = { deleted: { $ne: true } };
      const scopeFilters = [];
      if (podIds.length > 0) {
        scopeFilters.push({ podId: { $in: podIds } });
      }
      scopeFilters.push({
        visibility: 'private',
        $or: [
          { 'actor.id': user._id },
          { 'involves.id': user._id },
        ],
      });
      query.$or = scopeFilters;

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
          flags: ActivityService.computeFlags({
            actor: activity.actor,
            type: activity.type,
            action: activity.action,
            content: activity.content,
            target: activity.target,
            username: user.username,
            followingIds: new Set((user.following || []).map((id) => id.toString())),
          }),
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
    const {
      limit = 20, before, filter, username, followingIds = new Set(),
    } = options;
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
        const authorName = msg.username || msg.userId?.username || 'Unknown';
        const isAgent = ActivityService.isAgentUsername(authorName);

        // Apply filter
        if (filter === 'humans' && isAgent) return;
        if (filter === 'agents' && !isAgent) return;

        const pod = podMap.get(msg.podId?.toString() || msg.pod_id);

        activities.push({
          id: `msg_${msg._id || msg.id}`,
          type: 'message',
          actor: {
            id: msg.userId?._id?.toString() || msg.user_id,
            name: authorName,
            type: isAgent ? 'agent' : 'human',
            verified: authorName === 'commonly-ai-agent' || authorName === 'commonly-bot',
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
          flags: ActivityService.computeFlags({
            actor: {
              id: msg.userId?._id?.toString() || msg.user_id,
              type: isAgent ? 'agent' : 'human',
            },
            type: 'message',
            action: 'message',
            content: msg.content || msg.text || '',
            username,
            followingIds,
          }),
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
          flags: {
            isAgentAction: true,
            isMention: false,
            isFollowing: false,
            isThreadUpdate: false,
          },
        });
      });
    } catch (error) {
      console.error('Error getting summary activities:', error);
    }

    return activities;
  }

  static computeFlags({
    actor, type, action, content, target, username, followingIds = new Set(),
  }) {
    const actorId = actor?.id ? String(actor.id) : '';
    const lowerContent = `${content || ''} ${target?.description || ''}`.toLowerCase();
    const lowerUsername = (username || '').toLowerCase();
    const mentionNeedle = lowerUsername ? `@${lowerUsername}` : '';

    return {
      isAgentAction: actor?.type === 'agent' || actor?.type === 'system' || type === 'agent_action',
      isMention: Boolean(mentionNeedle && lowerContent.includes(mentionNeedle)),
      isFollowing: Boolean(actorId && followingIds.has(actorId)),
      isThreadUpdate: action === 'thread_comment' || action === 'thread_followed' || type === 'thread_update',
    };
  }

  static annotateReadState(activities = [], readState = {}) {
    const lastViewedAt = readState?.lastViewedAt ? new Date(readState.lastViewedAt) : new Date(0);
    const readItemIds = new Set((readState?.readItemIds || []).map((id) => String(id)));
    return activities.map((activity) => {
      const activityTime = activity?.timestamp ? new Date(activity.timestamp) : new Date(0);
      const isExplicitlyRead = readItemIds.has(String(activity.id));
      const read = isExplicitlyRead || activityTime <= lastViewedAt;
      return { ...activity, read };
    });
  }

  static async markRead(userId, options = {}) {
    const { activityId = null, all = false } = options;
    const user = await User.findById(userId).select('_id activityFeed');
    if (!user) return { success: false, error: 'User not found' };

    if (!user.activityFeed) {
      user.activityFeed = { lastViewedAt: new Date(0), readItemIds: [] };
    }

    if (all) {
      user.activityFeed.lastViewedAt = new Date();
      user.activityFeed.readItemIds = [];
    } else if (activityId) {
      const next = new Set((user.activityFeed.readItemIds || []).map((id) => String(id)));
      next.add(String(activityId));
      user.activityFeed.readItemIds = Array.from(next).slice(-500);
    }

    await user.save();
    return {
      success: true,
      lastViewedAt: user.activityFeed.lastViewedAt,
      readItemIds: user.activityFeed.readItemIds || [],
    };
  }

  static async getUnreadCount(userId, options = {}) {
    const activitiesResult = await ActivityService.getUserFeed(userId, {
      ...options,
      limit: 100,
    });
    const unreadCount = (activitiesResult.activities || []).filter((item) => !item.read).length;
    return { unreadCount };
  }

  static matchesModeAndFilter(activity, { mode = 'updates', filter = 'all' } = {}) {
    const flags = activity.flags || {};
    const isAgent = flags.isAgentAction || activity.actor?.type === 'agent' || activity.actor?.type === 'system';

    if (mode === 'actions') {
      if (filter === 'agents') return isAgent;
      if (filter === 'humans') return !isAgent;
      if (filter === 'skills') return activity.type === 'skill_created' || activity.type === 'summary';
      return isAgent || activity.type === 'agent_action' || activity.type === 'skill_created';
    }

    if (filter === 'mentions') return flags.isMention;
    if (filter === 'following') return flags.isFollowing || activity.action === 'user_followed';
    if (filter === 'threads') return flags.isThreadUpdate;
    if (filter === 'pods') return Boolean(activity.pod?.id);
    if (filter === 'humans') return !isAgent;
    if (filter === 'agents') return isAgent;
    return true;
  }

  static async getFollowedThreadActivities(user, options = {}) {
    const {
      before, podMap = new Map(), followingIds = new Set(), username, limit = 20,
    } = options;

    const followedThreads = Array.isArray(user.followedThreads) ? user.followedThreads : [];
    if (!followedThreads.length) return [];

    const threadMap = new Map(
      followedThreads.map((thread) => [String(thread.postId), thread.followedAt || new Date(0)]),
    );
    const postIds = Array.from(threadMap.keys());

    const posts = await Post.find({ _id: { $in: postIds } })
      .select('_id podId userId content comments createdAt')
      .populate('userId', 'username profilePicture')
      .populate('podId', 'name type')
      .populate('comments.userId', 'username profilePicture')
      .lean();

    const activities = [];
    posts.forEach((post) => {
      const followedAt = threadMap.get(String(post._id)) || new Date(0);
      const relevantComments = (post.comments || [])
        .filter((comment) => {
          const createdAt = comment.createdAt ? new Date(comment.createdAt) : null;
          if (!createdAt) return false;
          if (before && createdAt >= new Date(before)) return false;
          if (createdAt <= followedAt) return false;
          return String(comment.userId?._id || comment.userId) !== String(user._id);
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      if (!relevantComments.length) return;

      const latest = relevantComments[0];
      const pod = post.podId?._id
        ? { id: String(post.podId._id), name: post.podId.name }
        : podMap.get(String(post.podId));
      const actor = {
        id: latest.userId?._id?.toString() || latest.userId?.toString() || 'unknown',
        name: latest.userId?.username || 'User',
        type: ActivityService.isAgentUsername(latest.userId?.username) ? 'agent' : 'human',
        verified: ActivityService.isAgentUsername(latest.userId?.username),
        profilePicture: latest.userId?.profilePicture,
      };

      activities.push({
        id: `thread_${post._id}_${latest._id || latest.createdAt}`,
        type: 'thread_update',
        actor,
        action: 'thread_comment',
        content: latest.text,
        preview: latest.text?.substring(0, 200),
        timestamp: latest.createdAt,
        pod: pod || null,
        target: {
          title: `Thread update: ${(post.content || '').slice(0, 80)}`,
          description:
            `${relevantComments.length} new repl${relevantComments.length === 1 ? 'y' : 'ies'} `
            + 'since you followed',
          url: `/thread/${post._id}`,
        },
        reactions: { likes: 0, liked: false },
        replyCount: 0,
        replies: [],
        flags: ActivityService.computeFlags({
          actor,
          type: 'thread_update',
          action: 'thread_comment',
          content: latest.text,
          target: { description: post.content },
          username,
          followingIds,
        }),
      });
    });

    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return activities.slice(0, limit);
  }

  static async getQuickOverview(user, pods = []) {
    const recentPods = (pods || [])
      .slice()
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, 6)
      .map((pod) => ({
        id: pod._id.toString(),
        name: pod.name,
        type: pod.type,
        updatedAt: pod.updatedAt || pod.createdAt,
        membersCount: Array.isArray(pod.members) ? pod.members.length : 0,
      }));

    const followedThreads = Array.isArray(user.followedThreads) ? user.followedThreads : [];
    const followedIds = followedThreads.map((thread) => thread.postId).filter(Boolean);
    let followedThreadItems = [];
    if (followedIds.length > 0) {
      const followedAtMap = new Map(
        followedThreads.map((thread) => [String(thread.postId), thread.followedAt || new Date(0)]),
      );
      const posts = await Post.find({ _id: { $in: followedIds } })
        .select('_id content comments createdAt')
        .sort({ createdAt: -1 })
        .lean();

      followedThreadItems = posts.slice(0, 6).map((post) => {
        const followedAt = followedAtMap.get(String(post._id)) || new Date(0);
        const newReplies = (post.comments || []).filter((comment) => (
          comment.createdAt && new Date(comment.createdAt) > followedAt
            && String(comment.userId) !== String(user._id)
        )).length;
        return {
          postId: post._id.toString(),
          preview: (post.content || '').slice(0, 120),
          followedAt,
          newReplies,
          url: `/thread/${post._id}`,
        };
      });
    }

    return {
      social: {
        followers: Array.isArray(user.followers) ? user.followers.length : 0,
        following: Array.isArray(user.following) ? user.following.length : 0,
      },
      recentPods,
      followedThreads: followedThreadItems,
    };
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
            'Sprint Planning Summary\n\n- 12 stories planned for this sprint\n'
            + '- Focus areas: Authentication, API performance\n'
            + '- Blockers discussed: CI/CD pipeline issues\n\n'
            + 'Action items assigned to 5 team members.',
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
