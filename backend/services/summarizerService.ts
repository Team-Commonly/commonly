// eslint-disable-next-line global-require
const fetch = require('node-fetch');
// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const Post = require('../models/Post');
// eslint-disable-next-line global-require
const { generateText } = require('./llmService');

// Add fetch polyfill for Node.js
if (!(global as Record<string, unknown>).fetch) {
  (global as Record<string, unknown>).fetch = fetch;
}

interface SummaryMetadata {
  totalItems: number;
  topTags?: string[];
  topUsers?: string[];
  podName?: string;
  timeRange?: string;
}

interface SummaryDoc {
  content?: string;
  metadata?: SummaryMetadata;
}

interface AllPostsSummary {
  title: string;
  content: string;
  metadata: {
    totalItems: number;
    topTags: string[];
    topUsers: string[];
    timeRange: string;
  };
}

interface AllPostsCache {
  summary: AllPostsSummary | null;
  createdAt: number;
  cooldownUntil: number;
}

interface GarbageCollectResult {
  deletedCount: number;
  cutoffDate: Date;
}

class SummarizerService {
  async generateSummary(content: string, type: string): Promise<string> {
    try {
      console.log(`Generating ${type} summary with LLM...`);
      const prompt = SummarizerService.createPrompt(content, type);
      const summaryText = await generateText(prompt, { temperature: 0.4 }) as string;
      console.log(
        `✓ LLM returned summary for ${type}: "${summaryText.substring(0, 100)}..."`,
      );
      return summaryText;
    } catch (error) {
      console.error('Error generating summary with LLM:', error);
      console.log(`Falling back to simple summary for ${type}`);
      return SummarizerService.generateFallbackSummary(content, type);
    }
  }

  static createPrompt(content: string, type: string): string {
    if (type === 'posts') {
      return `You are a community manager creating an engaging summary of recent social media posts.

Here are the recent posts from our community:
${content}

Please create a vibrant, engaging 2-3 sentence summary that:
- Captures the main themes and trending topics
- Highlights interesting discussions or popular content
- Uses a friendly, conversational tone
- Makes the community sound active and welcoming

Write as if you're updating community members on what they missed. Be specific about the content rather than just mentioning numbers.`;
    }

    if (type === 'discord') {
      return `You are a community manager creating an engaging summary of recent Discord channel activity.

Here are the recent messages from the Discord channel:
${content}

Please create a descriptive, engaging 2-3 sentence summary that:
- Captures what people were actually discussing and doing
- Highlights interesting conversations, decisions, or topics
- Uses a natural, conversational tone
- Focuses on the content and context, not just participant counts
- Makes the activity sound meaningful and engaging

Write as if you're telling someone what they missed in the Discord channel. Be specific about the actual conversations and topics rather than just listing keywords.`;
    }
    if (type === 'integration') {
      return `You are a community manager creating an engaging summary of recent external chat activity.

Here are the recent messages from an external chat channel:
${content}

Please create a descriptive, engaging 2-3 sentence summary that:
- Captures what people were actually discussing and doing
- Highlights interesting conversations, decisions, or topics
- Uses a natural, conversational tone
- Focuses on the content and context, not just participant counts
- Makes the activity sound meaningful and engaging

Write as if you're telling someone what they missed in this channel. Be specific about the actual conversations and topics rather than just listing keywords.`;
    }
    return `You are a community manager summarizing chat activity across multiple chat rooms.

Here are summaries from various chat rooms:
${content}

Please create an engaging 2-3 sentence overview that:
- Highlights the most interesting conversations happening
- Mentions which rooms are most active
- Captures the community vibe and energy
- Uses a friendly, welcoming tone

Focus on what people are actually talking about rather than just activity levels.`;
  }

  static generateFallbackSummary(content: string, type: string): string {
    const itemCount = content.split('\n').filter((line) => line.trim()).length;
    if (type === 'posts') {
      return `${itemCount} posts were shared in the last hour, covering various topics and discussions in the community.`;
    }
    if (type === 'integration') {
      return `${itemCount} messages were shared recently across the linked external channel.`;
    }
    return `Activity in ${itemCount} chat rooms with various conversations and community interactions.`;
  }

  async summarizePosts(): Promise<unknown> {
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);

      const posts = await Post.find({
        createdAt: { $gte: startTime, $lte: endTime },
      })
        .populate('userId', 'username')
        .lean() as Array<Record<string, unknown>>;

      if (posts.length === 0) {
        return await SummarizerService.createEmptySummary(
          'posts',
          'No new posts were shared in the last hour. The community is taking a peaceful break.',
        );
      }

