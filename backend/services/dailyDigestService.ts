// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const DigestTemplateService = require('./digestTemplateService');
// eslint-disable-next-line global-require
const { generateText } = require('./llmService');

interface SummaryAnalytics {
  quotes?: Array<{ text: string; author: string; reactions?: number }>;
  insights?: Array<{ impact?: string; [key: string]: unknown }>;
  timeline?: Array<{ timestamp: string; description: string }>;
  atmosphere?: {
    overall_sentiment?: string;
    energy_level?: string;
  };
}

interface SummaryDoc {
  podId?: { name?: string; type?: string } | null;
  type?: string;
  content?: string;
  metadata?: {
    totalItems?: number;
    topUsers?: string[];
    topTags?: string[];
    podName?: string;
  };
  analytics?: SummaryAnalytics;
}

interface PodData {
  podType: string;
  summaries: SummaryDoc[];
  totalMessages: number;
  quotes: Array<{ text: string; author: string; reactions?: number }>;
  insights: Array<{ impact?: string; [key: string]: unknown }>;
}

interface OrganizedData {
  byPod: Record<string, PodData>;
  timeline: Array<{ timestamp: string; description: string }>;
}

interface CrossConversationInsights {
  topUsers: string[];
  topTags: string[];
  bestQuotes: Array<{ text: string; author: string; reactions?: number }>;
  keyInsights: Array<{ impact?: string; [key: string]: unknown }>;
  timeline: Array<{ timestamp: string; description: string }>;
  overallAtmosphere: Record<string, unknown>;
  participationOverview: Record<string, unknown>;
}

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

