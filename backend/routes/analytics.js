const express = require('express');
const router = express.Router();
const Summary = require('../models/Summary');
const KeywordExtractionService = require('../services/keywordExtractionService');
const auth = require('../middleware/auth');

// GET /api/analytics/keywords - Extract keywords from recent summaries
router.get('/keywords', auth, async (req, res) => {
  try {
    const { timeRange = '24h', podId, maxKeywords = 20 } = req.query;
    const userId = req.user.id;
    
    // Calculate time range
    const hours = timeRange === '7d' ? 168 : timeRange === '3d' ? 72 : 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    // Build query
    const query = {
      createdAt: { $gte: startTime },
      $or: [
        { type: 'daily-digest', 'metadata.userId': userId },
        { type: { $in: ['posts', 'chats'] } }
      ]
    };
    
    if (podId) {
      query.podId = podId;
    }
    
    // Get summaries
    const summaries = await Summary.find(query).lean();
    
    if (summaries.length === 0) {
      return res.json({ keywords: [], message: 'No data available for the specified time range' });
    }
    
    // Extract keywords from stored analytics or fallback to summary content
    let keywords = [];
    
    // First try to get keywords from stored analytics
    summaries.forEach(summary => {
      if (summary.analytics?.keywords?.main_topics) {
        summary.analytics.keywords.main_topics.forEach(topic => {
          keywords.push({
            word: topic.keyword,
            frequency: topic.frequency,
            weight: topic.frequency / 10, // Normalize weight
            sentiment: topic.sentiment,
            context: topic.context,
            source: 'analytics'
          });
        });
      }
    });
    
    // If no keywords from analytics, fallback to extracting from summary content
    if (keywords.length === 0) {
      keywords = KeywordExtractionService.extractKeywords(summaries, { maxKeywords });
      keywords.forEach(keyword => {
        keyword.source = 'extracted';
      });
    }
    
    // Sort by frequency and limit
    keywords = keywords
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, maxKeywords);
    
    res.json({
      keywords,
      timeRange,
      totalSummaries: summaries.length,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error extracting keywords:', error);
    res.status(500).json({ error: 'Failed to extract keywords' });
  }
});

// GET /api/analytics/topics - Get topic clusters
router.get('/topics', auth, async (req, res) => {
  try {
    const { timeRange = '24h', clustered = 'true' } = req.query;
    const userId = req.user.id;
    
    // Calculate time range
    const hours = timeRange === '7d' ? 168 : timeRange === '3d' ? 72 : 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    // Get summaries
    const summaries = await Summary.find({
      createdAt: { $gte: startTime },
      $or: [
        { type: 'daily-digest', 'metadata.userId': userId },
        { type: { $in: ['posts', 'chats'] } }
      ]
    }).lean();
    
    if (summaries.length === 0) {
      return res.json({ topics: [], message: 'No data available for the specified time range' });
    }
    
    // Extract keywords first
    const keywords = KeywordExtractionService.extractKeywords(summaries, { maxKeywords: 30 });
    
    if (clustered === 'true') {
      // Generate topic clusters
      const topics = KeywordExtractionService.generateTopicClusters(keywords, summaries);
      res.json({
        topics,
        totalTopics: topics.length,
        timeRange,
        generatedAt: new Date().toISOString()
      });
    } else {
      // Return individual keywords as topics
      const topics = keywords.map(keyword => ({
        topic: KeywordExtractionService.generateTopicName(keyword.word),
        keywords: [keyword],
        strength: keyword.weight
      }));
      
      res.json({
        topics,
        totalTopics: topics.length,
        timeRange,
        generatedAt: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Error generating topics:', error);
    res.status(500).json({ error: 'Failed to generate topics' });
  }
});

// GET /api/analytics/activity - Get activity patterns
router.get('/activity', auth, async (req, res) => {
  try {
    const { timeRange = '7d', type = 'hourly' } = req.query;
    const userId = req.user.id;
    
    // Calculate time range
    const hours = timeRange === '30d' ? 720 : timeRange === '7d' ? 168 : 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    // Get summaries
    const summaries = await Summary.find({
      createdAt: { $gte: startTime },
      $or: [
        { type: 'daily-digest', 'metadata.userId': userId },
        { type: { $in: ['posts', 'chats'] } }
      ]
    }).lean();
    
    if (summaries.length === 0) {
      return res.json({ activity: [], message: 'No activity data available' });
    }
    
    // Analyze activity patterns
    const patterns = KeywordExtractionService.analyzeActivityPatterns(summaries);
    
    let activityData;
    switch (type) {
      case 'hourly':
        activityData = patterns.hourlyPattern;
        break;
      case 'daily':
        activityData = patterns.dailyPattern;
        break;
      case 'sentiment':
        activityData = patterns.sentimentTimeline;
        break;
      default:
        activityData = patterns.hourlyPattern;
    }
    
    res.json({
      activity: activityData,
      type,
      timeRange,
      totalDataPoints: activityData.length,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error analyzing activity:', error);
    res.status(500).json({ error: 'Failed to analyze activity' });
  }
});

// GET /api/analytics/users - Get user relationship data
router.get('/users', auth, async (req, res) => {
  try {
    const { timeRange = '7d' } = req.query;
    const userId = req.user.id;
    
    // Calculate time range
    const hours = timeRange === '30d' ? 720 : timeRange === '7d' ? 168 : 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    // Get summaries
    const summaries = await Summary.find({
      createdAt: { $gte: startTime },
      $or: [
        { type: 'daily-digest', 'metadata.userId': userId },
        { type: { $in: ['posts', 'chats'] } }
      ]
    }).lean();
    
    if (summaries.length === 0) {
      return res.json({ users: [], relationships: [], message: 'No user data available' });
    }
    
    // Extract user relationships
    const { userActivity, relationships } = KeywordExtractionService.extractUserRelationships(summaries);
    
    res.json({
      users: userActivity,
      relationships,
      timeRange,
      totalUsers: userActivity.length,
      totalRelationships: relationships.length,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error analyzing users:', error);
    res.status(500).json({ error: 'Failed to analyze user data' });
  }
});

// GET /api/analytics/trending - Get trending topics
router.get('/trending', auth, async (req, res) => {
  try {
    const { period = 'week' } = req.query;
    const userId = req.user.id;
    
    // Define time periods
    const currentHours = period === 'day' ? 24 : 168; // 1 day or 1 week
    const previousHours = currentHours * 2; // Compare with previous period
    
    const currentStart = new Date(Date.now() - currentHours * 60 * 60 * 1000);
    const previousStart = new Date(Date.now() - previousHours * 60 * 60 * 1000);
    
    // Get current period summaries
    const currentSummaries = await Summary.find({
      createdAt: { $gte: currentStart },
      $or: [
        { type: 'daily-digest', 'metadata.userId': userId },
        { type: { $in: ['posts', 'chats'] } }
      ]
    }).lean();
    
    // Get previous period summaries
    const previousSummaries = await Summary.find({
      createdAt: { $gte: previousStart, $lt: currentStart },
      $or: [
        { type: 'daily-digest', 'metadata.userId': userId },
        { type: { $in: ['posts', 'chats'] } }
      ]
    }).lean();
    
    if (currentSummaries.length === 0) {
      return res.json({ trending: [], message: 'No current data available for trending analysis' });
    }
    
    // Extract keywords from both periods
    const currentKeywords = KeywordExtractionService.extractKeywords(currentSummaries);
    const previousKeywords = KeywordExtractionService.extractKeywords(previousSummaries);
    
    // Identify trending topics
    const trending = KeywordExtractionService.identifyTrendingTopics(currentKeywords, previousKeywords);
    
    res.json({
      trending,
      period,
      currentPeriodSummaries: currentSummaries.length,
      previousPeriodSummaries: previousSummaries.length,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error analyzing trending topics:', error);
    res.status(500).json({ error: 'Failed to analyze trending topics' });
  }
});

// GET /api/analytics/summary - Get overall analytics summary
router.get('/summary', auth, async (req, res) => {
  try {
    const { timeRange = '24h' } = req.query;
    const userId = req.user.id;
    
    // Calculate time range
    const hours = timeRange === '7d' ? 168 : timeRange === '3d' ? 72 : 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    // Get summaries
    const summaries = await Summary.find({
      createdAt: { $gte: startTime },
      $or: [
        { type: 'daily-digest', 'metadata.userId': userId },
        { type: { $in: ['posts', 'chats'] } }
      ]
    }).lean();
    
    if (summaries.length === 0) {
      return res.json({ 
        summary: { totalSummaries: 0, totalActivity: 0 },
        message: 'No data available for analytics summary'
      });
    }
    
    // Calculate summary statistics
    const totalActivity = summaries.reduce((sum, s) => sum + (s.metadata?.totalItems || 0), 0);
    const uniqueUsers = new Set();
    const sentiments = [];
    
    summaries.forEach(summary => {
      if (summary.metadata?.topUsers) {
        summary.metadata.topUsers.forEach(user => uniqueUsers.add(user));
      }
      if (summary.analytics?.atmosphere?.overall_sentiment) {
        sentiments.push(summary.analytics.atmosphere.overall_sentiment);
      }
    });
    
    // Get top keywords
    const keywords = KeywordExtractionService.extractKeywords(summaries, { maxKeywords: 10 });
    
    // Calculate dominant sentiment
    const sentimentCounts = sentiments.reduce((acc, sentiment) => {
      acc[sentiment] = (acc[sentiment] || 0) + 1;
      return acc;
    }, {});
    
    const dominantSentiment = Object.entries(sentimentCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';
    
    res.json({
      summary: {
        timeRange,
        totalSummaries: summaries.length,
        totalActivity,
        uniqueUsers: uniqueUsers.size,
        dominantSentiment,
        topKeywords: keywords.slice(0, 5),
        activityTrend: totalActivity > 0 ? 'active' : 'quiet'
      },
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error generating analytics summary:', error);
    res.status(500).json({ error: 'Failed to generate analytics summary' });
  }
});


module.exports = router;