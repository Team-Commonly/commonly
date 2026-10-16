// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const ActivityService = require('./activityService');
// eslint-disable-next-line global-require
const { resolveAgentDisplayLabel } = require('./agentIdentityService');

/**
 * The daily digest is "what your agents did while you were away" (stickiness
 * Phase 2, TASK-257; Growth spec 2026-10-15). It is built from the activity
 * recap, the same read the Activity page shows, never from chat summaries:
 * what is waiting on the person, what each of their agents posted, and what
 * moved on the board, in the person's own pods only.
 *
 * Every line states something that happened, so there is no LLM step: the
 * previous version asked a model to narrate chat summaries, and it could only
 * ever be as true as the narration.
 */

interface EmptyDigestResult {
  title: string;
  content: string;
  analytics: Record<string, unknown>;
}

interface DigestResult {
  userId: unknown;
  success: boolean;
  digest?: unknown;
  error?: string;
}

interface RecapLike {
  pods?: Array<{ id: string; name: string }>;
  needsYou?: Array<{ title?: string; podId?: string; podName?: string }>;
  agents?: Array<{
    id?: string;
    name?: string;
    recap?: string;
    messageCount?: number;
    updates?: Array<{ podId?: string | null; podName?: string; content?: string }>;
  }>;
  board?: Array<{ taskId?: string; title?: string; status?: string; podId?: string; podName?: string }>;
}

/** Someone active this recently has seen it in the app; the email would repeat it. */
export const DIGEST_AWAY_MS = 20 * 60 * 60 * 1000;
const MAX_NEEDS_YOU = 3;
const MAX_AGENTS = 5;
const MAX_BOARD = 5;
const LINE_MAX = 200;

/** What the digest knows about an agent from its User row, keyed by user id. */
interface AgentIdentity {
  label: string;
  // Scout is the guide, not one of "your agents": its welcome would otherwise
  // make every new account's first digest say an agent did something. Known
  // by agentName, never by display name, so a person's own agent called
  // "Scout..." still counts.
  guide: boolean;
}

interface RecapContext {
  publicPodIds?: Set<string>;
  agentIdentities?: Map<string, AgentIdentity>;
}

const oneLine = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim().slice(0, LINE_MAX);

export class DailyDigestService {
  /**
   * The digest's lines, most important first: what is waiting on the person,
   * then each agent's latest work, then board changes. Empty means nothing
   * happened that the person needs to hear about.
   */
  static recapLines(
    recap: RecapLike | null | undefined,
    { publicPodIds = new Set(), agentIdentities = new Map() }: RecapContext = {},
  ): string[] {
    if (!recap) return [];
    const lines: string[] = [];
    // recap.pods is the person's pods by Pod.members alone. An ask from a pod
    // outside it (a creator who has since left, whose createdBy still names
    // them) is a title from a pod they can no longer open, so it stays out.
    const memberPodIds = new Set((recap.pods || []).map((pod) => String(pod.id)));
    // A public pod (Commonly HQ, which every signup joins) is not "your
    // agents": its agent posts and board moves are someone else's work. The
    // dry run on 2026-10-16 found every outside recipient's only line was a
    // support answer to another person in HQ. What waits on YOU stays, wherever.
    // A line with no pod (a feed lookup that missed) has unknown provenance, so
    // it stays out too: this guard withholds other people's content.
    const inPrivatePod = (podId: unknown) => Boolean(podId) && !publicPodIds.has(String(podId));
    const asks = (recap.needsYou || []).filter((item) => memberPodIds.has(String(item.podId)));
    asks.slice(0, MAX_NEEDS_YOU).forEach((item) => {
      const title = oneLine(item.title);
      if (title) lines.push(`Waiting on you: ${title}${item.podName ? ` (${oneLine(item.podName)})` : ''}`);
    });
    (recap.agents || [])
      .map((agent) => ({ agent, identity: agentIdentities.get(String(agent.id)) }))
      .filter(({ identity }) => !identity?.guide)
      .map(({ agent, identity }) => ({
        agent,
        identity,
        updates: (agent.updates || []).filter((update) => inPrivatePod(update.podId)),
      }))
      .filter(({ updates }) => updates.length > 0)
      .slice(0, MAX_AGENTS)
      .forEach(({ agent, identity, updates }) => {
        const name = oneLine(identity?.label || agent.name) || 'An agent';
        const [latest] = updates;
        // Counted from the updates kept, so a public pod's posts never inflate it.
        const more = updates.length > 1 ? ` (+${updates.length - 1} more)` : '';
        lines.push(`${name} in ${oneLine(latest.podName) || 'a pod'}: ${oneLine(latest.content)}${more}`);
      });
    (recap.board || []).filter((task) => inPrivatePod(task.podId)).slice(0, MAX_BOARD).forEach((task) => {
      const title = oneLine(task.title);
      if (!title) return;
      const id = task.taskId ? `${task.taskId} ` : '';
      const pod = task.podName ? ` (${oneLine(task.podName)})` : '';
      lines.push(`${id}${title} is ${oneLine(task.status) || 'updated'}${pod}`);
    });
    return lines;
  }

  /** Each recap agent's display label and whether it is the guide, from its User row. */
  static async agentIdentities(recap: RecapLike | null): Promise<Map<string, AgentIdentity>> {
    const ids = (recap?.agents || []).map((agent) => String(agent.id || '')).filter((id) => /^[a-f0-9]{24}$/i.test(id));
    if (ids.length === 0) return new Map();
    const users = await User.find({ _id: { $in: ids } }).select('username botMetadata').lean() as Array<{
      _id: unknown; username?: string; botMetadata?: { displayName?: string; instanceId?: string; agentName?: string };
    }>;
    return new Map(users.map((user) => [String(user._id), {
      label: resolveAgentDisplayLabel(user, user.username),
      guide: String(user.botMetadata?.agentName || '').toLowerCase() === 'scout',
    }]));
  }

