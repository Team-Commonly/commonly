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
// eslint-disable-next-line global-require
const Task = require('../models/Task');

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
  activityQueue?: { acknowledgedMentionIds?: unknown[] };
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

interface GetRecapOptions {
  window?: 'today' | '7d';
  podId?: string;
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

// System actors whose posts are plumbing, not work. The recap and the feed
// exist to answer "what did MY agents do" — commonly-bot's task-echo volume
// (95 updates in one window, TASK-083) drowned every real seat, which is what
// made the Activity tab read as empty of real agent activity.
const SYSTEM_BOT_NAMES = new Set(['commonly-bot', 'commonly-ai-agent']);

class ActivityService {
  /**
   * Read-side projection for the v2 Activity surface. The source events stay
   * in their owning stores: messages remain in Postgres and board transitions
   * remain Task updates in Mongo. This endpoint only groups a member's
   * existing, authorized data; it does not introduce another activity log.
   */
  static async getRecap(
    userId: unknown,
    options: GetRecapOptions = {},
  ): Promise<Record<string, unknown>> {
    const window = options.window === '7d' ? '7d' : 'today';
    const since = new Date(Date.now() - (window === '7d' ? 7 : 1) * 24 * 60 * 60 * 1000);
    const pods: PodDoc[] = await Pod.find({
      $or: [
        { createdBy: userId },
        { 'members.userId': userId },
        { members: userId },
      ],
    }).select('_id name type').lean();

    const requestedPodId = typeof options.podId === 'string' ? options.podId : '';
    const scopedPods = requestedPodId
      ? pods.filter((pod) => String(pod._id) === requestedPodId)
      : pods;
    if (requestedPodId && scopedPods.length === 0) {
      throw new Error('Access denied');
    }

    const scopedPodIds = new Set(scopedPods.map((pod) => String(pod._id)));
    // filter: 'agents' — the recap is about agent WORK. Without it, the
    // 100-slot feed budget was consumed entirely by `summary` activities
    // (30/30 measured live), which are newer and more numerous than any
    // message, so zero agent messages ever reached the grouping below.
    const feed = await ActivityService.getUserFeed(userId, { limit: 100, filter: 'agents' });
    const activities = ((feed.activities as ActivityItem[] | undefined) || []).filter((activity) => {
      const timestamp = activity.timestamp ? new Date(activity.timestamp).getTime() : 0;
      return timestamp >= since.getTime()
        && (!requestedPodId || (activity.pod && scopedPodIds.has(activity.pod.id)));
    });
    const acknowledgedMentionIds = new Set(
      ((feed.acknowledgedMentionIds as unknown[] | undefined) || []).map((id) => String(id)),
    );

    type AgentRecap = {
      id: string;
      name: string;
      profilePicture?: string;
      lastActiveAt: Date | string | null;
      messageCount: number;
      recap: string;
      updates: Array<{
        id: string;
        podId: string | null;
        podName: string;
        content: string;
        timestamp: Date | string | null;
      }>;
    };
    const agents = new Map<string, AgentRecap>();

    activities
      .filter((activity) => activity.actor?.type === 'agent' || activity.flags?.isAgentAction)
      // Defense at the GROUPING layer too: commonly-bot's task echoes arrive
      // via stored Activity docs as well as messages, so filtering only the
      // message source left the recap 100% system bot (#1306's live verify).
      .filter((activity) => !SYSTEM_BOT_NAMES.has(String(activity.actor?.name || '').toLowerCase()))
      .forEach((activity) => {
        const actorId = String(activity.actor?.id || activity.actor?.name || 'unknown-agent');
        const name = activity.actor?.name || 'Agent';
        const existing = agents.get(actorId) || {
          id: actorId,
          name,
          profilePicture: activity.actor?.profilePicture,
          lastActiveAt: activity.timestamp,
          messageCount: 0,
          recap: '',
          updates: [],
        };
        existing.messageCount += 1;
        if (new Date(activity.timestamp || 0).getTime() > new Date(existing.lastActiveAt || 0).getTime()) {
          existing.lastActiveAt = activity.timestamp;
        }
        const content = String(activity.preview || activity.content || activity.action || '').replace(/\s+/g, ' ').trim();
        if (content) {
          existing.updates.push({
            id: activity.id,
            podId: activity.pod?.id || null,
            podName: activity.pod?.name || 'Direct activity',
            content: content.slice(0, 180),
            timestamp: activity.timestamp,
          });
        }
        agents.set(actorId, existing);
      });

    const agentRecaps = Array.from(agents.values())
      .map((agent) => {
        const updates = agent.updates
          .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
          .slice(0, 3);
        const podNames = Array.from(new Set(updates.map((update) => update.podName)));
        return {
          ...agent,
          updates,
          recap: agent.messageCount === 1
            ? `Posted an update${podNames[0] ? ` in ${podNames[0]}` : ''}.`
            : `Posted ${agent.messageCount} updates${podNames[0] ? ` across ${podNames.slice(0, 2).join(' and ')}` : ''}.`,
        };
      })
      .sort((a, b) => new Date(b.lastActiveAt || 0).getTime() - new Date(a.lastActiveAt || 0).getTime());

    // Approvals are a decision queue, not an activity sample: query the
    // existing authoritative pending-approval reader separately so a busy
    // pod cannot push an older decision behind getUserFeed's display page.
    // Mentions remain a bounded recent interrupt list and are removed only by
    // their explicit acknowledgement, never by feed read-state.
    const pendingApprovals = await ActivityService.getPendingApprovals(userId) as Array<{
      _id?: unknown;
      id?: unknown;
      type?: string;
      actor?: ActorInfo;
      action?: string;
      content?: string;
      podId?: unknown;
      approval?: unknown;
      agentMetadata?: { agentName?: string };
      createdAt?: Date | string;
      updatedAt?: Date | string;
    }>;
    const approvalItems: ActivityItem[] = pendingApprovals
      .filter((approval) => !requestedPodId || scopedPodIds.has(String(approval.podId)))
      .map((approval) => {
        const podId = approval.podId ? String(approval.podId) : '';
        const pod = scopedPods.find((candidate) => String(candidate._id) === podId);
        return {
          id: String(approval._id || approval.id || ''),
          type: approval.type || 'approval_needed',
          actor: approval.actor || {
            name: approval.agentMetadata?.agentName || 'An agent', type: 'agent',
          },
          action: approval.action || 'approval_needed',
          content: approval.content,
          timestamp: approval.createdAt || approval.updatedAt || null,
          pod: pod ? { id: String(pod._id), name: pod.name } : null,
          approval: approval.approval,
          reactions: { likes: 0, liked: false },
          replyCount: 0,
          replies: [],
        };
      })
      .filter((approval) => Boolean(approval.id));

    const isPendingApproval = (activity: ActivityItem): boolean => {
      const approval = activity.approval as { status?: string } | undefined;
      // Mongoose materializes approval.status = 'pending' for every Activity
      // document. It is meaningful only on the one activity type that carries
      // an approval request; otherwise every message becomes a human action.
      return activity.type === 'approval_needed' && approval?.status === 'pending';
    };
    const queueCandidates = new Map<string, ActivityItem>();
    [...activities, ...approvalItems].forEach((activity) => {
      if (!queueCandidates.has(activity.id)) queueCandidates.set(activity.id, activity);
    });
    const newestFirst = (left: ActivityItem, right: ActivityItem) => (
      new Date(right.timestamp || 0).getTime() - new Date(left.timestamp || 0).getTime()
    );
    const approvalQueue = Array.from(queueCandidates.values())
      .filter(isPendingApproval)
      .sort(newestFirst);
    const mentionQueue = Array.from(queueCandidates.values())
      .filter((activity) => activity.flags?.isMention && !acknowledgedMentionIds.has(String(activity.id)))
      .sort(newestFirst)
      .slice(0, Math.max(0, 12 - approvalQueue.length));
    const needsYou = [...approvalQueue, ...mentionQueue]
      .sort(newestFirst)
      .map((activity) => {
        const isApproval = isPendingApproval(activity);
        return {
          id: activity.id,
          kind: isApproval ? 'approval' : 'mention',
          title: isApproval ? 'Approval requested' : `${activity.actor?.name || 'Someone'} mentioned you`,
          detail: String(activity.preview || activity.content || '').replace(/\s+/g, ' ').trim().slice(0, 180),
          podId: activity.pod?.id || null,
          podName: activity.pod?.name || 'Direct activity',
          timestamp: activity.timestamp,
        };
      });

    let board: Array<Record<string, unknown>> = [];
    if (scopedPods.length > 0) {
      const taskRows: Array<Record<string, unknown>> = await Task.find({
        podId: { $in: scopedPods.map((pod) => pod._id) },
        updatedAt: { $gte: since },
      })
        .select('podId taskId title status updatedAt updates')
        .sort({ updatedAt: -1 })
        .limit(24)
        .lean();
      const podNames = new Map(scopedPods.map((pod) => [String(pod._id), pod.name]));
      board = taskRows.map((task) => {
        const updates = Array.isArray(task.updates) ? task.updates as Array<Record<string, unknown>> : [];
        const lastUpdate = updates
          .slice()
          .sort((a, b) => new Date(b.createdAt as string || 0).getTime() - new Date(a.createdAt as string || 0).getTime())[0];
        return {
          id: String(task._id),
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          podId: String(task.podId),
          podName: podNames.get(String(task.podId)) || 'Pod',
          updatedAt: task.updatedAt,
          lastUpdate: lastUpdate
            ? {
              text: String(lastUpdate.text || '').slice(0, 180),
              author: String(lastUpdate.author || ''),
              createdAt: lastUpdate.createdAt,
            }
            : null,
        };
      });
    }

    return {
      window,
      since: since.toISOString(),
      generatedAt: new Date().toISOString(),
      scope: requestedPodId || 'all',
      pods: pods.map((pod) => ({ id: String(pod._id), name: pod.name })),
      needsYou,
      agents: agentRecaps,
      board,
    };
  }

