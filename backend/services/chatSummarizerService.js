const { pool } = require('../config/db-pg');
const Summary = require('../models/Summary');
const Pod = require('../models/Pod');
const PodAssetService = require('./podAssetService');
const { generateText } = require('./llmService');

class ChatSummarizerService {
  constructor() {}

  async generateSummary(content, podName) {
    try {
      const prompt = ChatSummarizerService.createPrompt(content, podName);
      return await generateText(prompt, { temperature: 0.4 });
    } catch (error) {
      console.error('Error generating chat summary with LLM:', error);
      return ChatSummarizerService.generateFallbackSummary(content, podName);
    }
  }

  async generateEnhancedSummary(content, podName, messages) {
    try {
      const prompt = ChatSummarizerService.createEnhancedPrompt(
        content,
        podName,
      );
      const responseText = await generateText(prompt, { temperature: 0.2 });

      // Parse the JSON response
      let analyticsData;
      try {
        analyticsData = JSON.parse(responseText);
      } catch (parseError) {
        console.warn(
          'Failed to parse enhanced summary JSON, falling back to basic summary:',
          parseError,
        );
        return {
          summary: await this.generateSummary(content, podName),
          analytics: ChatSummarizerService.generateFallbackAnalytics(
            messages,
            podName,
          ),
        };
      }

      return {
        summary: analyticsData.summary,
        analytics: analyticsData,
      };
    } catch (error) {
      console.error(
        'Error generating enhanced chat summary with Gemini:',
        error,
      );
      return {
        summary: ChatSummarizerService.generateFallbackSummary(
          content,
          podName,
        ),
        analytics: ChatSummarizerService.generateFallbackAnalytics(
          messages,
          podName,
        ),
      };
    }
  }

  static generateFallbackAnalytics(messages, _podName) {
    const userCounts = {};
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

  static createPrompt(content, podName) {
    return `Analyze the following chat messages from the "${podName}" community chat and create a brief, engaging summary.
Focus on main discussion topics, popular conversations, and community interactions.
Make it conversational and informative:

${content}

Provide a summary in 2-3 sentences that captures the essence of the conversations in this chat room.`;
  }

  static createEnhancedPrompt(content, podName) {
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
      "event": "type of event (peak_activity, topic_shift, new_participant, heated_discussion, etc.)",
      "description": "What happened during this event",
      "participants": ["list of usernames involved"],
      "intensity": 1-10
    }
  ],
  "quotes": [
    {
      "text": "The actual quote text",
      "author": "username",
      "timestamp": "ISO timestamp",
      "context": "What was being discussed when this was said",
      "sentiment": "positive/negative/neutral/humorous/insightful",
      "reactions": 0
    }
  ],
  "insights": [
    {
      "type": "trend/sentiment_shift/new_topic/consensus/disagreement/revelation",
      "description": "Description of the insight",
      "confidence": 0.0-1.0,
      "impact": "low/medium/high",
      "participants": ["usernames involved"],
      "timestamp": "ISO timestamp"
    }
  ],
  "atmosphere": {
    "overall_sentiment": "very_positive/positive/neutral/negative/very_negative",
    "energy_level": "very_low/low/medium/high/very_high",
    "engagement_quality": "superficial/moderate/deep/intense",
    "community_cohesion": 0.0-1.0,
    "topics_diversity": 0.0-1.0,
    "dominant_emotions": ["happiness", "excitement", "concern", "curiosity"]
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
      "peak_hours": [14, 15, 20],
      "discussion_length_avg": 4.5,
      "response_time_avg": 2.3
    }
  },
  "keywords": {
    "main_topics": [
      {
        "keyword": "discussion topic or keyword",
        "frequency": 12,
        "sentiment": "positive/negative/neutral",
        "context": "How this keyword was used in discussions",
        "related_users": ["usernames who mentioned this"],
        "trending": true
      }
    ],
    "trending_phrases": [
      {
        "phrase": "multi-word phrase or concept",
        "frequency": 8,
        "first_mentioned": "ISO timestamp",
        "context": "Context where this phrase emerged"
      }
    ],
    "topic_clusters": [
      {
        "cluster_name": "General topic area",
        "keywords": ["related", "keywords", "in", "cluster"],
        "message_count": 15,
        "participants": ["usernames involved in this topic"]
      }
    ]
  }
}

Focus on extracting meaningful insights, notable quotes, discussion pivots, and community dynamics.
Be analytical but concise.`;
  }

  static generateFallbackSummary(content, podName) {
    const messageCount = content
      .split('\n')
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

      const messagesResult = await pool.query(query, [
        podId,
        startTime,
        endTime,
      ]);
      const messages = messagesResult.rows;

      // Get pod info from MongoDB
      const pod = await Pod.findById(podId).lean();
      if (!pod) {
        console.warn(`Pod ${podId} not found in MongoDB`);
        return null;
      }

      // Validate message count is reasonable (prevent data corruption)
      if (messages.length > 10000) {
        console.error(
          `Suspicious message count ${messages.length} for pod ${podId} in 1 hour - skipping summarization`,
        );
        return null;
      }

      if (messages.length === 0) {
        return ChatSummarizerService.createEmptySummary(
          podId,
          pod.name,
          startTime,
          endTime,
        );
      }

      // Prepare content for summarization
      const content = messages
        .map((message) => {
          const username = message.username || 'Unknown';
          return `@${username}: ${message.content}`;
        })
        .join('\n');

      const summaryText = await this.generateSummary(content, pod.name);

      // Extract metadata
      const topUsers = ChatSummarizerService.getTopItems(
        messages.map((msg) => msg.username).filter(Boolean),
        3,
      );

      const title = ChatSummarizerService.generateTitle(
        pod.name,
        messages.length,
        topUsers,
      );

      // Validate pod name exists
      if (!pod.name) {
        console.error(`Pod ${podId} has no name - skipping summarization`);
        return null;
      }

      // Store summary in MongoDB
      const summary = await Summary.create({
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

  static async createEmptySummary(podId, podName, startTime, endTime) {
    const title = 'Quiet Hour';
    const content = `No new messages were exchanged in ${podName} during the last hour. The chat is peaceful at the moment.`;

    const summary = await Summary.create({
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

    try {
      await PodAssetService.createChatSummaryAsset({ podId, summary });
    } catch (assetError) {
      console.error('Failed to persist pod asset for empty summary:', assetError);
    }

    return summary;
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
      const successfulSummaries = summaries.filter(
        (summary) => summary !== null,
      );

      console.log(
        `Successfully created ${successfulSummaries.length} chat summaries`,
      );
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
        if (
          !latestSummaries[podId]
          || summary.createdAt > latestSummaries[podId].createdAt
        ) {
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
