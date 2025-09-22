const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');
const Summary = require('../models/Summary');
const Post = require('../models/Post');
// const User = require('../models/User'); // Unused import, commented out

// Add fetch polyfill for Node.js
if (!global.fetch) {
  global.fetch = fetch;
}

class SummarizerService {
  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  }

  async generateSummary(content, type) {
    try {
      console.log(`Generating ${type} summary with Gemini API...`);
      const prompt = SummarizerService.createPrompt(content, type);
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const summaryText = response.text();
      console.log(
        `✓ Gemini API returned summary for ${type}: "${summaryText.substring(0, 100)}..."`,
      );
      return summaryText;
    } catch (error) {
      console.error('Error generating summary with Gemini:', error);
      console.log(`Falling back to simple summary for ${type}`);
      return SummarizerService.generateFallbackSummary(content, type);
    }
  }

  static createPrompt(content, type) {
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

  static generateFallbackSummary(content, type) {
    const itemCount = content.split('\n').filter((line) => line.trim()).length;
    return type === 'posts'
      ? `${itemCount} posts were shared in the last hour, covering various topics and discussions in the community.`
      : `Activity in ${itemCount} chat rooms with various conversations and community interactions.`;
  }

  async summarizePosts() {
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000); // 1 hour ago

      const posts = await Post.find({
        createdAt: { $gte: startTime, $lte: endTime },
      })
        .populate('userId', 'username')
        .lean();

      if (posts.length === 0) {
        return await SummarizerService.createEmptySummary(
          'posts',
          'No new posts were shared in the last hour. The community is taking a peaceful break.',
        );
      }

      // Prepare content for summarization
      const content = posts
        .map((post) => {
          const username = post.userId?.username || 'Unknown';
          const tags = post.tags?.length ? ` #${post.tags.join(' #')}` : '';
          return `@${username}: ${post.content}${tags}`;
        })
        .join('\n');

      const summaryText = await this.generateSummary(content, 'posts');

      // Extract metadata
      const allTags = posts.flatMap((post) => post.tags || []);
      const topTags = SummarizerService.getTopItems(allTags, 5);
      const topUsers = SummarizerService.getTopItems(
        posts.map((post) => post.userId?.username).filter(Boolean),
        3,
      );

      const title = SummarizerService.generateTitle(
        'posts',
        posts.length,
        topTags,
      );

      return await Summary.create({
        type: 'posts',
        title,
        content: summaryText,
        timeRange: { start: startTime, end: endTime },
        metadata: {
          totalItems: posts.length,
          topTags,
          topUsers,
        },
      });
    } catch (error) {
      console.error('Error summarizing posts:', error);
      throw error;
    }
  }

  async summarizeChats() {
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000); // 1 hour ago

      // Get chat summaries from MongoDB (created by chatSummarizerService)
      const chatSummaries = await Summary.find({
        type: 'chats',
        createdAt: { $gte: startTime, $lte: endTime },
      }).lean();

      if (chatSummaries.length === 0) {
        return await SummarizerService.createEmptySummary(
          'chats',
          'No new messages were exchanged in the last hour. Chats are quiet at the moment.',
        );
      }

      // Prepare content for overall chat summarization
      const content = chatSummaries
        .map((summary) => {
          const podName = summary.metadata?.podName || 'Unknown Pod';
          return `${podName}: ${summary.content}`;
        })
        .join('\n');

      const summaryText = await this.generateSummary(content, 'chats');

      // Extract metadata from individual chat summaries
      const totalMessages = chatSummaries.reduce(
        (sum, s) => sum + (s.metadata?.totalItems || 0),
        0,
      );
      const allPods = chatSummaries
        .map((s) => s.metadata?.podName)
        .filter(Boolean);
      const topPods = SummarizerService.getTopItems(allPods, 3);
      const allUsers = chatSummaries.flatMap((s) => s.metadata?.topUsers || []);
      const topUsers = SummarizerService.getTopItems(allUsers, 3);

      const title = SummarizerService.generateTitle(
        'chats',
        totalMessages,
        topPods,
      );

      return await Summary.create({
        type: 'chats',
        title,
        content: summaryText,
        timeRange: { start: startTime, end: endTime },
        metadata: {
          totalItems: totalMessages,
          topTags: topPods, // Using pods as "tags" for chats
          topUsers,
        },
      });
    } catch (error) {
      console.error('Error summarizing chats:', error);
      throw error;
    }
  }

  static async createEmptySummary(type, description) {
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
      metadata: {
        totalItems: 0,
        topTags: [],
      },
    });
  }

  static getTopItems(items, limit) {
    const counts = {};
    items.forEach((item) => {
      counts[item] = (counts[item] || 0) + 1;
    });

    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([item]) => item);
  }

  static generateTitle(type, count, topItems) {
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

  static async getRecentSummaries(type, limit = 10) {
    try {
      const query = type ? { type } : {};

      const summaries = await Summary.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      return summaries;
    } catch (error) {
      console.error('Error fetching recent summaries:', error);
      throw error;
    }
  }

  static async cleanOldSummaries(daysToKeep = 30) {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const result = await Summary.deleteMany({ createdAt: { $lt: cutoffDate } });
    console.log(`Cleaned up ${result.deletedCount} old summaries`);
    return result;
  }

  /**
   * Garbage collection for daily digest preparation
   * Keeps 24 hours of summaries for daily digest generation, removes older ones
   */
  static async garbageCollectForDigest() {
    try {
      const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

      // Clean up corrupted summaries with unrealistic message counts
      const corruptedResult = await Summary.deleteMany({
        'metadata.totalItems': { $gt: 100000 }, // Remove summaries with >100k messages (clearly corrupted)
      });

      if (corruptedResult.deletedCount > 0) {
        console.log(
          `🗑️  Removed ${corruptedResult.deletedCount} corrupted summaries with unrealistic message counts`,
        );
      }

      // Keep summaries from last 24 hours for daily digest
      // Remove summaries older than 24 hours (except daily digest summaries)
      const result = await Summary.deleteMany({
        createdAt: { $lt: cutoffDate },
        type: { $ne: 'daily-digest' }, // Don't delete daily digest summaries
      });

      console.log(
        `🗑️  Garbage collected ${result.deletedCount} summaries older than 24 hours`,
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

  async summarizeAllPosts() {
    try {
      // Get all posts from the database (limited to recent ones for performance)
      const posts = await Post.find({})
        .populate('userId', 'username')
        .sort({ createdAt: -1 })
        .limit(100) // Limit to 100 most recent posts for performance
        .lean();

      if (posts.length === 0) {
        return {
          title: 'No Posts Yet',
          content:
            "The community hasn't shared any posts yet. Be the first to start a conversation!",
          metadata: {
            totalItems: 0,
            topTags: [],
            topUsers: [],
            timeRange: 'All time',
          },
        };
      }

      // Prepare content for summarization
      const content = posts
        .map((post) => {
          const username = post.userId?.username || 'Unknown';
          const tags = post.tags?.length ? ` #${post.tags.join(' #')}` : '';
          return `@${username}: ${post.content}${tags}`;
        })
        .join('\n');

      // Use a special prompt for all-time summary
      const prompt = `You are creating a comprehensive overview of a community's posts. 

Here are posts from the community (most recent first):
${content}

Please create an engaging 3-4 sentence community overview that:
- Captures the overall vibe and main topics of discussion
- Highlights the most popular themes and interests
- Shows what makes this community unique and active
- Uses an enthusiastic, welcoming tone

This is for new visitors to understand what the community is all about. Focus on the content and conversations, not just statistics.`;

      console.log('Generating all-posts summary with Gemini API...');
      const result = await this.genAI
        .getGenerativeModel({ model: 'gemini-2.0-flash' })
        .generateContent(prompt);
      const response = await result.response;
      const summaryText = response.text();
      console.log(
        `✓ Gemini API returned all-posts summary: "${summaryText.substring(0, 100)}..."`,
      );

      // Extract metadata
      const allTags = posts.flatMap((post) => post.tags || []);
      const topTags = SummarizerService.getTopItems(allTags, 8);
      const topUsers = SummarizerService.getTopItems(
        posts.map((post) => post.userId?.username).filter(Boolean),
        5,
      );

      // Generate title for all posts
      const title = `Community Overview • ${posts.length} posts`;

      return {
        title,
        content: summaryText,
        metadata: {
          totalItems: posts.length,
          topTags,
          topUsers,
          timeRange: 'All time',
        },
      };
    } catch (error) {
      console.error('Error summarizing all posts:', error);

      // Fallback if Gemini fails
      const posts = await Post.find({}).countDocuments();
      return {
        title: `Community Overview • ${posts} posts`,
        content:
          'Our community has shared various thoughts, ideas, and discussions. Join the conversation and see what everyone is talking about!',
        metadata: {
          totalItems: posts,
          topTags: [],
          topUsers: [],
          timeRange: 'All time',
        },
      };
    }
  }
}

module.exports = new SummarizerService();