class DailyDigestService {
  async generateUserDailyDigest(userId: unknown): Promise<unknown> {
    try {
      console.log(`Generating daily digest for user ${userId}`);

      const user = await User.findById(userId)
        .populate('subscribedPods')
        .lean() as Record<string, unknown> | null;
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);

      const podIds = (user.subscribedPods as Array<{ _id: unknown }> | undefined)
        ?.map((pod) => pod._id) || [];

      const summaries = await Summary.find({
        $or: [
          { podId: { $in: podIds } },
          { type: 'posts' },
          { type: 'chats', podId: { $exists: false } },
        ],
        createdAt: { $gte: startTime, $lte: endTime },
      })
        .populate('podId', 'name type')
        .sort({ createdAt: 1 })
        .lean() as SummaryDoc[];

      if (summaries.length === 0) {
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
            subscribedPods: podIds.length,
            userId: String(userId),
          },
          analytics: emptyData.analytics,
        });
      }

      const organizedData = DailyDigestService.organizeSummariesForDigest(summaries);
      const digestContent = await this.generateDigestContent(organizedData, user as { username: string });
      const insights = DailyDigestService.extractCrossConversationInsights(summaries);

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
          userId: String(userId),
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

  static organizeSummariesForDigest(summaries: SummaryDoc[]): OrganizedData {
    const byPod: Record<string, PodData> = {};
    const timeline: Array<{ timestamp: string; description: string }> = [];

    summaries.forEach((summary) => {
      const podName = (summary.podId as { name?: string } | null)?.name || 'General';
      const podType = (summary.podId as { type?: string } | null)?.type || summary.type || 'general';

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

      if (summary.analytics) {
        byPod[podName].quotes.push(...(summary.analytics.quotes || []));
        byPod[podName].insights.push(...(summary.analytics.insights || []));
        timeline.push(...(summary.analytics.timeline || []));
      }
    });

    return {
      byPod,
      timeline: timeline.sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      ),
    };
  }

  async generateDigestContent(organizedData: OrganizedData, user: { username: string }): Promise<string> {
    const prompt = DigestTemplateService.createDigestPrompt(organizedData, user);

    try {
      return await generateText(prompt, { temperature: 0.4 }) as string;
    } catch (error) {
      console.error('Error generating digest content with AI:', error);
      const insights = DailyDigestService.extractCrossConversationInsights([]);
      return DigestTemplateService.createFallbackDigest(user, insights, new Date(), new Date());
    }
  }

  static createDigestPrompt(organizedData: OrganizedData, user: { username: string }): string {
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

  static extractCrossConversationInsights(summaries: SummaryDoc[]): CrossConversationInsights {
    const allQuotes: Array<{ text: string; author: string; reactions?: number }> = [];
    const allInsights: Array<{ impact?: string; [key: string]: unknown }> = [];
    const allTimeline: Array<{ timestamp: string; description: string }> = [];
    const allUsers: string[] = [];
    const allTags: string[] = [];

    let totalMessages = 0;
    const sentimentScores: number[] = [];
    const energyLevels: number[] = [];

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

        if (summary.analytics.atmosphere) {
          const atm = summary.analytics.atmosphere;
          sentimentScores.push(DailyDigestService.sentimentToScore(atm.overall_sentiment));
          energyLevels.push(DailyDigestService.energyToScore(atm.energy_level));
        }
      }
    });

    const topUsers = DailyDigestService.getTopItems(allUsers, 5);
    const topTags = DailyDigestService.getTopItems(allTags, 8);
    const bestQuotes = allQuotes
      .sort((a, b) => (b.reactions || 0) - (a.reactions || 0))
      .slice(0, 5);

    const impactScore: Record<string, number> = { high: 3, medium: 2, low: 1 };
    const keyInsights = allInsights
      .sort((a, b) => (impactScore[String(b.impact || '')] || 0) - (impactScore[String(a.impact || '')] || 0))
      .slice(0, 8);

    const timeline = allTimeline
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 10);

    const engagementQuality = (() => {
      if (totalMessages > 100) return 'intense';
      if (totalMessages > 50) return 'deep';
      if (totalMessages > 20) return 'moderate';
      return 'superficial';
    })();

    return {
      topUsers,
      topTags,
      bestQuotes,
      keyInsights,
      timeline,
      overallAtmosphere: {
        overall_sentiment: DailyDigestService.scoreToSentiment(DailyDigestService.average(sentimentScores)),
        energy_level: DailyDigestService.scoreToEnergy(DailyDigestService.average(energyLevels)),
        engagement_quality: engagementQuality,
        community_cohesion: Math.min(topUsers.length / 10, 1),
        topics_diversity: Math.min(topTags.length / 15, 1),
        dominant_emotions: ['engagement', 'community'],
      },
      participationOverview: {
        most_active_users: topUsers.slice(0, 5).map((u) => ({
          username: u,
          message_count: 0,
          engagement_score: 0.8,
          role: 'contributor',
        })),
        engagement_patterns: {
          peak_hours: [],
          discussion_length_avg: summaries.length ? totalMessages / summaries.length : 0,
          response_time_avg: 5,
        },
      },
    };
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
          engagement_quality: 'low',
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

      const activeUsers = await User.find({
        $or: [
          { subscribedPods: { $exists: true, $ne: [] } },
          { lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
        ],
      }).lean() as Array<{ _id: unknown; username?: string }>;

      console.log(`Found ${activeUsers.length} active users for daily digest generation`);

      const results = await Promise.allSettled(
        activeUsers.map(async (user) => {
          try {
            const digest = await this.generateUserDailyDigest(user._id);
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

  static sentimentToScore(sentiment?: string): number {
    const scores: Record<string, number> = {
      very_negative: 1, negative: 2, neutral: 3, positive: 4, very_positive: 5,
    };
    return scores[sentiment || ''] || 3;
  }

  static energyToScore(energy?: string): number {
    const scores: Record<string, number> = {
      very_low: 1, low: 2, medium: 3, high: 4, very_high: 5,
    };
    return scores[energy || ''] || 3;
  }

  static scoreToSentiment(score: number): string {
    if (score >= 4.5) return 'very_positive';
    if (score >= 3.5) return 'positive';
    if (score >= 2.5) return 'neutral';
    if (score >= 1.5) return 'negative';
    return 'very_negative';
  }

  static scoreToEnergy(score: number): string {
    if (score >= 4.5) return 'very_high';
    if (score >= 3.5) return 'high';
    if (score >= 2.5) return 'medium';
    if (score >= 1.5) return 'low';
    return 'very_low';
  }

  static average(arr: number[]): number {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 3;
  }

  static getTimeOfDayGreeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'morning';
    if (hour < 17) return 'afternoon';
    return 'evening';
  }

  static generateFallbackDigest(organizedData: OrganizedData, user: { username: string }): string {
    const { byPod } = organizedData;
    const podCount = Object.keys(byPod).length;
    const totalMessages = Object.values(byPod).reduce(
      (sum, pod) => sum + pod.totalMessages,
      0,
    );

    const engagementLabel = (() => {
      if (totalMessages > 50) return 'High';
      if (totalMessages > 20) return 'Medium';
      return 'Low';
    })();

    return `# Daily Digest - ${new Date().toDateString()}

Good ${DailyDigestService.getTimeOfDayGreeting()}, ${user.username}!

## Community Overview
- **Active Communities**: ${podCount}
- **Total Messages**: ${totalMessages}
- **Engagement**: ${engagementLabel}

${Object.entries(byPod)
    .map(
      ([podName, data]) => `### ${podName}\n${data.summaries.map((s) => `- ${s.content}`).join('\n')}`,
    )
    .join('\n\n')}

---
*Your personalized daily digest • Generated with love by Commonly AI*`;
  }
}

export default new DailyDigestService();
