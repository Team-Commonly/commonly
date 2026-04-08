interface UserLike {
  username: string;
}

interface AtmosphereLike {
  overall_sentiment?: string;
  energy_level?: string;
  engagement_quality?: string;
}

interface InsightsLike {
  totalItems?: number;
  overallAtmosphere?: AtmosphereLike;
  topUsers?: unknown[];
  bestQuotes?: Array<{ text: string; author: string; context: string }>;
  keyInsights?: Array<{ type: string; description: string }>;
  timeline?: Array<{ timestamp: string; description: string }>;
}

interface MetadataLike {
  subscribedPods?: number;
}

class DigestTemplateService {
  static createDigestPrompt(organizedData: unknown, user: UserLike): string {
    const { username } = user;
    const date = new Date().toDateString();

    return `Create a personalized daily digest newsletter for ${username} using this EXACT format and structure:

COMMUNITY DATA:
${JSON.stringify(organizedData, null, 2)}

REQUIRED FORMAT (follow this structure exactly):

# 🌅 Daily Digest - ${date}

Good morning, ${username}!

Ready for your daily dose of community insights? Let's dive into what's been happening while you were away.

## ✨ Today's Highlights

[List 3-5 most significant developments, each as a bullet point with descriptive titles]

## 💬 Notable Moments

### 🔥 Quote of the Day
> "[Most engaging or insightful quote from discussions]"
>
> *— @[username] in [community/context]*

### 🎯 Key Insights
- **[Insight Type]**: [Brief description of trend, consensus, or development]
- **[Community Vibe]**: [Description of overall mood and energy]

## 📊 Community Pulse

- **Overall Mood**: [Emoji] [Sentiment description]
- **Energy Level**: [Emoji] [Activity level description]
- **Engagement Quality**: [Emoji] [Type of discussions happening]
- **Active Communities**: [Number] of your subscribed communities had activity

## 🔮 Looking Ahead

[2-3 sentences about trends, upcoming discussions, or community direction]

---
*Your personalized digest • Generated with ❤️ by Commonly AI*

GUIDELINES:
- Use engaging, friendly tone
- Include specific details from the data
- Personalize content for ${username}
- Use emojis strategically for visual appeal
- Keep sections concise but informative
- Focus on community connection and engagement
- If data is limited, acknowledge it positively
- Highlight ${username}'s contributions when present`;
  }

  static createAnalyticsPrompt(messages: unknown, podName: string): string {
    return `Analyze this chat data and extract structured analytics for community insights.

CHAT DATA:
Pod: ${podName}
Messages: ${JSON.stringify(messages, null, 2)}

Extract and return ONLY a valid JSON object with this structure:
{
  "timeline": [
    {
      "timestamp": "ISO date",
      "event": "topic_shift|peak_activity|heated_discussion|new_participant|milestone",
      "description": "Brief description of what happened",
      "participants": ["username1", "username2"],
      "intensity": 1-10
    }
  ],
  "quotes": [
    {
      "text": "Exact quote text",
      "author": "username",
      "timestamp": "ISO date",
      "context": "What was being discussed",
      "sentiment": "positive|negative|neutral|humorous|insightful",
      "reactions": 0
    }
  ],
  "insights": [
    {
      "type": "trend|sentiment_shift|new_topic|consensus|disagreement|revelation",
      "description": "What insight was gained",
      "confidence": 0.0-1.0,
      "impact": "low|medium|high",
      "participants": ["username1"],
      "timestamp": "ISO date"
    }
  ],
  "atmosphere": {
    "overall_sentiment": "very_positive|positive|neutral|negative|very_negative",
    "energy_level": "very_low|low|medium|high|very_high",
    "engagement_quality": "superficial|moderate|deep|intense",
    "community_cohesion": 0.0-1.0,
    "topics_diversity": 0.0-1.0,
    "dominant_emotions": ["emotion1", "emotion2"]
  },
  "participation": {
    "most_active_users": [
      {
        "username": "username",
        "message_count": 0,
        "engagement_score": 0.0-1.0,
        "role": "moderator|contributor|lurker|newcomer"
      }
    ],
    "engagement_patterns": {
      "peak_hours": [14, 15, 16],
      "discussion_length_avg": 0,
      "response_time_avg": 0
    }
  }
}

IMPORTANT: Return ONLY the JSON object, no additional text or explanation.`;
  }

