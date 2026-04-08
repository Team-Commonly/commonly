// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const KeywordExtractionService = require('../services/keywordExtractionService');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');

interface AuthReq {
  user?: { id: string };
  query?: Record<string, string>;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/keywords', auth, async (req: AuthReq, res: Res) => {
  try {
    const { timeRange = '24h', podId, maxKeywords = '20' } = req.query || {};
    const userId = req.user?.id;
    const hours = timeRange === '7d' ? 168 : timeRange === '3d' ? 72 : 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    const query: Record<string, unknown> = { createdAt: { $gte: startTime }, $or: [{ type: 'daily-digest', 'metadata.userId': userId }, { type: { $in: ['posts', 'chats'] } }] };
    if (podId) query.podId = podId;
    const summaries = await Summary.find(query).lean() as Array<Record<string, unknown>>;
    if (!summaries.length) return res.json({ keywords: [], message: 'No data available for the specified time range' });
    let keywords: Array<Record<string, unknown>> = [];
    summaries.forEach((summary) => {
      const mainTopics = (summary.analytics as Record<string, unknown>)?.keywords as Record<string, unknown>;
      if (Array.isArray(mainTopics?.main_topics)) {
        (mainTopics.main_topics as Array<{ keyword: string; frequency: number; sentiment: string; context: string }>).forEach((topic) => {
          keywords.push({ word: topic.keyword, frequency: topic.frequency, weight: topic.frequency / 10, sentiment: topic.sentiment, context: topic.context, source: 'analytics' });
        });
      }
    });
    if (!keywords.length) {
      keywords = KeywordExtractionService.extractKeywords(summaries, { maxKeywords: Number(maxKeywords) });
      keywords.forEach((kw) => { kw.source = 'extracted'; });
    }
    keywords = keywords.sort((a, b) => (b.frequency as number) - (a.frequency as number)).slice(0, Number(maxKeywords));
    return res.json({ keywords, timeRange, totalSummaries: summaries.length, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error extracting keywords:', error);
    return res.status(500).json({ error: 'Failed to extract keywords' });
  }
});

router.get('/topics', auth, async (req: AuthReq, res: Res) => {
  try {
    const { timeRange = '24h', clustered = 'true' } = req.query || {};
    const userId = req.user?.id;
    const hours = timeRange === '7d' ? 168 : timeRange === '3d' ? 72 : 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    const summaries = await Summary.find({ createdAt: { $gte: startTime }, $or: [{ type: 'daily-digest', 'metadata.userId': userId }, { type: { $in: ['posts', 'chats'] } }] }).lean();
    if (!summaries.length) return res.json({ topics: [], message: 'No data available for the specified time range' });
    const keywords = KeywordExtractionService.extractKeywords(summaries, { maxKeywords: 30 });
    if (clustered === 'true') {
      const topics = KeywordExtractionService.generateTopicClusters(keywords, summaries);
      return res.json({ topics, totalTopics: topics.length, timeRange, generatedAt: new Date().toISOString() });
    }
    const topics = keywords.map((kw: { word: string; weight: number }) => ({ topic: KeywordExtractionService.generateTopicName(kw.word), keywords: [kw], strength: kw.weight }));
    return res.json({ topics, totalTopics: topics.length, timeRange, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error generating topics:', error);
    return res.status(500).json({ error: 'Failed to generate topics' });
  }
});

router.get('/activity', auth, async (req: AuthReq, res: Res) => {
  try {
    const { timeRange = '7d', type = 'hourly' } = req.query || {};
    const userId = req.user?.id;
    const hours = timeRange === '30d' ? 720 : timeRange === '7d' ? 168 : 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    const summaries = await Summary.find({ createdAt: { $gte: startTime }, $or: [{ type: 'daily-digest', 'metadata.userId': userId }, { type: { $in: ['posts', 'chats'] } }] }).lean();
    if (!summaries.length) return res.json({ activity: [], message: 'No activity data available' });
    const patterns = KeywordExtractionService.analyzeActivityPatterns(summaries) as { hourlyPattern: unknown; dailyPattern: unknown; sentimentTimeline: unknown };
    const activityData = type === 'daily' ? patterns.dailyPattern : type === 'sentiment' ? patterns.sentimentTimeline : patterns.hourlyPattern;
    return res.json({ activity: activityData, type, timeRange, totalDataPoints: (activityData as unknown[]).length, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error analyzing activity:', error);
    return res.status(500).json({ error: 'Failed to analyze activity' });
  }
});

router.get('/users', auth, async (req: AuthReq, res: Res) => {
  try {
    const { timeRange = '7d' } = req.query || {};
    const userId = req.user?.id;
    const hours = timeRange === '30d' ? 720 : timeRange === '7d' ? 168 : 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    const summaries = await Summary.find({ createdAt: { $gte: startTime }, $or: [{ type: 'daily-digest', 'metadata.userId': userId }, { type: { $in: ['posts', 'chats'] } }] }).lean();
    if (!summaries.length) return res.json({ users: [], relationships: [], message: 'No user data available' });
    const { userActivity, relationships } = KeywordExtractionService.extractUserRelationships(summaries) as { userActivity: unknown[]; relationships: unknown[] };
    return res.json({ users: userActivity, relationships, timeRange, totalUsers: userActivity.length, totalRelationships: relationships.length, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error analyzing users:', error);
    return res.status(500).json({ error: 'Failed to analyze user data' });
  }
});

router.get('/trending', auth, async (req: AuthReq, res: Res) => {
  try {
    const { period = 'week' } = req.query || {};
    const userId = req.user?.id;
    const currentHours = period === 'day' ? 24 : 168;
    const previousHours = currentHours * 2;
    const currentStart = new Date(Date.now() - currentHours * 60 * 60 * 1000);
    const previousStart = new Date(Date.now() - previousHours * 60 * 60 * 1000);
    const [currentSummaries, previousSummaries] = await Promise.all([
      Summary.find({ createdAt: { $gte: currentStart }, $or: [{ type: 'daily-digest', 'metadata.userId': userId }, { type: { $in: ['posts', 'chats'] } }] }).lean(),
      Summary.find({ createdAt: { $gte: previousStart, $lt: currentStart }, $or: [{ type: 'daily-digest', 'metadata.userId': userId }, { type: { $in: ['posts', 'chats'] } }] }).lean(),
    ]);
    if (!currentSummaries.length) return res.json({ trending: [], message: 'No current data available for trending analysis' });
    const currentKeywords = KeywordExtractionService.extractKeywords(currentSummaries);
    const previousKeywords = KeywordExtractionService.extractKeywords(previousSummaries);
    const trending = KeywordExtractionService.identifyTrendingTopics(currentKeywords, previousKeywords);
    return res.json({ trending, period, currentPeriodSummaries: currentSummaries.length, previousPeriodSummaries: previousSummaries.length, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error analyzing trending topics:', error);
    return res.status(500).json({ error: 'Failed to analyze trending topics' });
  }
});

router.get('/summary', auth, async (req: AuthReq, res: Res) => {
  try {
    const { timeRange = '24h' } = req.query || {};
    const userId = req.user?.id;
    const hours = timeRange === '7d' ? 168 : timeRange === '3d' ? 72 : 24;
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    const summaries = await Summary.find({ createdAt: { $gte: startTime }, $or: [{ type: 'daily-digest', 'metadata.userId': userId }, { type: { $in: ['posts', 'chats'] } }] }).lean() as Array<Record<string, unknown>>;
    if (!summaries.length) return res.json({ summary: { totalSummaries: 0, totalActivity: 0 }, message: 'No data available for analytics summary' });
    const totalActivity = summaries.reduce((sum, s) => sum + (((s.metadata as Record<string, unknown>)?.totalItems as number) || 0), 0);
    const uniqueUsers = new Set<string>();
    const sentiments: string[] = [];
    summaries.forEach((s) => {
      const topUsers = (s.metadata as Record<string, unknown>)?.topUsers as string[] | undefined;
      if (topUsers) topUsers.forEach((user) => uniqueUsers.add(user));
      const sentiment = ((s.analytics as Record<string, unknown>)?.atmosphere as Record<string, unknown>)?.overall_sentiment as string | undefined;
      if (sentiment) sentiments.push(sentiment);
    });
    const keywords = KeywordExtractionService.extractKeywords(summaries, { maxKeywords: 10 });
    const sentimentCounts = sentiments.reduce<Record<string, number>>((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {});
    const dominantSentiment = Object.entries(sentimentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';
    return res.json({ summary: { timeRange, totalSummaries: summaries.length, totalActivity, uniqueUsers: uniqueUsers.size, dominantSentiment, topKeywords: keywords.slice(0, 5), activityTrend: totalActivity > 0 ? 'active' : 'quiet' }, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error generating analytics summary:', error);
    return res.status(500).json({ error: 'Failed to generate analytics summary' });
  }
});

module.exports = router;

export {};
