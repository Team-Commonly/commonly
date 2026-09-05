// TASK-099 site 4 — follow-up to #1501.
//
// #1501 stopped `GET /api/summaries/all-posts` fabricating a filler summary
// and made the handler fail closed with 503. It did so UNCONDITIONALLY, so
// every throw out of `summarizeAllPosts` — a Mongo error, a TypeError in the
// post mapping, anything — reported as a transient outage. A 503 is an
// instruction to retry, and retrying a code defect never succeeds.
//
// These two cases differ only in the error the service throws. Before the
// fix both answered 503; the second is the one that must not.

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});

const mockSummarizeAllPosts = jest.fn();
jest.mock('../../../services/summarizerService', () => {
  // Mirror the real module: it exports the singleton AND the marker constant
  // the route matches on. A suite that mocks only the method leaves the
  // constant undefined, which is exactly the regression the route's `||`
  // fallback exists to stop — covered below.
  class SummaryUnavailableError extends Error {
    constructor(message) {
      super(message);
      this.name = 'SummaryUnavailableError';
      this.code = 'summary_unavailable';
    }
  }
  return {
    summarizeAllPosts: (...args) => mockSummarizeAllPosts(...args),
    SUMMARY_UNAVAILABLE: 'summary_unavailable',
    SummaryUnavailableError,
    constructor: { getRecentSummaries: jest.fn(), garbageCollectForDigest: jest.fn() },
  };
});

jest.mock('../../../services/chatSummarizerService', () => ({
  getMultiplePodSummaries: jest.fn(),
  summarizePodMessages: jest.fn(),
  constructor: { getRecentChatSummariesByPodType: jest.fn(), getLatestPodSummary: jest.fn() },
}));
jest.mock('../../../services/schedulerService', () => ({
  getStatus: jest.fn(),
  constructor: { triggerSummarizer: jest.fn(), summarizeIntegrationBuffers: jest.fn(), dispatchPodSummaryRequests: jest.fn() },
}));
jest.mock('../../../services/dailyDigestService', () => ({
  generateUserDailyDigest: jest.fn(),
  generateAllDailyDigests: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) },
}));
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn() }));
jest.mock('../../../models/Pod');
jest.mock('../../../models/User');
jest.mock('../../../models/Summary');

const request = require('supertest');
const express = require('express');

const { SummaryUnavailableError } = require('../../../services/summarizerService');
const routes = require('../../../routes/summaries');

describe('GET /api/summaries/all-posts — 503 means unavailable, not broken', () => {
  let app;
  let errorSpy;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/summaries', routes);
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => errorSpy.mockRestore());

  it('answers 503 when the LLM is unavailable', async () => {
    mockSummarizeAllPosts.mockRejectedValue(
      new SummaryUnavailableError('All-posts summary generation failed at the LLM: connect ECONNREFUSED'),
    );

    const res = await request(app).get('/api/summaries/all-posts');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'summary_unavailable' });
  });

  it('answers 503 when the rate-limit cooldown is armed', async () => {
    mockSummarizeAllPosts.mockRejectedValue(
      new SummaryUnavailableError('All-posts summary generation is cooling down after an LLM rate limit'),
    );

    const res = await request(app).get('/api/summaries/all-posts');

    expect(res.status).toBe(503);
  });

  it('answers 500 — not 503 — for a code defect inside the summarizer', async () => {
    // The measured case: injecting `(undefined).boom()` at the top of
    // summarizeAllPosts used to return `503 summary_unavailable`.
    mockSummarizeAllPosts.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'boom')"),
    );

    const res = await request(app).get('/api/summaries/all-posts');

    expect(res.status).toBe(500);
    expect(res.body).not.toEqual({ error: 'summary_unavailable' });
  });

  it('answers 500 for a datastore failure, which is not this endpoint being unavailable', async () => {
    // A Post.find() failure is a dependency outage, but it is not the one the
    // 503 sentence claims, and it is not something the caller fixes by
    // retrying this route. Fail closed loudly rather than mislabel it.
    mockSummarizeAllPosts.mockRejectedValue(new Error('MongoNetworkError: connection 3 to db timed out'));

    const res = await request(app).get('/api/summaries/all-posts');

    expect(res.status).toBe(500);
  });

  it('still returns the summary on the success path', async () => {
    mockSummarizeAllPosts.mockResolvedValue({ title: 'Community Overview • 3 recent posts', content: 'x', metadata: {} });

    const res = await request(app).get('/api/summaries/all-posts');

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Community Overview • 3 recent posts');
  });
});
