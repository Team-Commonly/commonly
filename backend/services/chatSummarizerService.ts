// eslint-disable-next-line global-require
const { pool } = require('../config/db-pg');
// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const PodAssetService = require('./podAssetService');
// eslint-disable-next-line global-require
const { generateText } = require('./llmService');

interface MessageRow {
  content?: string;
  message_type?: string;
  created_at?: Date;
  username?: string;
}

interface FallbackAnalyticsResult {
  timeline: unknown[];
  quotes: unknown[];
  insights: unknown[];
  atmosphere: Record<string, unknown>;
  participation: Record<string, unknown>;
}

interface EnhancedSummaryResult {
  summary: string;
  analytics: FallbackAnalyticsResult | Record<string, unknown>;
}

class ChatSummarizerService {
  async generateSummary(content: string, podName: string): Promise<string> {
    try {
      const prompt = ChatSummarizerService.createPrompt(content, podName);
      return await generateText(prompt, { temperature: 0.4 }) as string;
    } catch (error) {
      console.error('Error generating chat summary with LLM:', error);
      return ChatSummarizerService.generateFallbackSummary(content, podName);
    }
  }

  async generateEnhancedSummary(
    content: string,
    podName: string,
    messages: MessageRow[],
  ): Promise<EnhancedSummaryResult> {
    try {
      const prompt = ChatSummarizerService.createEnhancedPrompt(content, podName);
      const responseText = await generateText(prompt, { temperature: 0.2 }) as string;

      let analyticsData: Record<string, unknown>;
      try {
        analyticsData = JSON.parse(responseText) as Record<string, unknown>;
      } catch (parseError) {
        console.warn(
          'Failed to parse enhanced summary JSON, falling back to basic summary:',
          parseError,
        );
        return {
          summary: await this.generateSummary(content, podName),
          analytics: ChatSummarizerService.generateFallbackAnalytics(messages, podName),
        };
      }

      return {
        summary: analyticsData.summary as string,
        analytics: analyticsData,
      };
    } catch (error) {
      console.error('Error generating enhanced chat summary with Gemini:', error);
      return {
        summary: ChatSummarizerService.generateFallbackSummary(content, podName),
        analytics: ChatSummarizerService.generateFallbackAnalytics(messages, podName),
      };
    }
  }

  static generateFallbackAnalytics(messages: MessageRow[], _podName: string): FallbackAnalyticsResult {
    const userCounts: Record<string, number> = {};
    messages.forEach((msg) => {
      if (msg.username) {
        userCounts[msg.username] = (userCounts[msg.username] || 0) + 1;
      }
    });

    const sortedUsers = Object.entries(userCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);

    return {
      timeline: [],
      quotes: [],
      insights: [],
      atmosphere: {
        overall_sentiment: 'neutral',
        energy_level: messages.length > 10 ? 'medium' : 'low',
        engagement_quality: 'moderate',
        community_cohesion: 0.5,
        topics_diversity: 0.5,
        dominant_emotions: ['neutral'],
      },
      participation: {
        most_active_users: sortedUsers.map(([username, count]) => ({
          username,
          message_count: count,
          engagement_score: Math.min(count / messages.length, 1),
          role: 'contributor',
        })),
        engagement_patterns: {
          peak_hours: [],
          discussion_length_avg: messages.length,
          response_time_avg: 5,
        },
      },
    };
  }

  static createPrompt(content: string, podName: string): string {
    return `Analyze the following chat messages from the "${podName}" community chat and create a brief, engaging summary.
Focus on main discussion topics, popular conversations, and community interactions.
Make it conversational and informative:

${content}

Provide a summary in 2-3 sentences that captures the essence of the conversations in this chat room.`;
  }