  static async getUserFeed(
    userId: unknown,
    options: GetFeedOptions = {},
  ): Promise<Record<string, unknown>> {
    const {
      limit = 20, before, filter, mode = 'updates',
    } = options;

    try {
      const user: UserDoc | null = await User.findById(userId)
        .select('_id username following followers followedThreads activityQueue')
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

      const podMap = new Map(pods.map((p) => [String(p._id), p]));
      // Rank pods by most-recent message so downstream per-pod fetches (which
      // are bounded) always cover the rooms where work is actually happening,
      // not five arbitrary rows of a 40-pod membership (TASK-083 defect 1).
      const podIds = await ActivityService.rankPodsByRecentActivity(pods.map((p) => p._id));

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
        acknowledgedMentionIds: user.activityQueue?.acknowledgedMentionIds || [],
      };
    } catch (error) {
      console.error('Error in getUserFeed:', error);
      throw error;
    }
  }

  /**
   * Order podIds by their most recent chat message, newest first. One PG
   * query for the whole membership; pods with no PG messages (or when PG is
   * unavailable) keep their original relative order at the tail — degrading
   * to today's arbitrary order, never to a smaller pod set.
   */
  static async rankPodsByRecentActivity(podIds: unknown[]): Promise<unknown[]> {
    if (!podIds.length) return podIds;
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const { pool } = require('../config/db-pg') as {
        pool: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<{ pod_id: string }> }> } | null;
      };
      if (!pool) return podIds;
      const ids = podIds.map((id) => String(id));
      // ::text[] is load-bearing: without the cast Postgres cannot infer the
      // array's type from `= ANY($1)` and rejects the query — which this
      // function's catch silently degraded to the OLD arbitrary order, so
      // the ranking shipped as a no-op (caught live on #1306's verify:
      // recap still commonly-bot-only because the working pods still never
      // made the fetch window).
      const { rows } = await pool.query(
        'SELECT pod_id, MAX(created_at) AS latest FROM messages WHERE pod_id = ANY($1::text[]) GROUP BY pod_id ORDER BY latest DESC',
        [ids],
      );
      const ranked = rows.map((r) => String(r.pod_id));
      const rankIndex = new Map(ranked.map((id, i) => [id, i]));
      return [...podIds].sort((a, b) => {
        const ia = rankIndex.has(String(a)) ? (rankIndex.get(String(a)) as number) : Number.MAX_SAFE_INTEGER;
        const ib = rankIndex.has(String(b)) ? (rankIndex.get(String(b)) as number) : Number.MAX_SAFE_INTEGER;
        return ia - ib;
      });
    } catch {
      return podIds;
    }
  }

  /**
   * The decision queue: everything concretely waiting on THIS human, from
   * facts that exist today (TASK-083 defect 1's fix): pending approval
   * requests, unacknowledged direct mentions, and board rows that name a
   * human decision — DECIDE-titled tasks, blocked tasks, and tasks whose
   * latest update hands off to a human press/ruling. No inference, no
   * name-matching heuristics (TASK-070b stays open by design).
   */
  /**
   * Every message in the user's pods that @mentions them, threads included,
   * minus their own and minus acknowledged ones. Ids are `msg_<pg id>` —
   * the same shape the feed emits, so acknowledgedMentionIds keeps working.
   */
  static async getMentionsForUser(userId: unknown, podIds: unknown[]): Promise<Array<{
    id: string; messageId: number; threadRootId: number; podId: string;
    authorName: string; content: string; createdAt: Date;
  }>> {
    const user = await (User as {
      findById(id: unknown): { select(f: string): { lean(): Promise<{ username?: string; activityQueue?: { acknowledgedMentionIds?: unknown[] } } | null> } };
    }).findById(userId).select('username activityQueue.acknowledgedMentionIds').lean();
    const username = String(user?.username || '').trim();
    if (!username || !podIds.length) return [];
    const acked = new Set(((user?.activityQueue?.acknowledgedMentionIds as unknown[]) || []).map(String));
    const { pool } = require('../config/db-pg') as { pool: { query(q: string, p: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> } };
    // ILIKE on the handle; the trailing boundary keeps @sam from matching
    // @samantha. ::text[] is load-bearing (the rank query lesson, #1307).
    const { rows } = await pool.query(
      `SELECT m.id, m.pod_id, m.user_id, m.content, m.created_at, m.thread_root_id, u.username AS author
         FROM messages m
         LEFT JOIN users u ON u._id = m.user_id
        WHERE m.pod_id = ANY($1::text[])
          AND m.user_id <> $2
          AND m.created_at > now() - interval '7 days'
          AND m.content ~* $3
        ORDER BY m.created_at DESC
        LIMIT 40`,
      [podIds.map(String), String(userId), `@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`],
    );
    return rows
      .map((r) => ({
        id: `msg_${r.id}`,
        messageId: Number(r.id),
        threadRootId: Number(r.thread_root_id || r.id),
        podId: String(r.pod_id),
        authorName: String(r.author || 'Someone'),
        content: String(r.content || ''),
        createdAt: r.created_at as Date,
      }))
      .filter((m) => !acked.has(m.id));
  }

  static async getDecisionQueue(userId: unknown): Promise<Record<string, unknown>> {
    const pods: PodDoc[] = await Pod.find({
      $or: [
        { createdBy: userId },
        { 'members.userId': userId },
        { members: userId },
      ],
    }).select('_id name type').lean();
    const podIds = pods.map((p) => p._id);
    const podName = new Map(pods.map((p) => [String(p._id), p.name as string]));

    type QueueItem = {
      kind: 'approval' | 'mention' | 'decision' | 'press';
      id: string;
      title: string;
      detail?: string;
      podId: string | null;
      podName?: string;
      taskId?: string;
      createdAt: Date | string | null;
    };
    const items: QueueItem[] = [];

    // 1. Pending approvals — the authoritative reader already exists.
    try {
      const approvals = await ActivityService.getPendingApprovals(userId) as Array<{
        _id: { toString(): string }; content?: string; podId?: unknown; createdAt?: Date;
        agentMetadata?: { agentName?: string };
      }>;
      for (const a of approvals) {
        items.push({
          kind: 'approval',
          // RAW activity id — the act endpoints (/api/activity/:id/approve)
          // key on it, so a prefixed id here would break the buttons.
          id: String(a._id),
          title: a.agentMetadata?.agentName ? `${a.agentMetadata.agentName} requests approval` : 'Approval requested',
          detail: String(a.content || '').slice(0, 160),
          podId: a.podId ? String(a.podId) : null,
          podName: a.podId ? podName.get(String(a.podId)) : undefined,
          createdAt: a.createdAt || null,
        });
      }
    } catch (err) {
      console.warn('[decision-queue] approvals read failed:', (err as Error).message);
    }

    // 2. Unacknowledged direct mentions — a DEDICATED query, not the feed.
    // Sam, 2026-09-01: "pods mentioning me… but activity tab is not showing
    // properly." Measured: 15 @Sam mentions in 36h, 14 inside THREADS, and
    // the feed path saw zero — it samples ~20 recent rows per pod through
    // the generic aggregator, so thread traffic (where agents now do most
    // of their talking) never reaches the mention flag. The mention query
    // asks the store the actual question, across every pod, threads
    // included, for the last 7 days.
    try {
      const mentions = await ActivityService.getMentionsForUser(userId, podIds);
      for (const m of mentions) {
        items.push({
          kind: 'mention',
          id: m.id,
          title: `${m.authorName} mentioned you`,
          detail: m.content.slice(0, 220),
          podId: m.podId,
          podName: podName.get(m.podId),
          createdAt: m.createdAt,
          // Reply-in-place needs the thread root (or the message itself, as
          // the root of a new thread) and the message to address.
          ...({ threadRootId: m.threadRootId, messageId: m.messageId } as Record<string, unknown>),
        });
      }
    } catch (err) {
      console.warn('[decision-queue] mentions read failed:', (err as Error).message);
    }

    // 3. Board facts. Concrete, not inferred: a DECIDE-titled open row IS a
    // decision request; a blocked row is waiting on someone; a latest update
    // that says "human press" / "Sam's ruling" is an explicit handoff.
    try {
      const HANDOFF_RE = /human\s+(merge\s+)?press|ready for (the\s+)?(human|sam)|sam'?s?\s+(ruling|call|decision)|awaiting\s+(sam|human)/i;
      // Freshness cutoff (Sam, 2026-09-01: "some of those activities seem
      // stale and non new attention routes"). Measured that day: every queue
      // item was 10–47 days old, half of them zombie rows from dead pods —
      // "Fix CI failures on PR #N" from July does not need attention, it
      // needs an archive. A board row qualifies as WAITING ON YOU only if
      // someone touched it recently; the row itself stays on the board
      // either way, so nothing is lost — only the attention claim expires.
      const STALE_CUTOFF = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const tasks = await (Task as {
        find(q: unknown): { sort(s: unknown): { limit(n: number): { lean(): Promise<Array<Record<string, unknown>>> } } };
      }).find({
        podId: { $in: podIds },
        status: { $in: ['pending', 'claimed', 'blocked'] },
        updatedAt: { $gte: STALE_CUTOFF },
      }).sort({ updatedAt: -1 }).limit(120).lean();
      for (const t of tasks) {
        const title = String(t.title || '');
        const updates = (t.updates as Array<{ text?: string; createdAt?: Date }> | undefined) || [];
        const last = updates[updates.length - 1];
        const isDecide = /^DECIDE\b/i.test(title);
        const isBlocked = t.status === 'blocked';
        const isHandoff = !!(last && HANDOFF_RE.test(String(last.text || '')));
        if (!isDecide && !isBlocked && !isHandoff) continue;
        items.push({
          kind: isHandoff && !isDecide ? 'press' : 'decision',
          id: `task_${t.taskId}`,
          title,
          detail: last ? String(last.text || '').slice(0, 160) : undefined,
          podId: String(t.podId),
          podName: podName.get(String(t.podId)),
          taskId: String(t.taskId || ''),
          createdAt: (last?.createdAt as Date) || (t.updatedAt as Date) || null,
        });
      }
    } catch (err) {
      console.warn('[decision-queue] board read failed:', (err as Error).message);
    }

    // Attention order, then recency, then a hard cap. Approvals and presses
    // are actionable in one click; mentions need a reply; standing decisions
    // (incl. the old blocked backlog) come last — 32 undifferentiated rows
    // is a wall, not a queue (#1306's live verify). The count still reports
    // the full total so the cap is visible, not silent.
    const KIND_PRIORITY: Record<string, number> = {
      approval: 0, press: 1, mention: 2, decision: 3,
    };
    items.sort((a, b) => {
      const kindDelta = (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9);
      if (kindDelta !== 0) return kindDelta;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
    return { items: items.slice(0, 12), count: items.length };
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
          // TASK-083 defect 1's root cause lived here: `.slice(0, 5)` over
          // podIds in ARBITRARY Mongo order meant a member of ~40 pods got
          // messages from five random rooms — the working pods never made
          // the cut and the feed read as empty of real agent activity. The
          // caller (getUserFeed) now ranks podIds by recent message time
          // before this runs; the slice widens to the ranked top 12, which
          // bounds the fan-out while guaranteeing the ACTIVE rooms are in.
          // String(podId) is the WHOLE fix for a bug older than this file's
          // v2 rework: callers pass Mongo ObjectId OBJECTS, and pg serializes
          // an object into something that matches no VARCHAR pod_id — zero
          // rows, silently, for every pod, forever. Message activities have
          // been empty since this path shipped; the summary flood and bot
          // noise the earlier TASK-083 fixes removed were just what grew in
          // the vacuum. (Verified live: findByPodId(oid) -> 0 rows,
          // findByPodId(String(oid)) -> rows.)
          const podMessagesList = await Promise.all(
            podIds.slice(0, 12).map((podId) => (PGMessage as { findByPodId(id: unknown, limit: number): Promise<unknown[]> }).findByPodId(String(podId), limit)),
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
        // PG rows carry `is_bot` as a COLUMN; only Mongo rows populate the
        // userId object. Checking only `userId?.isBot` classified every
        // PG-authored agent message as human, and the agent-only recap
        // dropped all of them (#1307's live verify: recap empty).
        const isAgent = msg.is_bot === true
          || userId?.isBot === true
          || ActivityService.isAgentUsername(authorName);

        // System plumbing is not activity (TASK-083 defect 2).
        if (SYSTEM_BOT_NAMES.has(authorName.toLowerCase())) return;
        if (filter === 'humans' && isAgent) return;
        if (filter === 'agents' && !isAgent) return;

        const pod = podMap.get(String(msg.podId || msg.pod_id || ''));

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

  static async acknowledgeMention(userId: unknown, activityId: string): Promise<Record<string, unknown>> {
    const user = await User.findById(userId).select('_id activityQueue');
    if (!user) return { success: false, error: 'User not found' };

    if (!user.activityQueue) user.activityQueue = { acknowledgedMentionIds: [] };
    const next = new Set((user.activityQueue.acknowledgedMentionIds || []).map((id: unknown) => String(id)));
    next.add(String(activityId));
    // This is per-(user, message) state, rather than a recent-feed cache: an
    // acknowledged mention must not resurface merely because more messages
    // arrive later.
    user.activityQueue.acknowledgedMentionIds = Array.from(next);
    await user.save();
    return { success: true, acknowledgedMentionIds: user.activityQueue.acknowledgedMentionIds };
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
        // Pod.members is an ObjectId[] with no role field. This owner lookup
        // replaces the inert members.role branch, which implied a nonexistent
        // admin audience for pending approvals.
        createdBy: userId,
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
