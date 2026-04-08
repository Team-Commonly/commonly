// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Activity = require('../models/Activity');
// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const Post = require('../models/Post');

let PGMessage: unknown = null;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (e) {
  PGMessage = null;
}

let Message: unknown = null;
try {
  // eslint-disable-next-line global-require
  Message = require('../models/Message');
} catch (e) {
  Message = null;
}

interface ActorInfo {
  id?: string | null;
  name?: string;
  type?: string;
  verified?: boolean;
  profilePicture?: string;
}

interface ActivityFlags {
  isAgentAction: boolean;
  isMention: boolean;
  isFollowing: boolean;
  isThreadUpdate: boolean;
}

interface ActivityItem {
  id: string;
  type: string;
  actor: ActorInfo;
  action: string;
  content?: string;
  preview?: string;
  timestamp: Date | string | null;
  pod?: { id: string; name: string } | null;
  target?: { title?: string; description?: string; url?: string } | null;
  approval?: unknown;
  agentMetadata?: { agentName?: string; sources?: unknown[] };
  involves?: unknown;
  reactions: { likes: number; liked: boolean };
  replyCount: number;
  replies: unknown[];
  flags?: ActivityFlags;
  read?: boolean;
}

interface UserDoc {
  _id: unknown;
  username?: string;
  following?: unknown[];
  followers?: unknown[];
  followedThreads?: Array<{ postId: unknown; followedAt?: Date }>;
  activityFeed?: { lastViewedAt?: Date | string; readItemIds?: unknown[] };
}

interface PodDoc {
  _id: unknown;
  name: string;
  type?: string;
  createdBy?: unknown;
  members?: unknown[];
  agentEnsemble?: unknown;
  updatedAt?: Date;
  createdAt?: Date;
}

interface GetFeedOptions {
  limit?: number;
  before?: string;
  filter?: string;
  mode?: string;
}

interface ComputeFlagsOptions {
  actor?: ActorInfo;
  type?: string;
  action?: string;
  content?: string;
  target?: { description?: string };
  username?: string;
  followingIds?: Set<string>;
}