  static createEnhancedPrompt(content: string, podName: string): string {
    return `You are an AI community analyst tasked with creating a comprehensive analysis of chat messages from the "${podName}" community.
Analyze the following messages and extract detailed insights for a daily digest.

Chat Messages:
${content}

Please provide a JSON response with the following structure:

{
  "summary": "2-3 sentence summary of the main discussions",
  "timeline": [
    {
      "timestamp": "ISO timestamp of the event",
      "event": "type of event",
      "description": "What happened during this event",
      "participants": ["list of usernames involved"],
      "intensity": 1
    }
  ],
  "quotes": [
    {
      "text": "The actual quote text",
      "author": "username",
      "timestamp": "ISO timestamp",
      "context": "Context",
      "sentiment": "positive/negative/neutral/humorous/insightful",
      "reactions": 0
    }
  ],
  "insights": [
    {
      "type": "trend/sentiment_shift/new_topic/consensus/disagreement/revelation",
      "description": "Description of the insight",
      "confidence": 0.5,
      "impact": "low/medium/high",
      "participants": ["usernames involved"],
      "timestamp": "ISO timestamp"
    }
  ],
  "atmosphere": {
    "overall_sentiment": "very_positive/positive/neutral/negative/very_negative",
    "energy_level": "very_low/low/medium/high/very_high",
    "engagement_quality": "superficial/moderate/deep/intense",
    "community_cohesion": 0.5,
    "topics_diversity": 0.5,
    "dominant_emotions": ["happiness", "excitement"]
  },
  "participation": {
    "most_active_users": [
      {
        "username": "username",
        "message_count": 5,
        "engagement_score": 0.8,
        "role": "moderator/contributor/lurker/newcomer"
      }
    ],
    "engagement_patterns": {
      "peak_hours": [14, 15],
      "discussion_length_avg": 4.5,
      "response_time_avg": 2.3
    }
  }
}

Focus on extracting meaningful insights, notable quotes, discussion pivots, and community dynamics.`;
  }

  static generateFallbackSummary(content: string, podName: string): string {
    const messageCount = content.split('\n').filter((line) => line.trim()).length;
    return `${messageCount} messages were exchanged in ${podName}, featuring active conversations and community interactions.`;
  }

  static async getActivePods(): Promise<string[]> {
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);

      const query = `
        SELECT DISTINCT m.pod_id
        FROM messages m
        WHERE m.created_at >= $1 AND m.created_at <= $2
      `;

