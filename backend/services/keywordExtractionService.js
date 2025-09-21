/**
 * Keyword Extraction Service
 * Provides intelligent keyword and topic analysis for community content
 */
class KeywordExtractionService {
  
  /**
   * Extract keywords from summaries using TF-IDF analysis
   */
  static extractKeywords(summaries, options = {}) {
    const { maxKeywords = 20, minFrequency = 2 } = options;
    
    // Combine all content for analysis
    const allText = summaries
      .map(s => `${s.title} ${s.content}`)
      .join(' ')
      .toLowerCase();
    
    // Basic text processing
    const words = this.preprocessText(allText);
    
    // Calculate word frequencies
    const wordFreqs = this.calculateWordFrequencies(words);
    
    // Filter and rank keywords
    const keywords = Object.entries(wordFreqs)
      .filter(([word, freq]) => freq >= minFrequency && word.length > 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxKeywords)
      .map(([word, frequency]) => ({
        word,
        frequency,
        weight: this.calculateTFIDF(word, words, [words]) // Simplified TF-IDF
      }));
    
    return keywords;
  }
  
  /**
   * Generate topic clusters from keywords
   */
  static generateTopicClusters(keywords, summaries) {
    const clusters = [];
    const usedKeywords = new Set();
    
    // Group related keywords
    keywords.forEach(keyword => {
      if (usedKeywords.has(keyword.word)) return;
      
      const cluster = {
        topic: this.generateTopicName(keyword.word),
        keywords: [keyword],
        strength: keyword.weight,
        relatedSummaries: this.findRelatedSummaries(keyword.word, summaries)
      };
      
      // Find semantically related keywords
      keywords.forEach(otherKeyword => {
        if (otherKeyword.word !== keyword.word && 
            !usedKeywords.has(otherKeyword.word) &&
            this.areWordsRelated(keyword.word, otherKeyword.word)) {
          cluster.keywords.push(otherKeyword);
          usedKeywords.add(otherKeyword.word);
        }
      });
      
      usedKeywords.add(keyword.word);
      clusters.push(cluster);
    });
    
    return clusters.slice(0, 8); // Return top 8 clusters
  }
  