class ActivityService {
  static async getUserFeed(
    userId: unknown,
    options: GetFeedOptions = {},
  ): Promise<Record<string, unknown>> {
    const {
      limit = 20, before, filter, mode = 'updates',
    } = options;

    try {
      const user: UserDoc | null = await User.findById(userId)
        .select('_id username following followers followedThreads')
        .lean();
      if (!user) {
        return { activities: [], hasMore: false, quick: null };
      }

      const pods: PodDoc[] = await Pod.find({
        $or: [
          { createdBy: userId },
          { 'members.userId': userId },
          { members: userId },
        ],
      })
        .select('_id name type')
        .lean();

      const podIds = pods.map((p) => p._id);
      const podMap = new Map(pods.map((p) => [String(p._id), p]));

      const activities = await ActivityService.aggregateActivities(podIds, podMap, user, {
        limit, before, filter, mode,
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

  static async getPodFeed(
    podId: unknown,
    userId: unknown,
    options: GetFeedOptions = {},
  ): Promise<Record<string, unknown>> {
    const {
      limit = 20, before, filter, mode = 'updates',
    } = options;

    try {
      const user: UserDoc | null = await User.findById(userId)
        .select('_id username following followers followedThreads')
        .lean();
      if (!user) {
        throw new Error('Access denied');
      }

      const pod: PodDoc | null = await Pod.findById(podId).lean();
      if (!pod) {
        throw new Error('Pod not found');
      }

      const isMember = String(pod.createdBy) === String(userId)
        || (pod.members as unknown[])?.some(
          (m: unknown) => {
            const member = m as { userId?: unknown };
            return (String(member.userId) || String(m)) === String(userId);
          },
        );

      if (!isMember) {
        throw new Error('Access denied');
      }

      const podMap = new Map([[String(podId), pod]]);
      const activities = await ActivityService.aggregateActivities([podId], podMap, user, {
        limit, before, filter, mode,
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

  static async aggregateActivities(
    podIds: unknown[],
    podMap: Map<string, PodDoc>,
    user: UserDoc,
    options: GetFeedOptions = {},
  ): Promise<ActivityItem[]> {
    const {
      limit = 20, before, filter, mode = 'updates',
    } = options;
    const allActivities: ActivityItem[] = [];

    try {
      const followingIds = new Set((user.following || []).map((id) => String(id)));
      const username = user.username || '';

      const storedActivities = await ActivityService.getStoredActivities(podIds, podMap, user, {
        limit, before, filter,
      });
      allActivities.push(...storedActivities);

      if (!filter || filter === 'all' || filter === 'humans' || filter === 'agents') {
        const messages = await ActivityService.getMessageActivities(podIds, podMap, {
          limit, before, filter, username, followingIds,
        });
        allActivities.push(...messages);
      }

      if (!filter || filter === 'all' || filter === 'skills') {
        const summaries = await ActivityService.getSummaryActivities(podIds, podMap, {
          limit, before,
        });
        allActivities.push(...summaries);
      }

      if (!filter || ['all', 'threads', 'following', 'mentions'].includes(filter)) {
        const threadUpdates = await ActivityService.getFollowedThreadActivities(user, {
          limit, before, podMap, followingIds, username,
        });
        allActivities.push(...threadUpdates);
      }

      const seen = new Set<string>();
      const uniqueActivities = allActivities.filter((a) => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      });

      uniqueActivities.sort(
        (a, b) => new Date(b.timestamp as string).getTime() - new Date(a.timestamp as string).getTime(),
      );
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

  static async getStoredActivities(
    podIds: unknown[],
    podMap: Map<string, PodDoc>,
    user: UserDoc,
    options: GetFeedOptions = {},
  ): Promise<ActivityItem[]> {
    const { limit = 20, before, filter } = options;
    const activities: ActivityItem[] = [];

    try {
      const query: Record<string, unknown> = { deleted: { $ne: true } };
      const scopeFilters: unknown[] = [];
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

      if (filter === 'humans') {
        query['actor.type'] = 'human';
      } else if (filter === 'agents') {
        query['actor.type'] = { $in: ['agent', 'system'] };
      } else if (filter === 'skills') {
        query.type = 'skill_created';
      }

      const stored: Array<Record<string, unknown>> = await Activity.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      stored.forEach((activity) => {
        const pod = podMap.get(String(activity.podId));
        const actor = activity.actor as ActorInfo;
        const followingIds = new Set((user.following || []).map((id) => String(id)));
        const replies = (activity.replies as Array<Record<string, unknown>> || []);

        activities.push({
          id: String(activity._id),
          type: activity.type as string,
          actor,
          action: activity.action as string,
          content: activity.content as string | undefined,
          preview: (activity.content as string | undefined)?.substring(0, 200),
          timestamp: activity.createdAt as Date,
          pod: pod ? { id: String(pod._id), name: pod.name } : null,
          target: activity.target as ActivityItem['target'],
          approval: activity.approval,
          agentMetadata: activity.agentMetadata as ActivityItem['agentMetadata'],
          involves: activity.involves,
          reactions: {
            likes: (activity.reactions as { likes?: number })?.likes || 0,
            liked: false,
          },
          replyCount: (activity.replyCount as number) || 0,
          replies: replies.slice(0, 3).map((r) => ({
            actor: {
              id: String(r.actorId),
              name: r.actorName,
              type: r.actorType,
            },
            content: r.content,
            timestamp: r.createdAt,
          })),
          flags: ActivityService.computeFlags({
            actor,
            type: activity.type as string,
            action: activity.action as string,
            content: activity.content as string,
            target: activity.target as { description?: string },
            username: user.username,
            followingIds,
          }),
        });
      });
    } catch (error) {
      console.error('Error getting stored activities:', error);
    }

    return activities;
  }

  static async getMessageActivities(
    podIds: unknown[],
    podMap: Map<string, PodDoc>,
    options: GetFeedOptions & {
      username?: string;
      followingIds?: Set<string>;
    } = {},
  ): Promise<ActivityItem[]> {
    const {
      limit = 20, before, filter, username = '', followingIds = new Set(),
    } = options;
    const activities: ActivityItem[] = [];

    try {
      let messages: Array<Record<string, unknown>> = [];

      if (PGMessage) {
        try {
          const podMessagesList = await Promise.all(
            podIds.slice(0, 5).map((podId) => (PGMessage as { findByPodId(id: unknown, limit: number): Promise<unknown[]> }).findByPodId(podId, limit)),
          );
          messages = podMessagesList.flat() as Array<Record<string, unknown>>;
        } catch (e) {
          console.warn('PG message fetch failed, trying MongoDB');
        }
      }

      if (messages.length === 0 && Message) {
        const query: Record<string, unknown> = { podId: { $in: podIds } };
        if (before) {
          query.createdAt = { $lt: new Date(before) };
        }

        messages = await (Message as { find(q: unknown): { sort(s: unknown): { limit(n: number): { populate(f: string, s: string): { lean(): Promise<Array<Record<string, unknown>>> } } } } })
          .find(query)
          .sort({ createdAt: -1 })
          .limit(limit)
          .populate('userId', 'username profilePicture')
          .lean();
      }

      messages.forEach((msg) => {
        const userId = msg.userId as Record<string, unknown> | undefined;
        const authorName = (msg.username as string) || (userId?.username as string) || 'Unknown';
        const isAgent = ActivityService.isAgentUsername(authorName);

        if (filter === 'humans' && isAgent) return;
        if (filter === 'agents' && !isAgent) return;

        const pod = podMap.get(String(msg.podId) || String(msg.pod_id));

        activities.push({
          id: `msg_${msg._id || msg.id}`,
          type: 'message',
          actor: {
            id: String(userId?._id || msg.user_id),
            name: authorName,
            type: isAgent ? 'agent' : 'human',
            verified: authorName === 'commonly-ai-agent' || authorName === 'commonly-bot',
            profilePicture: (msg.profile_picture as string) || (userId?.profilePicture as string),
          },
          action: 'message',
          content: (msg.content || msg.text) as string | undefined,
          preview: String(msg.content || msg.text || '').substring(0, 200),
          timestamp: (msg.createdAt || msg.created_at) as Date,
          pod: pod ? { id: String(pod._id), name: pod.name } : null,
          reactions: { likes: 0, liked: false },
          replyCount: 0,
          replies: [],
          flags: ActivityService.computeFlags({
            actor: {
              id: String(userId?._id || msg.user_id),
              type: isAgent ? 'agent' : 'human',
            },
            type: 'message',
            action: 'message',
            content: String(msg.content || msg.text || ''),
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

  static async getSummaryActivities(
    podIds: unknown[],
    podMap: Map<string, PodDoc>,
    options: { limit?: number; before?: string } = {},
  ): Promise<ActivityItem[]> {
    const { limit = 10, before } = options;
    const activities: ActivityItem[] = [];

    try {
      const query: Record<string, unknown> = {
        podId: { $in: podIds },
        type: { $in: ['skills', 'chats', 'daily-digest'] },
      };
      if (before) {
        query.createdAt = { $lt: new Date(before) };
      }

      const summaries: Array<Record<string, unknown>> = await Summary.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      summaries.forEach((summary) => {
        const pod = podMap.get(String(summary.podId));
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
          content: summary.content as string | undefined,
          preview: (summary.content as string | undefined)?.substring(0, 200),
          timestamp: summary.createdAt as Date,
          pod: pod ? { id: String(pod._id), name: pod.name } : null,
          target: isSkill
            ? {
              title: `${pod?.name || 'Pod'} Skills`,
              description: (summary.content as string | undefined)?.substring(0, 100),
            }
            : null,
          reactions: { likes: 0, liked: false },
          replyCount: 0,
          agentMetadata: {
            sources: (summary.metadata as { sources?: unknown[] })?.sources || [],
          },
          replies: [],
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

  static computeFlags(options: ComputeFlagsOptions): ActivityFlags {
    const {
      actor, type, action, content, target, username, followingIds = new Set(),
    } = options;
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

  static annotateReadState(
    activities: ActivityItem[] = [],
    readState: UserDoc['activityFeed'] = {},
  ): ActivityItem[] {
    const lastViewedAt = readState?.lastViewedAt ? new Date(readState.lastViewedAt as string) : new Date(0);
    const readItemIds = new Set((readState?.readItemIds || []).map((id) => String(id)));
    return activities.map((activity) => {
      const activityTime = activity?.timestamp ? new Date(activity.timestamp as string) : new Date(0);
      const isExplicitlyRead = readItemIds.has(String(activity.id));
      const read = isExplicitlyRead || activityTime <= lastViewedAt;
      return { ...activity, read };
    });
  }

  static async markRead(userId: unknown, options: { activityId?: string | null; all?: boolean } = {}): Promise<Record<string, unknown>> {
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
      const next = new Set((user.activityFeed.readItemIds || []).map((id: unknown) => String(id)));
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

  static async getUnreadCount(userId: unknown, options: GetFeedOptions = {}): Promise<{ unreadCount: number }> {
    const activitiesResult = await ActivityService.getUserFeed(userId, {
      ...options,
      limit: 100,
    });
    const unreadCount = (activitiesResult.activities as ActivityItem[] || []).filter((item) => !item.read).length;
    return { unreadCount };
  }

  static matchesModeAndFilter(
    activity: ActivityItem,
    options: { mode?: string; filter?: string } = {},
  ): boolean {
    const { mode = 'updates', filter = 'all' } = options;
    const flags = activity.flags || {} as ActivityFlags;
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

  static async getFollowedThreadActivities(
    user: UserDoc,
    options: {
      before?: string;
      podMap?: Map<string, PodDoc>;
      followingIds?: Set<string>;
      username?: string;
      limit?: number;
    } = {},
  ): Promise<ActivityItem[]> {
    const {
      before, podMap = new Map(), followingIds = new Set(), username, limit = 20,
    } = options;

    const followedThreads = Array.isArray(user.followedThreads) ? user.followedThreads : [];
    if (!followedThreads.length) return [];

    const threadMap = new Map(
      followedThreads.map((thread) => [String(thread.postId), thread.followedAt || new Date(0)]),
    );
    const postIds = Array.from(threadMap.keys());

    const posts: Array<Record<string, unknown>> = await Post.find({ _id: { $in: postIds } })
      .select('_id podId userId content comments createdAt')
      .populate('userId', 'username profilePicture')
      .populate('podId', 'name type')
      .populate('comments.userId', 'username profilePicture')
      .lean();

    const activities: ActivityItem[] = [];
    posts.forEach((post) => {
      const followedAt = threadMap.get(String(post._id)) || new Date(0);
      const comments = post.comments as Array<Record<string, unknown>> || [];

      const relevantComments = comments
        .filter((comment) => {
          const createdAt = comment.createdAt ? new Date(comment.createdAt as string) : null;
          if (!createdAt) return false;
          if (before && createdAt >= new Date(before)) return false;
          if (createdAt <= followedAt) return false;
          const commentUserId = comment.userId as Record<string, unknown> | undefined;
          return String(commentUserId?._id || comment.userId) !== String(user._id);
        })
        .sort((a, b) => new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime());

      if (!relevantComments.length) return;

      const latest = relevantComments[0];
      const postPodId = post.podId as Record<string, unknown> | null;
      const pod: { id: string; name: string } | PodDoc | undefined = postPodId?._id
        ? { id: String(postPodId._id), name: postPodId.name as string }
        : podMap.get(String(post.podId));

      const latestUserId = latest.userId as Record<string, unknown> | undefined;
      const actor: ActorInfo = {
        id: String(latestUserId?._id || latestUserId || 'unknown'),
        name: (latestUserId?.username as string) || 'User',
        type: ActivityService.isAgentUsername(latestUserId?.username as string) ? 'agent' : 'human',
        verified: ActivityService.isAgentUsername(latestUserId?.username as string),
        profilePicture: latestUserId?.profilePicture as string | undefined,
      };

      activities.push({
        id: `thread_${post._id}_${latest._id || latest.createdAt}`,
        type: 'thread_update',
        actor,
        action: 'thread_comment',
        content: latest.text as string | undefined,
        preview: (latest.text as string | undefined)?.substring(0, 200),
        timestamp: latest.createdAt as Date,
        pod: pod ? { id: String((pod as PodDoc)._id || (pod as { id: string }).id), name: (pod as PodDoc).name || (pod as { name: string }).name } : null,
        target: {
          title: `Thread update: ${String(post.content || '').slice(0, 80)}`,
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
          content: latest.text as string,
          target: { description: post.content as string },
          username,
          followingIds,
        }),
      });
    });

    activities.sort(
      (a, b) => new Date(b.timestamp as string).getTime() - new Date(a.timestamp as string).getTime(),
    );
    return activities.slice(0, limit);
  }

  static async getQuickOverview(user: UserDoc, pods: PodDoc[] = []): Promise<Record<string, unknown>> {
    const recentPods = (pods || [])
      .slice()
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())
      .slice(0, 6)
      .map((pod) => ({
        id: String(pod._id),
        name: pod.name,
        type: pod.type,
        updatedAt: pod.updatedAt || pod.createdAt,
        membersCount: Array.isArray(pod.members) ? pod.members.length : 0,
      }));

    const followedThreads = Array.isArray(user.followedThreads) ? user.followedThreads : [];
    const followedIds = followedThreads.map((thread) => thread.postId).filter(Boolean);
    let followedThreadItems: unknown[] = [];
    if (followedIds.length > 0) {
      const followedAtMap = new Map(
        followedThreads.map((thread) => [String(thread.postId), thread.followedAt || new Date(0)]),
      );
      const posts: Array<Record<string, unknown>> = await Post.find({ _id: { $in: followedIds } })
        .select('_id content comments createdAt')
        .sort({ createdAt: -1 })
        .lean();

      followedThreadItems = posts.slice(0, 6).map((post) => {
        const followedAt = followedAtMap.get(String(post._id)) || new Date(0);
        const comments = post.comments as Array<Record<string, unknown>> || [];
        const newReplies = comments.filter((comment) => (
          comment.createdAt && new Date(comment.createdAt as string) > followedAt
          && String(comment.userId) !== String(user._id)
        )).length;
        return {
          postId: String(post._id),
          preview: String(post.content || '').slice(0, 120),
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

  static isAgentUsername(username: string | undefined | null): boolean {
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

  static async createMessageActivity(
    message: unknown,
    podId: unknown,
    user: unknown,
  ): Promise<unknown> {
    try {
      const pod = await Pod.findById(podId).select('_id name').lean();
      if (!pod) return null;
      return Activity.createFromMessage(message, pod, user);
    } catch (error) {
      console.error('Error creating message activity:', error);
      return null;
    }
  }

  static async createSkillActivity(summary: unknown, podId: unknown): Promise<unknown> {
    try {
      const pod = await Pod.findById(podId).select('_id name').lean();
      if (!pod) return null;
      return Activity.createSkillActivity(summary, pod);
    } catch (error) {
      console.error('Error creating skill activity:', error);
      return null;
    }
  }

  static async createApprovalRequest(options: unknown): Promise<unknown> {
    try {
      return Activity.createApprovalRequest(options);
    } catch (error) {
      console.error('Error creating approval request:', error);
      return null;
    }
  }

  static async toggleLike(activityId: string, userId: unknown): Promise<Record<string, unknown>> {
    try {
      if (activityId.startsWith('msg_') || activityId.startsWith('sum_')) {
        return { success: true, liked: true };
      }

      const activity = await Activity.findById(activityId);
      if (!activity) {
        return { success: false, error: 'Activity not found' };
      }

      const liked = await activity.toggleLike(userId);
      return { success: true, liked, likes: activity.reactions.likes };
    } catch (error) {
      const err = error as { message?: string };
      console.error('Error toggling like:', error);
      return { success: false, error: err.message };
    }
  }

  static async addReply(activityId: string, userId: unknown, content: string): Promise<Record<string, unknown>> {
    try {
      const user = await User.findById(userId).select('username').lean() as { username?: string } | null;
      const userName = user?.username || 'User';
      const isAgent = ActivityService.isAgentUsername(userName);

      if (activityId.startsWith('msg_') || activityId.startsWith('sum_')) {
        return {
          success: true,
          reply: {
            id: `reply_${Date.now()}`,
            actor: {
              id: String(userId),
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
            id: String(userId),
            name: userName,
            type: isAgent ? 'agent' : 'human',
          },
          content,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      const err = error as { message?: string };
      console.error('Error adding reply:', error);
      return { success: false, error: err.message };
    }
  }

  static async approveActivity(activityId: string, userId: unknown, notes: string): Promise<Record<string, unknown>> {
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
      const err = error as { message?: string };
      console.error('Error approving activity:', error);
      return { success: false, error: err.message };
    }
  }

  static async rejectActivity(activityId: string, userId: unknown, notes: string): Promise<Record<string, unknown>> {
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
      const err = error as { message?: string };
      console.error('Error rejecting activity:', error);
      return { success: false, error: err.message };
    }
  }

  static async getPendingApprovals(userId: unknown): Promise<unknown[]> {
    try {
      const pods: Array<{ _id: unknown }> = await Pod.find({
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

  static async seedPodActivities(podId: unknown, userId: unknown): Promise<Record<string, unknown>> {
    try {
      const pod = await Pod.findById(podId).lean();
      if (!pod) return { success: false, error: 'Pod not found' };

      const user = await User.findById(userId).lean() as { username?: string } | null;
      if (!user) return { success: false, error: 'User not found' };

      const activities: unknown[] = [];

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
              content: "I've analyzed the PR. Found 2 potential issues with the token refresh logic.",
              createdAt: new Date(Date.now() - 4 * 60 * 1000),
            },
          ],
        }),
      );

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
      const err = error as { message?: string };
      console.error('Error seeding activities:', error);
      return { success: false, error: err.message };
    }
  }
}

module.exports = ActivityService;

export {};