      const result = await pool.query(query, [startTime, endTime]) as { rows: Array<{ pod_id: string }> };
      return result.rows.map((row) => row.pod_id);
    } catch (error) {
      console.error('Error getting active pods:', error);
      return [];
    }
  }

  async summarizePodMessages(podId: string): Promise<unknown> {
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);

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

      const messagesResult = await pool.query(query, [podId, startTime, endTime]) as { rows: MessageRow[] };
      const messages = messagesResult.rows;

      const pod = await Pod.findById(podId).lean() as { name?: string } | null;
      if (!pod) {
        console.warn(`Pod ${podId} not found in MongoDB`);
        return null;
      }

      if (messages.length > 10000) {
        console.error(
          `Suspicious message count ${messages.length} for pod ${podId} in 1 hour - skipping summarization`,
        );
        return null;
      }

      if (messages.length === 0) {
        return ChatSummarizerService.createEmptySummary(podId, pod.name || '', startTime, endTime);
      }

      const content = messages
        .map((message) => {
          const username = message.username || 'Unknown';
          return `@${username}: ${message.content}`;
        })
        .join('\n');

      const summaryText = await this.generateSummary(content, pod.name || '');

      const topUsers = ChatSummarizerService.getTopItems(
        messages.map((msg) => msg.username || '').filter(Boolean),
        3,
      );

      const title = ChatSummarizerService.generateTitle(pod.name || '', messages.length, topUsers);

      if (!pod.name) {
        console.error(`Pod ${podId} has no name - skipping summarization`);
        return null;
      }

      const summary = await Summary.create({
        type: 'chats',
        podId,
        title,
        content: summaryText,
        timeRange: { start: startTime, end: endTime },
        metadata: {
          totalItems: messages.length,
          topTags: [],
          topUsers,
          podName: pod.name,
        },
      });

      try {
        await PodAssetService.createChatSummaryAsset({ podId, summary });
      } catch (assetError) {
        console.error('Failed to persist pod asset for chat summary:', assetError);
      }

      return summary;
    } catch (error) {
      console.error(`Error summarizing pod ${podId}:`, error);
      throw error;
    }
  }

  static async createEmptySummary(
    podId: string,
    podName: string,
    startTime: Date,
    endTime: Date,
  ): Promise<unknown> {
    const title = 'Quiet Hour';
    const content = `No new messages were exchanged in ${podName} during the last hour. The chat is peaceful at the moment.`;

    const summary = await Summary.create({
      type: 'chats',
      podId,
      title,
      content,
      timeRange: { start: startTime, end: endTime },
      metadata: { totalItems: 0, topTags: [], topUsers: [], podName },
    });

    try {
      await PodAssetService.createChatSummaryAsset({ podId, summary });
    } catch (assetError) {
      console.error('Failed to persist pod asset for empty summary:', assetError);
    }

    return summary;
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

  static generateTitle(podName: string, count: number, topUsers: string[]): string {
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

  async summarizeAllActiveChats(): Promise<unknown[]> {
    try {
      const activePodIds = await ChatSummarizerService.getActivePods();

      if (activePodIds.length === 0) {
        console.log('No active chat pods found in the last hour');
        return [];
      }

      console.log(`Found ${activePodIds.length} active chat pods`);

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

  static async getRecentChatSummaries(limit = 5): Promise<unknown[]> {
    try {
      const summaries = await Summary.find({
        type: 'chats',
        podId: { $exists: true },
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean() as unknown[];

      return summaries;
    } catch (error) {
      console.error('Error fetching recent chat summaries:', error);
      throw error;
    }
  }

  static async getRecentChatSummariesByPodType(podType: string, limit = 5): Promise<unknown[]> {
    try {
      const pods = await Pod.find({ type: podType }).select('_id').lean() as Array<{ _id: unknown }>;
      const podIds = pods.map((pod) => pod._id);

      if (podIds.length === 0) {
        return [];
      }

      const pipeline = [
        { $match: { type: 'chats', podId: { $in: podIds } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$podId', latestSummary: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$latestSummary' } },
        { $sort: { createdAt: -1 } },
        { $limit: limit },
        {
          $lookup: {
            from: 'pods',
            localField: 'podId',
            foreignField: '_id',
            as: '_pod',
          },
        },
        {
          $set: {
            'metadata.podName': {
              $ifNull: ['$metadata.podName', { $arrayElemAt: ['$_pod.name', 0] }],
            },
          },
        },
        { $unset: '_pod' },
      ];

      const summaries = await Summary.aggregate(pipeline) as unknown[];
      return summaries;
    } catch (error) {
      console.error(`Error fetching ${podType} room summaries:`, error);
      throw error;
    }
  }

  static async getLatestChatSummary(): Promise<unknown> {
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

  static async getLatestPodSummary(podId: unknown): Promise<unknown> {
    try {
      const summary = await Summary.findOne({ type: 'chats', podId })
        .sort({ createdAt: -1 })
        .lean();

      return summary;
    } catch (error) {
      console.error(`Error fetching latest summary for pod ${podId}:`, error);
      throw error;
    }
  }

  async getMultiplePodSummaries(podIds: unknown[]): Promise<Record<string, unknown>> {
    try {
      const summaries = await Summary.find({
        type: 'chats',
        podId: { $in: podIds },
      })
        .sort({ createdAt: -1 })
        .lean() as Array<Record<string, unknown>>;

      const latestSummaries: Record<string, Record<string, unknown>> = {};
      summaries.forEach((summary) => {
        const podId = String(summary.podId);
        const existing = latestSummaries[podId];
        if (!existing || (summary.createdAt as Date) > (existing.createdAt as Date)) {
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

export default new ChatSummarizerService();
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
