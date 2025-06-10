const { GoogleGenerativeAI } = require('@google/generative-ai');
const { pool } = require('../config/db-pg');
const Summary = require('../models/Summary');
const Pod = require('../models/Pod');

class ChatSummarizerService {
  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  }

  async generateSummary(content, podName) {
    try {
      const prompt = ChatSummarizerService.createPrompt(content, podName);
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      console.error('Error generating chat summary with Gemini:', error);
      return ChatSummarizerService.generateFallbackSummary(content, podName);
    }
  }

  static createPrompt(content, podName) {
    return `Analyze the following chat messages from the "${podName}" community chat and create a brief, engaging summary. Focus on main discussion topics, popular conversations, and community interactions. Make it conversational and informative:

${content}

Provide a summary in 2-3 sentences that captures the essence of the conversations in this chat room.`;
  }

  static generateFallbackSummary(content, podName) {
    const messageCount = content.split('\n')
      .filter((line) => line.trim()).length;
    return `${messageCount} messages were exchanged in ${podName}, featuring active conversations and community interactions.`;
  }

  static async getActivePods() {
    try {
      // Get pods that have had activity in the last hour
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000); // 1 hour ago

      const query = `
        SELECT DISTINCT m.pod_id
        FROM messages m
        WHERE m.created_at >= $1 AND m.created_at <= $2
      `;

      const result = await pool.query(query, [startTime, endTime]);
      return result.rows.map((row) => row.pod_id);
    } catch (error) {
      console.error('Error getting active pods:', error);
      return [];
    }
  }

  async summarizePodMessages(podId) {
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000); // 1 hour ago

      // Get messages from PostgreSQL
      const query = `
        SELECT 
          m.content,
          m.message_type,
          m.created_at,
          u.username
        FROM messages m
        LEFT JOIN users u ON m.user_id = u._id
        WHERE m.pod_id = $1 
          AND m.created_at >= $2 
          AND m.created_at <= $3
          AND m.message_type = 'text'
        ORDER BY m.created_at ASC
      `;

      const messagesResult = await pool.query(query, [podId, startTime, endTime]);
      const messages = messagesResult.rows;

      // Get pod info from MongoDB
      const pod = await Pod.findById(podId).lean();
      if (!pod) {
        console.warn(`Pod ${podId} not found in MongoDB`);
        return null;
      }

      if (messages.length === 0) {
        return ChatSummarizerService.createEmptySummary(podId, pod.name, startTime, endTime);
      }

      // Prepare content for summarization
      const content = messages.map((message) => {
        const username = message.username || 'Unknown';
        return `@${username}: ${message.content}`;
      }).join('\n');

      const summaryText = await this.generateSummary(content, pod.name);

      // Extract metadata
      const topUsers = ChatSummarizerService.getTopItems(
        messages.map((msg) => msg.username).filter(Boolean),
        3,
      );

      const title = ChatSummarizerService.generateTitle(pod.name, messages.length, topUsers);

      // Store summary in MongoDB
      return Summary.create({
        type: 'chats',
        podId,
        title,
        content: summaryText,
        timeRange: { start: startTime, end: endTime },
        metadata: {
          totalItems: messages.length,
          topTags: [], // Chat summaries don't use tags
          topUsers,
          podName: pod.name,
        },
      });
    } catch (error) {
      console.error(`Error summarizing pod ${podId}:`, error);
      throw error;
    }
  }

  static async createEmptySummary(podId, podName, startTime, endTime) {
    const title = 'Quiet Hour';
    const content = `No new messages were exchanged in ${podName} during the last hour. The chat is peaceful at the moment.`;

    return Summary.create({
      type: 'chats',
      podId,
      title,
      content,
      timeRange: { start: startTime, end: endTime },
      metadata: {
        totalItems: 0,
        topTags: [],
        topUsers: [],
        podName,
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

  static generateTitle(podName, count, topUsers) {
    if (count === 0) {
      return 'Quiet Hour';
    }

    const countText = count === 1 ? '1 message' : `${count} messages`;

    if (topUsers.length > 0) {
      const topUser = topUsers[0];
      return `${countText} in ${podName} • Active: @${topUser}`;
    }

    return `${countText} in ${podName}`;
  }

  async summarizeAllActiveChats() {
    try {
      const activePodIds = await ChatSummarizerService.getActivePods();

      if (activePodIds.length === 0) {
        console.log('No active chat pods found in the last hour');
        return [];
      }

      console.log(`Found ${activePodIds.length} active chat pods`);

      // Process all pods in parallel
      const summaryPromises = activePodIds.map((podId) => this.summarizePodMessages(podId).catch((error) => {
        console.error(`Failed to summarize pod ${podId}:`, error);
        return null;
      }));

      const summaries = await Promise.all(summaryPromises);
      const successfulSummaries = summaries.filter((summary) => summary !== null);

      console.log(`Successfully created ${successfulSummaries.length} chat summaries`);
      return successfulSummaries;
    } catch (error) {
      console.error('Error summarizing all active chats:', error);
      throw error;
    }
  }

  static async getRecentChatSummaries(limit = 5) {
    try {
      const summaries = await Summary.find({
        type: 'chats',
        podId: { $exists: true },
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      return summaries;
    } catch (error) {
      console.error('Error fetching recent chat summaries:', error);
      throw error;
    }
  }

  static async getRecentChatSummariesByPodType(podType, limit = 5) {
    try {
      // First get pod IDs of the requested type
      const pods = await Pod.find({ type: podType }).select('_id').lean();
      const podIds = pods.map((pod) => pod._id);

      if (podIds.length === 0) {
        return [];
      }

      // Get summaries for those pods, ensuring uniqueness by latest per pod
      const pipeline = [
        {
          $match: {
            type: 'chats',
            podId: { $in: podIds },
          },
        },
        {
          $sort: { createdAt: -1 },
        },
        {
          $group: {
            _id: '$podId',
            latestSummary: { $first: '$$ROOT' },
          },
        },
        {
          $replaceRoot: { newRoot: '$latestSummary' },
        },
        {
          $sort: { createdAt: -1 },
        },
        {
          $limit: limit,
        },
      ];

      const summaries = await Summary.aggregate(pipeline);
      return summaries;
    } catch (error) {
      console.error(`Error fetching ${podType} room summaries:`, error);
      throw error;
    }
  }

  static async getLatestChatSummary() {
    try {
      const summary = await Summary.findOne({
        type: 'chats',
        podId: { $exists: true },
      })
        .sort({ timeRange: -1 })
        .lean();

      return summary;
    } catch (error) {
      console.error('Error fetching latest chat summary:', error);
      throw error;
    }
  }

  static async getLatestPodSummary(podId) {
    try {
      const summary = await Summary.findOne({
        type: 'chats',
        podId,
      })
        .sort({ createdAt: -1 })
        .lean();

      return summary;
    } catch (error) {
      console.error(`Error fetching latest summary for pod ${podId}:`, error);
      throw error;
    }
  }

  static async getMultiplePodSummaries(podIds) {
    try {
      const summaries = await Summary.find({
        type: 'chats',
        podId: { $in: podIds },
      })
        .sort({ createdAt: -1 })
        .lean();

      // Group by podId and get the latest for each
      const latestSummaries = {};
      summaries.forEach((summary) => {
        const podId = summary.podId.toString();
        if (!latestSummaries[podId]
            || summary.createdAt > latestSummaries[podId].createdAt) {
          latestSummaries[podId] = summary;
        }
      });

      return latestSummaries;
    } catch (error) {
      console.error('Error fetching multiple pod summaries:', error);
      throw error;
    }
  }
}

module.exports = new ChatSummarizerService();