  /**
   * One person's digest for the last 24 hours. The scheduled run passes
   * requireAway, so someone active in the last DIGEST_AWAY_MS gets an empty
   * digest (they have seen it in the app); an on-demand generation does not.
   */
  async generateUserDailyDigest(
    userId: unknown,
    { requireAway = false }: { requireAway?: boolean } = {},
  ): Promise<unknown> {
    try {
      const user = await User.findById(userId).lean() as Record<string, unknown> | null;
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);
      const lastActive = user.lastActive ? new Date(user.lastActive as string).getTime() : 0;
      const away = !lastActive || endTime.getTime() - lastActive >= DIGEST_AWAY_MS;

      // The recap reads current pod membership itself (Pod.members).
      const recap: RecapLike | null = (requireAway && !away)
        ? null
        : await ActivityService.getRecap(userId, { window: 'today' });
      const publicPods = recap
        ? await Pod.find({ members: userId, publicRead: true }).select('_id').lean() as Array<{ _id: unknown }>
        : [];
      const lines = DailyDigestService.recapLines(recap, {
        publicPodIds: new Set(publicPods.map((pod) => String(pod._id))),
        agentIdentities: await DailyDigestService.agentIdentities(recap),
      });
      const podCount = recap?.pods?.length || 0;

      if (lines.length === 0) {
        const emptyData = DailyDigestService.createEmptyDigest(
          user as { username: string },
          startTime,
          endTime,
        );
        return Summary.create({
          type: 'daily-digest',
          title: emptyData.title,
          content: emptyData.content,
          timeRange: { start: startTime, end: endTime },
          metadata: {
            totalItems: 0,
            topTags: [],
            topUsers: [],
            subscribedPods: podCount,
            userId: String(userId),
          },
          analytics: emptyData.analytics,
        });
      }

      return Summary.create({
        type: 'daily-digest',
        title: requireAway ? 'What your agents did while you were away' : 'What your agents did today',
        content: lines.map((line) => `- ${line}`).join('\n'),
        timeRange: { start: startTime, end: endTime },
        metadata: {
          totalItems: lines.length,
          topTags: [],
          topUsers: [],
          subscribedPods: podCount,
          userId: String(userId),
        },
        analytics: DailyDigestService.createEmptyDigest(user as { username: string }, startTime, endTime).analytics,
      });
    } catch (error) {
      console.error(`Error generating daily digest for user ${userId}:`, error);
      throw error;
    }
  }

  static createEmptyDigest(user: { username: string }, startTime: Date, endTime: Date): EmptyDigestResult {
    return {
      title: `Daily Digest for ${user.username} - ${endTime.toDateString()}`,
      content: `# Daily Digest - ${endTime.toDateString()}

Good ${DailyDigestService.getTimeOfDayGreeting()}, ${user.username}!

It looks like it was a quiet day in your communities. Sometimes the best conversations happen during the calm moments.

## Community Pulse
- **Activity Level**: Low
- **Atmosphere**: Peaceful
- **Engagement**: Steady

## Looking Ahead
This might be a great time to start a new conversation or share something interesting with your communities!

---
*Your personalized daily digest • Generated with love by Commonly AI*`,
      analytics: {
        timeline: [],
        quotes: [],
        insights: [],
        atmosphere: {
          overall_sentiment: 'neutral',
          energy_level: 'low',
          engagement_quality: 'superficial',
          community_cohesion: 0.5,
          topics_diversity: 0.2,
          dominant_emotions: ['calm'],
        },
      },
    };
  }

  async generateAllDailyDigests(): Promise<DigestResult[]> {
    try {
      console.log('Starting daily digest generation for all users...');

      const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentPodIds = await Summary.distinct('podId', {
        type: { $in: ['posts', 'chats'] },
        podId: { $exists: true },
        createdAt: { $gte: startTime },
      });
      // Public-read pods include every signup; their activity is not a reason
      // to wake every stale account.
      const recentMemberIds = await Pod.distinct('members', {
        _id: { $in: recentPodIds },
        publicRead: { $ne: true },
      });

      const activeUsers = await User.find({
        isBot: { $ne: true },
        $or: [
          { lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
          { _id: { $in: recentMemberIds } },
        ],
      }).lean() as Array<{ _id: unknown; username?: string }>;

      console.log(`Found ${activeUsers.length} active users for daily digest generation`);

      const results = await Promise.allSettled(
        activeUsers.map(async (user) => {
          try {
            const digest = await this.generateUserDailyDigest(user._id, { requireAway: true });
            return { userId: user._id, success: true, digest };
          } catch (error) {
            console.error(`Failed to generate digest for user ${user._id}:`, error);
            return { userId: user._id, success: false, error: (error as Error).message };
          }
        }),
      ).then((settled) => settled.map((result) => (result.status === 'fulfilled' ? result.value : result.reason as DigestResult)));

      const successful = results.filter((r) => (r as DigestResult).success).length;
      console.log(`Generated daily digests: ${successful}/${activeUsers.length} successful`);

      return results;
    } catch (error) {
      console.error('Error generating daily digests:', error);
      throw error;
    }
  }

  static getTimeOfDayGreeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'morning';
    if (hour < 17) return 'afternoon';
    return 'evening';
  }
}

export default new DailyDigestService();
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
