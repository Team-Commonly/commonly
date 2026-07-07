const request = require('supertest');
const express = require('express');

// Regression for the summaries-router membership gates: GET /pods and
// POST /pod/:podId/refresh were readable by ANY authed user for ANY podId
// (IDOR — same class as the uploads bug), and GET / leaked other users'
// daily digests + private-pod chat summaries. Every read here must run
// through DMService.canViewPod, mirroring GET /pod/:podId.

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

const mockCanViewPod = jest.fn();
jest.mock('../../../services/dmService', () => ({ canViewPod: (...args) => mockCanViewPod(...args) }));

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');

jest.mock('../../../models/Pod');
jest.mock('../../../models/User');
jest.mock('../../../models/Summary');

const routes = require('../../../routes/summaries');

const leanChain = (value) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) }) });

describe('summaries routes - pod visibility gates', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/summaries', routes);
    jest.clearAllMocks();
    // Non-admin caller by default (isGlobalAdminUser → false).
    User.findById.mockReturnValue(leanChain({ role: 'user' }));
  });

  describe('GET /pods', () => {
    it('only queries summaries for pods the caller can view', async () => {
      Pod.find.mockReturnValue(leanChain([
        { _id: 'p1', members: ['user1'], type: 'chat' },
        { _id: 'p2', members: ['other'], type: 'chat' },
      ]));
      mockCanViewPod.mockImplementation(async (uid, pod) => pod._id === 'p1');
      mockGetMultiplePodSummaries.mockResolvedValue({ p1: { content: 's1' } });

      const res = await request(app).get('/api/summaries/pods?podIds=p1,p2').expect(200);

      expect(mockGetMultiplePodSummaries).toHaveBeenCalledWith(['p1']);
      expect(res.body).toEqual({ p1: { content: 's1' } });
    });

    it('returns an empty object without querying when nothing is viewable', async () => {
      Pod.find.mockReturnValue(leanChain([{ _id: 'p2', members: ['other'], type: 'chat' }]));
      mockCanViewPod.mockResolvedValue(false);

      const res = await request(app).get('/api/summaries/pods?podIds=p2').expect(200);

      expect(res.body).toEqual({});
      expect(mockGetMultiplePodSummaries).not.toHaveBeenCalled();
    });
  });

  describe('POST /pod/:podId/refresh', () => {
    it('404s when the pod does not exist', async () => {
      Pod.findById.mockReturnValue(leanChain(null));
      await request(app).post('/api/summaries/pod/p1/refresh').send({}).expect(404);
    });

    it('403s non-members and never summarizes the pod', async () => {
      Pod.findById.mockReturnValue(leanChain({ _id: 'p1', members: ['other'], type: 'chat' }));
      mockCanViewPod.mockResolvedValue(false);

      await request(app).post('/api/summaries/pod/p1/refresh').send({}).expect(403);
      expect(mockSummarizePodMessages).not.toHaveBeenCalled();
    });
  });

  describe('GET / (recent summaries)', () => {
    it('drops private-pod summaries and other users\' digests, keeps own + global', async () => {
      mockGetRecentSummaries.mockResolvedValue([
        { _id: 's1', type: 'chats', podId: 'p1', content: 'mine' },
        { _id: 's2', type: 'chats', podId: 'p2', content: 'private' },
        { _id: 's3', type: 'daily-digest', metadata: { userId: 'user1' }, content: 'my digest' },
        { _id: 's4', type: 'daily-digest', metadata: { userId: 'other' }, content: 'their digest' },
        { _id: 's5', type: 'posts', content: 'global' },
      ]);
      Pod.find.mockReturnValue(leanChain([
        { _id: 'p1', members: ['user1'], type: 'chat' },
        { _id: 'p2', members: ['other'], type: 'chat' },
      ]));
      mockCanViewPod.mockImplementation(async (uid, pod) => pod._id === 'p1');

      const res = await request(app).get('/api/summaries/').expect(200);

      expect(res.body.map((s) => s._id)).toEqual(['s1', 's3', 's5']);
    });
  });

  describe('GET /chat-rooms', () => {
    it('filters out summaries of pods the caller cannot view', async () => {
      mockGetRecentChatSummariesByPodType.mockResolvedValue([
        { _id: 's1', type: 'chats', podId: 'p1' },
        { _id: 's2', type: 'chats', podId: 'p2' },
      ]);
      Pod.find.mockReturnValue(leanChain([
        { _id: 'p1', members: ['user1'], type: 'chat' },
        { _id: 'p2', members: ['other'], type: 'chat' },
      ]));
      mockCanViewPod.mockImplementation(async (uid, pod) => pod._id === 'p1');

      const res = await request(app).get('/api/summaries/chat-rooms').expect(200);
      expect(res.body.map((s) => s._id)).toEqual(['s1']);
    });
  });

  describe('admin-only triggers', () => {
    it('403s POST /debug for non-admins', async () => {
      await request(app).post('/api/summaries/debug').send({}).expect(403);
    });

    it('403s POST /daily-digest/trigger-all for non-admins', async () => {
      await request(app).post('/api/summaries/daily-digest/trigger-all').send({}).expect(403);
    });
  });
});
