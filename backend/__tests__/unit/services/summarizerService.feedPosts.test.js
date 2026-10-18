/**
 * summarizePosts writes a pod-less 'posts' summary, so it reads feed posts
 * only (podId null), the same set summarizeAllPosts reads, and stamps the
 * summary metadata.source 'feed-posts' (services/summaryScope.ts). The
 * scheduler runs it only when LEGACY_SUMMARIZER_ENABLED=1; these tests set
 * that flag and call it directly, so re-enabling the legacy summarizer keeps
 * this behaviour.
 */
const mongoose = require('mongoose');

const mockGenerateText = jest.fn();
jest.mock('../../../services/llmService', () => ({ generateText: (...args) => mockGenerateText(...args) }));

const summarizerService = require('../../../services/summarizerService');
const Post = require('../../../models/Post');
// Registered for summarizePosts' populate('userId').
require('../../../models/User');
const Summary = require('../../../models/Summary');
const { FEED_POSTS_SOURCE, isFeedOnlySummary } = require('../../../services/summaryScope');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('summarizePosts reads feed posts only', () => {
  const savedFlag = process.env.LEGACY_SUMMARIZER_ENABLED;
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    process.env.LEGACY_SUMMARIZER_ENABLED = '1';
    mockGenerateText.mockReset().mockResolvedValue('A short summary.');
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    if (savedFlag === undefined) delete process.env.LEGACY_SUMMARIZER_ENABLED;
    else process.env.LEGACY_SUMMARIZER_ENABLED = savedFlag;
    jest.restoreAllMocks();
    await clearMongoDb();
  });

  test('a post in a pod never reaches the prompt or the count', async () => {
    const userId = new mongoose.Types.ObjectId();
    await Post.create({ userId, content: 'FEED-POST-ALPHA' });
    await Post.create({ userId, content: 'POD-POST-BETA', podId: new mongoose.Types.ObjectId() });

    const summary = await summarizerService.summarizePosts();

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const prompt = mockGenerateText.mock.calls[0][0];
    expect(prompt).toContain('FEED-POST-ALPHA');
    expect(prompt).not.toContain('POD-POST-BETA');
    expect(summary.podId).toBeUndefined();
    expect(summary.metadata.totalItems).toBe(1);
    expect(summary.metadata.source).toBe(FEED_POSTS_SOURCE);
    expect(isFeedOnlySummary(summary.toObject())).toBe(true);
  });

  test('an hour with only pod posts gets the empty summary, also stamped', async () => {
    await Post.create({ userId: new mongoose.Types.ObjectId(), content: 'POD-POST-GAMMA', podId: new mongoose.Types.ObjectId() });

    const summary = await summarizerService.summarizePosts();

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(summary.metadata.totalItems).toBe(0);
    expect(summary.content).not.toContain('POD-POST-GAMMA');
    expect(summary.metadata.source).toBe(FEED_POSTS_SOURCE);
    expect(await Summary.countDocuments({ type: 'posts' })).toBe(1);
  });
});

describe('isFeedOnlySummary', () => {
  test.each([
    ['a stamped pod-less posts summary', { type: 'posts', metadata: { source: FEED_POSTS_SOURCE } }, true],
    ['an unstamped pod-less posts summary', { type: 'posts', metadata: {} }, false],
    ['a stamped summary that names a pod', { type: 'posts', podId: 'p1', metadata: { source: FEED_POSTS_SOURCE } }, false],
    ['a pod-less chats summary', { type: 'chats', metadata: { source: FEED_POSTS_SOURCE } }, false],
    ['nothing', null, false],
  ])('%s → %s', (_label, summary, expected) => {
    expect(isFeedOnlySummary(summary)).toBe(expected);
  });
});