  static createFallbackDigest(user: UserLike, insights: InsightsLike, _startTime: Date, endTime: Date): string {
    const { username } = user;
    const date = endTime.toDateString();

    return `# 🌅 Daily Digest - ${date}

Good morning, ${username}!

Ready for your daily community catch-up? Here's what's been happening.

## ✨ Today's Highlights

- **Community Activity**: ${insights.totalItems || 0} conversations and updates across your communities
- **Active Discussions**: Your communities maintained ${insights.overallAtmosphere?.energy_level || 'moderate'} energy levels
- **Community Engagement**: ${insights.topUsers?.length || 0} active community members contributing

## 📊 Community Pulse

- **Overall Mood**: 😊 ${insights.overallAtmosphere?.overall_sentiment || 'Positive'}
- **Energy Level**: ⚡ ${insights.overallAtmosphere?.energy_level || 'Moderate'}
- **Engagement Quality**: 🎯 ${insights.overallAtmosphere?.engagement_quality || 'Good'} discussions
- **Active Communities**: Your subscribed communities are staying connected

## 🔮 Looking Ahead

Your communities continue to grow and evolve. Keep an eye out for new conversations and opportunities to connect with fellow members.

---
*Your personalized digest • Generated with ❤️ by Commonly AI*`;
  }

  static getPersonalizedGreeting(user: UserLike, timeOfDay: string, activityLevel: string): string {
    const { username } = user;

    const greetings: Record<string, Record<string, string>> = {
      morning: {
        high: `Rise and shine, ${username}! Your communities were buzzing overnight.`,
        medium: `Good morning, ${username}! Here's what happened while you were away.`,
        low: `Morning, ${username}! It was a quiet night, but there are still some gems to discover.`,
      },
      afternoon: {
        high: `Good afternoon, ${username}! Catching up on a busy day in your communities?`,
        medium: `Hey ${username}! Ready for your daily community roundup?`,
        low: `Hi ${username}! Not much happened, but here's what's worth knowing.`,
      },
      evening: {
        high: `Evening, ${username}! Your communities had quite the active day.`,
        medium: `Good evening, ${username}! Time to catch up on today's highlights.`,
        low: `Evening, ${username}! A peaceful day in your communities, but still some nice moments to share.`,
      },
    };

    return (
      greetings[timeOfDay]?.[activityLevel]
      || `Hello, ${username}! Here's your daily community digest.`
    );
  }

  static buildConditionalSections(insights: InsightsLike, _user: UserLike): string {
    const sections: string[] = [];

    if (insights.bestQuotes && insights.bestQuotes.length > 0) {
      const topQuote = insights.bestQuotes[0];
      sections.push(`### 🔥 Quote of the Day
> "${topQuote.text}"
>
> *— @${topQuote.author} in ${topQuote.context}*`);
    }

    if (insights.keyInsights && insights.keyInsights.length > 0) {
      let insightText = '### 🎯 Key Insights\n';
      insights.keyInsights.slice(0, 3).forEach((insight) => {
        insightText += `- **${insight.type.replace('_', ' ').toUpperCase()}**: ${insight.description}\n`;
      });
      sections.push(insightText.trim());
    }

    if (insights.timeline && insights.timeline.length > 0) {
      let timelineText = '### ⏰ Timeline Highlights\n';
      insights.timeline.slice(0, 3).forEach((event) => {
        const time = new Date(event.timestamp).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
        });
        timelineText += `- **${time}**: ${event.description}\n`;
      });
      sections.push(timelineText.trim());
    }

    return sections.join('\n\n');
  }

  static formatCommunityPulse(atmosphere: AtmosphereLike | null, metadata: MetadataLike | null): string {
    const moodEmojis: Record<string, string> = {
      very_positive: '🌟',
      positive: '😊',
      neutral: '😐',
      negative: '😔',
      very_negative: '😞',
    };

    const energyEmojis: Record<string, string> = {
      very_high: '🚀',
      high: '⚡',
      medium: '🔋',
      low: '🔅',
      very_low: '💤',
    };

    const engagementEmojis: Record<string, string> = {
      intense: '🔥',
      deep: '🎯',
      moderate: '💬',
      superficial: '👋',
    };

    return `## 📊 Community Pulse

- **Overall Mood**: ${moodEmojis[atmosphere?.overall_sentiment || ''] || '😊'} ${atmosphere?.overall_sentiment?.replace('_', ' ') || 'Positive'}
- **Energy Level**: ${energyEmojis[atmosphere?.energy_level || ''] || '🔋'} ${atmosphere?.energy_level?.replace('_', ' ') || 'Moderate'}
- **Engagement Quality**: ${engagementEmojis[atmosphere?.engagement_quality || ''] || '💬'} ${atmosphere?.engagement_quality || 'Good'} discussions
- **Active Communities**: ${metadata?.subscribedPods || 0} of your subscribed communities had activity`;
  }
}

export default DigestTemplateService;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
