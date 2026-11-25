const mockTriggerSummarizer = jest.fn();

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});

const mockGetRecentSummaries = jest.fn();
jest.mock('../../../services/summarizerService', () => ({
  summarizeAllPosts: jest.fn().mockResolvedValue(null),
  constructor: { getRecentSummaries: (...args) => mockGetRecentSummaries(...args), garbageCollectForDigest: jest.fn() },
}));

const mockGetRecentChatSummariesByPodType = jest.fn();
const mockGetMultiplePodSummaries = jest.fn();
const mockSummarizePodMessages = jest.fn();
jest.mock('../../../services/chatSummarizerService', () => ({
  getMultiplePodSummaries: (...args) => mockGetMultiplePodSummaries(...args),
  summarizePodMessages: (...args) => mockSummarizePodMessages(...args),
  constructor: {
    getRecentChatSummariesByPodType: (...args) => mockGetRecentChatSummariesByPodType(...args),
    getLatestPodSummary: jest.fn(),
  },
}));

jest.mock('../../../services/schedulerService', () => ({
  getStatus: jest.fn(),
  constructor: { triggerSummarizer: (...args) => mockTriggerSummarizer(...args), summarizeIntegrationBuffers: jest.fn(), dispatchPodSummaryRequests: jest.fn() },
}));
jest.mock('../../../services/dailyDigestService', () => ({
  generateUserDailyDigest: jest.fn(),
  generateAllDailyDigests: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) },
}));

const mockCanViewPod = jest.fn();
jest.mock('../../../services/dmService', () => ({ canViewPod: (...args) => mockCanViewPod(...args) }));

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');

jest.mock('../../../models/Pod');
jest.mock('../../../models/User');
jest.mock('../../../models/Summary');

const routes = require('../../../routes/summaries');

const { DRIVER_TEXT, getRouteHandler, makeRes, expectNoLeak } = require('../../utils/routeHandler');

// F626: the debug trigger answers an unexpected failure with fixed text.
describe('summaries /debug 500', () => {
  let errorSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers fixed text and logs the cause', async () => {
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ role: 'admin' }) }) });
    mockTriggerSummarizer.mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await getRouteHandler(routes, '/debug', 'post')({ user: { id: 'a1' }, userId: 'a1' }, res);
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: 'Failed to trigger debug summarizer' });
    expectNoLeak(out);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('Error in debug summarizer:');
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('db.internal.example');
  });

  it('a 403 we wrote still passes through', async () => {
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ role: 'user' }) }) });
    const { res, out } = makeRes();
    await getRouteHandler(routes, '/debug', 'post')({ user: { id: 'u1' }, userId: 'u1' }, res);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: 'Global admin access required' });
  });
});