      const content = posts
        .map((post) => {
          const user = post.userId as Record<string, unknown> | null;
          const username = user?.username || 'Unknown';
          const tags = Array.isArray(post.tags) && post.tags.length ? ` #${(post.tags as string[]).join(' #')}` : '';
          return `@${username}: ${post.content}${tags}`;
        })
        .join('\n');

      const summaryText = await this.generateSummary(content, 'posts');

      const allTags = posts.flatMap((post) => (post.tags as string[]) || []);
      const topTags = SummarizerService.getTopItems(allTags, 5);
      const topUsers = SummarizerService.getTopItems(
        posts.map((post) => {
          const user = post.userId as Record<string, unknown> | null;
          return user?.username as string;
        }).filter(Boolean),
        3,
      );

      const title = SummarizerService.generateTitle('posts', posts.length, topTags);

      return await Summary.create({
        type: 'posts',
        title,
        content: summaryText,
        timeRange: { start: startTime, end: endTime },
        metadata: { totalItems: posts.length, topTags, topUsers },
      });
    } catch (error) {
      console.error('Error summarizing posts:', error);
      throw error;
    }
  }

  async summarizeChats(): Promise<unknown> {
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);

      const chatSummaries = await Summary.aggregate([
        {
          $match: {
            type: 'chats',
            createdAt: { $gte: startTime, $lte: endTime },
            podId: { $ne: null },
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: '$podId',
            summary: { $first: '$$ROOT' },
          },
        },
        { $replaceRoot: { newRoot: '$summary' } },
      ]) as SummaryDoc[];

      if (chatSummaries.length === 0) {
        return await SummarizerService.createEmptySummary(
          'chats',
          'No new messages were exchanged in the last hour. Chats are quiet at the moment.',
        );
      }

      const content = chatSummaries
        .map((summary) => {
          const podName = summary.metadata?.podName || 'Unknown Pod';
          return `${podName}: ${summary.content}`;
        })
        .join('\n');

      const summaryText = await this.generateSummary(content, 'chats');

      const totalMessages = chatSummaries.reduce(
        (sum, s) => sum + (s.metadata?.totalItems || 0),
        0,
      );
      const allPods = chatSummaries.map((s) => s.metadata?.podName).filter(Boolean) as string[];
      const topPods = SummarizerService.getTopItems(allPods, 3);
      const allUsers = chatSummaries.flatMap((s) => s.metadata?.topUsers || []);
      const topUsers = SummarizerService.getTopItems(allUsers, 3);

      const title = SummarizerService.generateTitle('chats', totalMessages, topPods);

      return await Summary.create({
        type: 'chats',
        title,
        content: summaryText,
        timeRange: { start: startTime, end: endTime },
        metadata: { totalItems: totalMessages, topTags: topPods, topUsers },
      });
    } catch (error) {
      console.error('Error summarizing chats:', error);
      throw error;
    }
  }

  static async createEmptySummary(type: string, description: string): Promise<unknown> {
    const title = type === 'posts' ? 'No New Posts' : 'No Recent Activity';
    const content = `${description} No new activity detected in the last hour.`;

    return Summary.create({
      type,
      title,
      content,
      timeRange: {
        start: new Date(Date.now() - 60 * 60 * 1000),
        end: new Date(),
      },
      metadata: { totalItems: 0, topTags: [] },
    });
  }

  static getTopItems(items: string[], limit: number): string[] {
    const counts: Record<string, number> = {};
    items.forEach((item) => {
      counts[item] = (counts[item] || 0) + 1;
    });

    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([item]) => item);
  }

  static generateTitle(type: string, count: number, topItems: string[]): string {
    if (count === 0) {
      return type === 'posts' ? 'Quiet Hour' : 'Silent Chats';
    }

    const itemType = type === 'posts' ? 'post' : 'message';
    const countText = count === 1 ? `1 ${itemType}` : `${count} ${itemType}s`;

    if (topItems.length > 0) {
      const topItem = topItems[0];
      return type === 'posts'
        ? `${countText} • Trending: #${topItem}`
        : `${countText} • Active in ${topItem}`;
    }

    return `${countText} shared`;
  }

  static async getRecentSummaries(type: string | null, limit = 10): Promise<unknown[]> {
    try {
      const query = type ? { type } : {};

      const summaries = await Summary.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean() as unknown[];

      return summaries;
    } catch (error) {
      console.error('Error fetching recent summaries:', error);
      throw error;
    }
  }

  static async cleanOldSummaries(daysToKeep = 30): Promise<unknown> {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const result = await Summary.deleteMany({ createdAt: { $lt: cutoffDate } });
    console.log(`Cleaned up ${result.deletedCount} old summaries`);
    return result;
  }

  static async garbageCollectForDigest(): Promise<GarbageCollectResult> {
    try {
      const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const corruptedResult = await Summary.deleteMany({
        'metadata.totalItems': { $gt: 100000 },
      });

      if (corruptedResult.deletedCount > 0) {
        console.log(
          `Removed ${corruptedResult.deletedCount} corrupted summaries with unrealistic message counts`,
        );
      }

      const result = await Summary.deleteMany({
        createdAt: { $lt: cutoffDate },
        type: { $ne: 'daily-digest' },
      });

      console.log(
        `Garbage collected ${result.deletedCount} summaries older than 24 hours`,
      );
      return {
        deletedCount: result.deletedCount + corruptedResult.deletedCount,
        cutoffDate,
      };
    } catch (error) {
      console.error('Error during garbage collection:', error);
      throw error;
    }
  }

  async summarizeAllPosts(): Promise<AllPostsSummary> {
    try {
      const now = Date.now();
      const cache = SummarizerService.allPostsCache;
      if (cache.summary && now - cache.createdAt < 5 * 60 * 1000) {
        return cache.summary;
      }

      const posts = await Post.find({})
        .populate('userId', 'username')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean() as Array<Record<string, unknown>>;

      if (posts.length === 0) {
        return {
          title: 'No Posts Yet',
          content: "The community hasn't shared any posts yet. Be the first to start a conversation!",
          metadata: {
            totalItems: 0,
            topTags: [],
            topUsers: [],
            timeRange: 'All time',
          },
        };
      }

      const content = posts
        .map((post) => {
          const user = post.userId as Record<string, unknown> | null;
          const username = user?.username || 'Unknown';
          const tags = Array.isArray(post.tags) && post.tags.length ? ` #${(post.tags as string[]).join(' #')}` : '';
          return `@${username}: ${post.content}${tags}`;
        })
        .join('\n');

      const prompt = `You are creating a comprehensive overview of a community's posts.

Here are posts from the community (most recent first):
${content}

Please create an engaging 3-4 sentence community overview that:
- Captures the overall vibe and main topics of discussion
- Highlights the most popular themes and interests
- Shows what makes this community unique and active
- Uses an enthusiastic, welcoming tone

This is for new visitors to understand what the community is all about. Focus on the content and conversations, not just statistics.`;

      let summaryText: string;
      if (now < cache.cooldownUntil) {
        summaryText = SummarizerService.generateFallbackSummary(content, 'posts');
      } else {
        console.log('Generating all-posts summary with LLM...');
        summaryText = await generateText(prompt, { temperature: 0.4 }) as string;
        console.log(
          `✓ LLM returned all-posts summary: "${summaryText.substring(0, 100)}..."`,
        );
      }

      const allTags = posts.flatMap((post) => (post.tags as string[]) || []);
      const topTags = SummarizerService.getTopItems(allTags, 8);
      const topUsers = SummarizerService.getTopItems(
        posts.map((post) => {
          const user = post.userId as Record<string, unknown> | null;
          return user?.username as string;
        }).filter(Boolean),
        5,
      );

      const title = `Community Overview • ${posts.length} recent posts`;

      const summary: AllPostsSummary = {
        title,
        content: summaryText,
        metadata: {
          totalItems: posts.length,
          topTags,
          topUsers,
          timeRange: 'Recent posts',
        },
      };
      SummarizerService.allPostsCache = {
        summary,
        createdAt: now,
        cooldownUntil: cache.cooldownUntil,
      };
      return summary;
    } catch (error) {
      console.error('Error summarizing all posts:', error);

      const errMsg = String((error as Error)?.message || '');
      if (errMsg.includes('429') || errMsg.includes('Resource exhausted')) {
        SummarizerService.allPostsCache.cooldownUntil = Date.now() + 10 * 60 * 1000;
      }

      const postCount = await Post.find({}).countDocuments() as number;
      const summary: AllPostsSummary = {
        title: `Community Overview • ${Math.min(postCount, 10)} recent posts`,
        content: 'Our community has shared various thoughts, ideas, and discussions. Join the conversation and see what everyone is talking about!',
        metadata: {
          totalItems: Math.min(postCount, 10),
          topTags: [],
          topUsers: [],
          timeRange: 'Recent posts',
        },
      };
      SummarizerService.allPostsCache = {
        summary,
        createdAt: Date.now(),
        cooldownUntil: SummarizerService.allPostsCache.cooldownUntil,
      };
      return summary;
    }
  }
}

SummarizerService.allPostsCache = {
  summary: null,
  createdAt: 0,
  cooldownUntil: 0,
} as AllPostsCache;

// Add static property type declaration
declare namespace SummarizerService {
  // eslint-disable-next-line no-var
  var allPostsCache: AllPostsCache;
}

export default new SummarizerService();
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
