const { GoogleGenerativeAI } = require('@google/generative-ai');
const Summary = require('../models/Summary');
const _Pod = require('../models/Pod');
const User = require('../models/User');
const DigestTemplateService = require('./digestTemplateService');

/**
 * Daily Digest Service
 * Generates comprehensive daily newsletters and insights for users
 * based on 24 hours of accumulated summary data
 */
class DailyDigestService {
  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  }

  /**
   * Generate daily digest for a specific user based on their subscribed pods
   */
  async generateUserDailyDigest(userId) {
    try {
      console.log(`Generating daily digest for user ${userId}`);

      // Get user and their subscribed pods
      const user = await User.findById(userId)
        .populate('subscribedPods')
        .lean();
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago

      // Get all summaries from the last 24 hours for user's subscribed pods
      const podIds = user.subscribedPods?.map((pod) => pod._id) || [];

      const summaries = await Summary.find({
        $or: [
          { podId: { $in: podIds } }, // Pod-specific summaries
          { type: 'posts' }, // General post summaries
          { type: 'chats', podId: { $exists: false } }, // Overall chat summaries
        ],
        createdAt: { $gte: startTime, $lte: endTime },
      })
        .populate('podId', 'name type')
        .sort({ createdAt: 1 })
        .lean();

      if (summaries.length === 0) {
        return DailyDigestService.createEmptyDigest(user, startTime, endTime);
      }

      // Organize summaries by pod and type
      const organizedData = DailyDigestService.organizeSummariesForDigest(summaries);

      // Generate comprehensive digest using AI
      const digestContent = await this.generateDigestContent(
        organizedData,
        user,
      );

      // Extract key insights across all conversations
      const insights = DailyDigestService.extractCrossConversationInsights(summaries);

      // Create and save daily digest summary
      const digestSummary = await Summary.create({
        type: 'daily-digest',
        title: `Daily Digest for ${user.username} - ${endTime.toDateString()}`,
        content: digestContent,
        timeRange: { start: startTime, end: endTime },
        metadata: {
          totalItems: summaries.length,
          topTags: insights.topTags,
          topUsers: insights.topUsers,
          subscribedPods: podIds.length,
          userId: userId.toString(),
        },
        analytics: {
          timeline: insights.timeline,
          quotes: insights.bestQuotes,
          insights: insights.keyInsights,
          atmosphere: insights.overallAtmosphere,
          participation: insights.participationOverview,
        },
      });

      console.log(`✓ Generated daily digest for ${user.username}`);
      return digestSummary;
    } catch (error) {
      console.error(`Error generating daily digest for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Organize summaries by pod and extract timeline
   */
  static organizeSummariesForDigest(summaries) {
    const byPod = {};
    const timeline = [];

    summaries.forEach((summary) => {
      const podName = summary.podId?.name || 'General';
      const podType = summary.podId?.type || summary.type;

      if (!byPod[podName]) {
        byPod[podName] = {
          podType,
          summaries: [],
          totalMessages: 0,
          quotes: [],
          insights: [],
        };
      }

      byPod[podName].summaries.push(summary);
      byPod[podName].totalMessages += summary.metadata?.totalItems || 0;

      // Extract analytics data if available
      if (summary.analytics) {
        byPod[podName].quotes.push(...(summary.analytics.quotes || []));
        byPod[podName].insights.push(...(summary.analytics.insights || []));
        timeline.push(...(summary.analytics.timeline || []));
      }
    });

    return {
      byPod,
      timeline: timeline.sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
      ),
    };
  }

  /**
   * Generate digest content using AI with unified template
   */
  async generateDigestContent(organizedData, user) {
    const prompt = DigestTemplateService.createDigestPrompt(
      organizedData,
      user,
    );

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      console.error('Error generating digest content with AI:', error);
      // Use template service for fallback
      const insights = DailyDigestService.extractCrossConversationInsights([]);
      return DigestTemplateService.createFallbackDigest(
        user,
        insights,
        new Date(),
        new Date(),
      );
    }
  }

  /**
   * Create AI prompt for daily digest generation
   */
  static createDigestPrompt(organizedData, user) {
    const { byPod, timeline } = organizedData;

    let podSummaries = '';
    Object.entries(byPod).forEach(([podName, data]) => {
      podSummaries += `\n## ${podName} (${data.podType})\n`;
      podSummaries += `Messages: ${data.totalMessages}\n`;
      data.summaries.forEach((summary) => {
        podSummaries += `- ${summary.content}\n`;
      });

      if (data.quotes.length > 0) {
        podSummaries += 'Notable quotes:\n';
        data.quotes.slice(0, 3).forEach((quote) => {
          podSummaries += `  "${quote.text}" - ${quote.author}\n`;
        });
      }
    });

    return `Create a personalized daily digest newsletter for ${user.username}. 
You are writing a friendly, engaging daily summary that feels like a thoughtful friend catching them up on what happened in their communities.

Community Activity Summary:
${podSummaries}

Timeline of Events:
${timeline
    .slice(0, 10)
    .map((event) => `${event.timestamp}: ${event.description}`)
    .join('\n')}

Create a well-structured daily digest that includes:

1. **Opening**: Warm, personalized greeting
2. **Highlights**: Top 3-5 most interesting developments
3. **Community Pulse**: Overall mood and energy across their subscribed communities
4. **Notable Moments**: Best quotes, insights, or funny moments
5. **Looking Ahead**: Any ongoing discussions or trends to watch

Make it engaging, informative, and personal. Use markdown formatting for structure. Keep it concise but comprehensive - aim for a 2-3 minute read.`;
  }

  /**
   * Extract insights across all conversations
   */
  static extractCrossConversationInsights(summaries) {
    const allQuotes = [];
    const allInsights = [];
    const allTimeline = [];
    const allUsers = [];
    const allTags = [];

    let totalMessages = 0;
    const sentimentScores = [];
    const energyLevels = [];

    summaries.forEach((summary) => {
      totalMessages += summary.metadata?.totalItems || 0;

      if (summary.metadata?.topUsers) {
        allUsers.push(...summary.metadata.topUsers);
      }

      if (summary.metadata?.topTags) {
        allTags.push(...summary.metadata.topTags);
      }

      if (summary.analytics) {
        allQuotes.push(...(summary.analytics.quotes || []));
        allInsights.push(...(summary.analytics.insights || []));
        allTimeline.push(...(summary.analytics.timeline || []));

        // Aggregate atmosphere data
        if (summary.analytics.atmosphere) {
          const atm = summary.analytics.atmosphere;
          sentimentScores.push(DailyDigestService.sentimentToScore(atm.overall_sentiment));
          energyLevels.push(DailyDigestService.energyToScore(atm.energy_level));
        }
      }
    });

    // Sort and get top items
    const topUsers = DailyDigestService.getTopItems(allUsers, 5);
    const topTags = DailyDigestService.getTopItems(allTags, 8);
    const bestQuotes = allQuotes
      .sort((a, b) => (b.reactions || 0) - (a.reactions || 0))
      .slice(0, 5);

    const keyInsights = allInsights
      .sort((a, b) => {
        const impactScore = { high: 3, medium: 2, low: 1 };
        return (impactScore[b.impact] || 0) - (impactScore[a.impact] || 0);
      })
      .slice(0, 8);

    const timeline = allTimeline
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 10);

    return {
      topUsers,
      topTags,
      bestQuotes,
      keyInsights,
      timeline,
      overallAtmosphere: {
        overall_sentiment: DailyDigestService.scoreToSentiment(DailyDigestService.average(sentimentScores)),
        energy_level: DailyDigestService.scoreToEnergy(DailyDigestService.average(energyLevels)),
        engagement_quality: (() => {
          if (totalMessages > 100) return 'intense';
          if (totalMessages > 50) return 'deep';
          if (totalMessages > 20) return 'moderate';
          return 'superficial';
        })(),
        community_cohesion: Math.min(topUsers.length / 10, 1),
        topics_diversity: Math.min(topTags.length / 15, 1),
        dominant_emotions: ['engagement', 'community'],
      },
      participationOverview: {
        most_active_users: topUsers.slice(0, 5).map((user) => ({
          username: user,
          message_count: 0, // Would need more complex tracking
          engagement_score: 0.8,
          role: 'contributor',
        })),
        engagement_patterns: {
          peak_hours: [],
          discussion_length_avg: totalMessages / summaries.length,
          response_time_avg: 5,
        },
      },
    };
  }

  /**
   * Create empty digest for quiet days
   */
  static createEmptyDigest(user, startTime, endTime) {
    return {
      title: `Daily Digest for ${user.username} - ${endTime.toDateString()}`,
      content: `# 🌅 Daily Digest - ${endTime.toDateString()}

Good ${DailyDigestService.getTimeOfDayGreeting()}, ${user.username}!

It looks like it was a quiet day in your communities. Sometimes the best conversations happen during the calm moments.

## 📊 Community Pulse
- **Activity Level**: Low
- **Atmosphere**: Peaceful
- **Engagement**: Steady

## 🔮 Looking Ahead
This might be a great time to start a new conversation or share something interesting with your communities!

---
*Your personalized daily digest • Generated with ❤️ by Commonly AI*`,
      analytics: {
        timeline: [],
        quotes: [],
        insights: [],
        atmosphere: {
          overall_sentiment: 'neutral',
          energy_level: 'low',
          engagement_quality: 'low',
          community_cohesion: 0.5,
          topics_diversity: 0.2,
          dominant_emotions: ['calm'],
        },
      },
    };
  }

  /**
   * Generate all daily digests for active users
   */
  async generateAllDailyDigests() {
    try {
      console.log('🌅 Starting daily digest generation for all users...');

      // Get users who have subscribed pods or recent activity
      const activeUsers = await User.find({
        $or: [
          { subscribedPods: { $exists: true, $ne: [] } },
          {
            lastActive: {
              $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          }, // Active in last 7 days
        ],
      }).lean();

      console.log(
        `Found ${activeUsers.length} active users for daily digest generation`,
      );

      const results = await Promise.allSettled(
        activeUsers.map(async (user) => {
          try {
            const digest = await this.generateUserDailyDigest(user._id);
            return { userId: user._id, success: true, digest };
          } catch (error) {
            console.error(
              `Failed to generate digest for user ${user._id}:`,
              error,
            );
            return {
              userId: user._id,
              success: false,
              error: error.message,
            };
          }
        }),
      ).then((settled) => settled.map((result) => (result.status === 'fulfilled' ? result.value : result.reason)));

      const successful = results.filter((r) => r.success).length;
      console.log(
        `✅ Generated daily digests: ${successful}/${activeUsers.length} successful`,
      );

      return results;
    } catch (error) {
      console.error('Error generating daily digests:', error);
      throw error;
    }
  }

  // Utility methods
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

  static sentimentToScore(sentiment) {
    const scores = {
      very_negative: 1,
      negative: 2,
      neutral: 3,
      positive: 4,
      very_positive: 5,
    };
    return scores[sentiment] || 3;
  }

  static energyToScore(energy) {
    const scores = {
      very_low: 1,
      low: 2,
      medium: 3,
      high: 4,
      very_high: 5,
    };
    return scores[energy] || 3;
  }

  static scoreToSentiment(score) {
    if (score >= 4.5) return 'very_positive';
    if (score >= 3.5) return 'positive';
    if (score >= 2.5) return 'neutral';
    if (score >= 1.5) return 'negative';
    return 'very_negative';
  }

  static scoreToEnergy(score) {
    if (score >= 4.5) return 'very_high';
    if (score >= 3.5) return 'high';
    if (score >= 2.5) return 'medium';
    if (score >= 1.5) return 'low';
    return 'very_low';
  }

  static average(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 3;
  }

  static getTimeOfDayGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'morning';
    if (hour < 17) return 'afternoon';
    return 'evening';
  }

  static generateFallbackDigest(organizedData, user) {
    const { byPod } = organizedData;
    const podCount = Object.keys(byPod).length;
    const totalMessages = Object.values(byPod).reduce(
      (sum, pod) => sum + pod.totalMessages,
      0,
    );

    return `# 🌅 Daily Digest - ${new Date().toDateString()}

Good ${DailyDigestService.getTimeOfDayGreeting()}, ${user.username}!

## 📊 Community Overview
- **Active Communities**: ${podCount}
- **Total Messages**: ${totalMessages}
- **Engagement**: ${(() => {
    if (totalMessages > 50) return 'High';
    if (totalMessages > 20) return 'Medium';
    return 'Low';
  })()}

${Object.entries(byPod)
    .map(
      ([podName, data]) => `### ${podName}\n${data.summaries.map((s) => `- ${s.content}`).join('\n')}`,
    )
    .join('\n\n')}

---
*Your personalized daily digest • Generated with ❤️ by Commonly AI*`;
  }
}

module.exports = new DailyDigestService();
