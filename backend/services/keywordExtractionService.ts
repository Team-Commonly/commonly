interface KeywordItem {
  word: string;
  frequency: number;
  weight: number;
}

interface TrendingKeyword extends KeywordItem {
  trend: 'rising';
  growthRate: number;
  isNew: boolean;
}

interface TopicCluster {
  topic: string;
  keywords: KeywordItem[];
  strength: number;
  relatedSummaries: Array<{ id: unknown; title: string; relevance: number }>;
}

interface UserRelationships {
  userActivity: Array<{ user: string; count: number }>;
  relationships: Array<{ user1: string; user2: string; strength: number }>;
}

interface ActivityPatterns {
  hourlyPattern: Array<{ hour: number; activity: number }>;
  dailyPattern: Array<{ day: string; activity: number }>;
  sentimentTimeline: Array<{ timestamp: string; sentiment: string; activity: number }>;
}

interface SummaryLike {
  title: string;
  content: string;
  _id?: unknown;
  createdAt?: Date | string;
  metadata?: Record<string, unknown>;
  analytics?: Record<string, unknown>;
}

interface ExtractKeywordsOptions {
  maxKeywords?: number;
  minFrequency?: number;
}

class KeywordExtractionService {
  static extractKeywords(summaries: SummaryLike[], options: ExtractKeywordsOptions = {}): KeywordItem[] {
    const { maxKeywords = 20, minFrequency = 2 } = options;

    const allText = summaries
      .map((s) => `${s.title} ${s.content}`)
      .join(' ')
      .toLowerCase();

    const words = this.preprocessText(allText);
    const wordFreqs = this.calculateWordFrequencies(words);

    const keywords = Object.entries(wordFreqs)
      .filter(([word, freq]) => freq >= minFrequency && word.length > 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxKeywords)
      .map(([word, frequency]) => ({
        word,
        frequency,
        weight: this.calculateTFIDF(word, words, [words]),
      }));

    return keywords;
  }

  static generateTopicClusters(keywords: KeywordItem[], summaries: SummaryLike[]): TopicCluster[] {
    const clusters: TopicCluster[] = [];
    const usedKeywords = new Set<string>();

    keywords.forEach((keyword) => {
      if (usedKeywords.has(keyword.word)) return;

      const cluster: TopicCluster = {
        topic: this.generateTopicName(keyword.word),
        keywords: [keyword],
        strength: keyword.weight,
        relatedSummaries: this.findRelatedSummaries(keyword.word, summaries),
      };

      keywords.forEach((otherKeyword) => {
        if (
          otherKeyword.word !== keyword.word
          && !usedKeywords.has(otherKeyword.word)
          && this.areWordsRelated(keyword.word, otherKeyword.word)
        ) {
          cluster.keywords.push(otherKeyword);
          usedKeywords.add(otherKeyword.word);
        }
      });

      usedKeywords.add(keyword.word);
      clusters.push(cluster);
    });

    return clusters.slice(0, 8);
  }

  static extractUserRelationships(summaries: SummaryLike[]): UserRelationships {
    const relationships = new Map<string, number>();
    const userMentions = new Map<string, number>();

    summaries.forEach((summary) => {
      const users: string[] = (summary.metadata?.topUsers as string[]) || [];

      users.forEach((user) => {
        userMentions.set(user, (userMentions.get(user) || 0) + 1);
      });

      for (let i = 0; i < users.length; i += 1) {
        for (let j = i + 1; j < users.length; j += 1) {
          const pair = [users[i], users[j]].sort().join('-');
          relationships.set(pair, (relationships.get(pair) || 0) + 1);
        }
      }
    });

    return {
      userActivity: Array.from(userMentions.entries())
        .map(([user, count]) => ({ user, count }))
        .sort((a, b) => b.count - a.count),
      relationships: Array.from(relationships.entries())
        .map(([pair, strength]) => {
          const [user1, user2] = pair.split('-');
          return { user1, user2, strength };
        })
        .sort((a, b) => b.strength - a.strength),
    };
  }