  /**
   * Extract user mention patterns and relationships
   */
  static extractUserRelationships(summaries) {
    const relationships = new Map();
    const userMentions = new Map();
    
    summaries.forEach(summary => {
      // Extract user mentions from metadata
      const users = summary.metadata?.topUsers || [];
      
      // Count user appearances
      users.forEach(user => {
        userMentions.set(user, (userMentions.get(user) || 0) + 1);
      });
      
      // Build co-occurrence relationships
      for (let i = 0; i < users.length; i++) {
        for (let j = i + 1; j < users.length; j++) {
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
        .sort((a, b) => b.strength - a.strength)
    };
  }
  
  /**
   * Analyze activity patterns over time
   */
  static analyzeActivityPatterns(summaries) {
    const hourlyActivity = new Map();
    const dailyActivity = new Map();
    const sentimentOverTime = [];
    
    summaries.forEach(summary => {
      const date = new Date(summary.createdAt);
      const hour = date.getHours();
      const day = date.toDateString();
      
      // Hourly patterns
      hourlyActivity.set(hour, (hourlyActivity.get(hour) || 0) + (summary.metadata?.totalItems || 1));
      
      // Daily patterns
      dailyActivity.set(day, (dailyActivity.get(day) || 0) + (summary.metadata?.totalItems || 1));
      
      // Sentiment over time
      if (summary.analytics?.atmosphere?.overall_sentiment) {
        sentimentOverTime.push({
          timestamp: date.toISOString(),
          sentiment: summary.analytics.atmosphere.overall_sentiment,
          activity: summary.metadata?.totalItems || 0
        });
      }
    });
    
    return {
      hourlyPattern: Array.from(hourlyActivity.entries())
        .map(([hour, activity]) => ({ hour, activity }))
        .sort((a, b) => a.hour - b.hour),
      dailyPattern: Array.from(dailyActivity.entries())
        .map(([day, activity]) => ({ day, activity }))
        .sort((a, b) => new Date(a.day) - new Date(b.day)),
      sentimentTimeline: sentimentOverTime.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    };
  }
  
  /**
   * Generate trending topics based on frequency changes
   */
  static identifyTrendingTopics(currentKeywords, previousKeywords = []) {
    const trending = [];
    const previousMap = new Map(previousKeywords.map(k => [k.word, k.frequency]));
    
    currentKeywords.forEach(keyword => {
      const previousFreq = previousMap.get(keyword.word) || 0;
      const change = keyword.frequency - previousFreq;
      const growthRate = previousFreq > 0 ? (change / previousFreq) * 100 : 100;
      
      if (growthRate > 50 || (previousFreq === 0 && keyword.frequency > 2)) {
        trending.push({
          ...keyword,
          trend: 'rising',
          growthRate: Math.round(growthRate),
          isNew: previousFreq === 0
        });
      }
    });
    
    return trending.sort((a, b) => b.growthRate - a.growthRate);
  }
  
  // Helper methods
  static preprocessText(text) {
    // Remove common stop words and clean text
    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but', 'in', 'with', 'to', 'for', 'of', 'as', 'by',
      'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
      'my', 'your', 'his', 'her', 'its', 'our', 'their', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
      'can', 'cannot', 'cant', 'dont', 'wont', 'isnt', 'arent', 'wasnt', 'werent', 'hasnt', 'havent', 'hadnt',
      'community', 'members', 'discussion', 'conversations', 'chat', 'messages', 'today', 'yesterday', 'tomorrow'
    ]);
    
    return text
      .replace(/[^\w\s]/g, ' ') // Remove punctuation
      .replace(/\s+/g, ' ') // Normalize whitespace
      .split(' ')
      .filter(word => word.length > 2 && !stopWords.has(word))
      .filter(word => !/^\d+$/.test(word)); // Remove pure numbers
  }
  
  static calculateWordFrequencies(words) {
    const frequencies = {};
    words.forEach(word => {
      frequencies[word] = (frequencies[word] || 0) + 1;
    });
    return frequencies;
  }
  
  static calculateTFIDF(word, document, corpus) {
    // Simplified TF-IDF calculation
    const tf = document.filter(w => w === word).length / document.length;
    const df = corpus.filter(doc => doc.includes(word)).length;
    const idf = Math.log(corpus.length / (df + 1));
    return tf * idf;
  }
  
  static generateTopicName(keyword) {
    // Simple topic naming based on keyword
    const topicMap = {
      'react': 'Frontend Development',
      'javascript': 'Web Development', 
      'boba': 'Food & Drinks',
      'tea': 'Beverages',
      'discord': 'Community Chat',
      'testing': 'Quality Assurance',
      'framework': 'Development Tools',
      'async': 'Programming Concepts'
    };
    
    return topicMap[keyword] || `${keyword.charAt(0).toUpperCase() + keyword.slice(1)} Discussion`;
  }
  
  static findRelatedSummaries(keyword, summaries) {
    return summaries
      .filter(summary => 
        summary.title.toLowerCase().includes(keyword) || 
        summary.content.toLowerCase().includes(keyword)
      )
      .map(summary => ({
        id: summary._id,
        title: summary.title,
        relevance: this.calculateRelevance(keyword, summary)
      }))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 3);
  }
  
  static calculateRelevance(keyword, summary) {
    const text = `${summary.title} ${summary.content}`.toLowerCase();
    const occurrences = (text.match(new RegExp(keyword, 'g')) || []).length;
    return occurrences / text.split(' ').length;
  }
  
  static areWordsRelated(word1, word2) {
    // Simple semantic relationship detection
    const relatedGroups = [
      ['react', 'javascript', 'frontend', 'web', 'component'],
      ['boba', 'tea', 'drink', 'beverage', 'ume'],
      ['discord', 'chat', 'message', 'conversation'],
      ['test', 'testing', 'framework', 'development']
    ];
    
    return relatedGroups.some(group => 
      group.includes(word1) && group.includes(word2)
    );
  }
}

module.exports = KeywordExtractionService;