  static analyzeActivityPatterns(summaries: SummaryLike[]): ActivityPatterns {
    const hourlyActivity = new Map<number, number>();
    const dailyActivity = new Map<string, number>();
    const sentimentOverTime: Array<{ timestamp: string; sentiment: string; activity: number }> = [];

    summaries.forEach((summary) => {
      const date = new Date(summary.createdAt as string | Date);
      const hour = date.getHours();
      const day = date.toDateString();

      hourlyActivity.set(
        hour,
        (hourlyActivity.get(hour) || 0) + ((summary.metadata?.totalItems as number) || 1),
      );

      dailyActivity.set(
        day,
        (dailyActivity.get(day) || 0) + ((summary.metadata?.totalItems as number) || 1),
      );

      const atmosphere = (summary.analytics as Record<string, unknown>)?.atmosphere as Record<string, unknown> | undefined;
      if (atmosphere?.overall_sentiment) {
        sentimentOverTime.push({
          timestamp: date.toISOString(),
          sentiment: String(atmosphere.overall_sentiment),
          activity: (summary.metadata?.totalItems as number) || 0,
        });
      }
    });

    return {
      hourlyPattern: Array.from(hourlyActivity.entries())
        .map(([hour, activity]) => ({ hour, activity }))
        .sort((a, b) => a.hour - b.hour),
      dailyPattern: Array.from(dailyActivity.entries())
        .map(([day, activity]) => ({ day, activity }))
        .sort((a, b) => new Date(a.day).getTime() - new Date(b.day).getTime()),
      sentimentTimeline: sentimentOverTime.sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      ),
    };
  }

  static identifyTrendingTopics(currentKeywords: KeywordItem[], previousKeywords: KeywordItem[] = []): TrendingKeyword[] {
    const trending: TrendingKeyword[] = [];
    const previousMap = new Map(
      previousKeywords.map((k) => [k.word, k.frequency]),
    );

    currentKeywords.forEach((keyword) => {
      const previousFreq = previousMap.get(keyword.word) || 0;
      const change = keyword.frequency - previousFreq;
      const growthRate = previousFreq > 0 ? (change / previousFreq) * 100 : 100;

      if (growthRate > 50 || (previousFreq === 0 && keyword.frequency > 2)) {
        trending.push({
          ...keyword,
          trend: 'rising',
          growthRate: Math.round(growthRate),
          isNew: previousFreq === 0,
        });
      }
    });

    return trending.sort((a, b) => b.growthRate - a.growthRate);
  }

  // Helper methods
  static preprocessText(text: string): string[] {
    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but', 'in', 'with',
      'to', 'for', 'of', 'as', 'by', 'this', 'that', 'these', 'those', 'i', 'you',
      'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
      'his', 'its', 'our', 'their', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
      'may', 'might', 'must', 'can', 'cannot', 'cant', 'dont', 'wont', 'isnt', 'arent',
      'wasnt', 'werent', 'hasnt', 'havent', 'hadnt', 'community', 'members', 'discussion',
      'conversations', 'chat', 'messages', 'today', 'yesterday', 'tomorrow',
    ]);

    return text
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .split(' ')
      .filter((word) => word.length > 2 && !stopWords.has(word))
      .filter((word) => !/^\d+$/.test(word));
  }

  static calculateWordFrequencies(words: string[]): Record<string, number> {
    const frequencies: Record<string, number> = {};
    words.forEach((word) => {
      frequencies[word] = (frequencies[word] || 0) + 1;
    });
    return frequencies;
  }

  static calculateTFIDF(word: string, document: string[], corpus: string[][]): number {
    const tf = document.filter((w) => w === word).length / document.length;
    const df = corpus.filter((doc) => doc.includes(word)).length;
    const idf = Math.log(corpus.length / (df + 1));
    return tf * idf;
  }

  static generateTopicName(keyword: string): string {
    const topicMap: Record<string, string> = {
      react: 'Frontend Development',
      javascript: 'Web Development',
      boba: 'Food & Drinks',
      tea: 'Beverages',
      discord: 'Community Chat',
      testing: 'Quality Assurance',
      framework: 'Development Tools',
      async: 'Programming Concepts',
    };

    return (
      topicMap[keyword]
      || `${keyword.charAt(0).toUpperCase() + keyword.slice(1)} Discussion`
    );
  }

  static findRelatedSummaries(keyword: string, summaries: SummaryLike[]): Array<{ id: unknown; title: string; relevance: number }> {
    return summaries
      .filter(
        (summary) => summary.title.toLowerCase().includes(keyword)
          || summary.content.toLowerCase().includes(keyword),
      )
      .map((summary) => ({
        id: summary._id,
        title: summary.title,
        relevance: this.calculateRelevance(keyword, summary),
      }))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 3);
  }

  static calculateRelevance(keyword: string, summary: SummaryLike): number {
    const text = `${summary.title} ${summary.content}`.toLowerCase();
    const occurrences = (text.match(new RegExp(keyword, 'g')) || []).length;
    return occurrences / text.split(' ').length;
  }

  static areWordsRelated(word1: string, word2: string): boolean {
    const relatedGroups: string[][] = [
      ['react', 'javascript', 'frontend', 'web', 'component'],
      ['boba', 'tea', 'drink', 'beverage', 'ume'],
      ['discord', 'chat', 'message', 'conversation'],
      ['test', 'testing', 'framework', 'development'],
    ];

    return relatedGroups.some(
      (group) => group.includes(word1) && group.includes(word2),
    );
  }
}

export default KeywordExtractionService;
