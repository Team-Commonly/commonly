const request = require('supertest');
const express = require('express');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/activity', require('../../../routes/activity'));
  return app;
};

describe('activity route identity handling', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('falls back to req.user._id when req.userId and req.user.id are missing', async () => {
    jest.doMock('../../../middleware/auth', () => (req, res, next) => {
      req.user = { _id: 'legacy-user-123' };
      next();
    });
    jest.doMock('../../../services/activityService', () => ({
      getUserFeed: jest.fn(async () => ({ activities: [], hasMore: false })),
      getRecap: jest.fn(async () => ({ needsYou: [], agents: [], board: [] })),
      getPodFeed: jest.fn(async () => ({ activities: [], hasMore: false })),
      getPendingApprovals: jest.fn(async () => []),
      acknowledgeMention: jest.fn(async () => ({ success: true })),
      toggleLike: jest.fn(async () => ({ success: true })),
      addReply: jest.fn(async () => ({ success: true })),
      approveActivity: jest.fn(async () => ({ success: true })),
      rejectActivity: jest.fn(async () => ({ success: true })),
      seedPodActivities: jest.fn(async () => ({ success: true, count: 1 })),
      getUnreadCount: jest.fn(async () => ({ unreadCount: 4 })),
      markRead: jest.fn(async () => ({ success: true })),
      isAgentUsername: jest.fn(() => false),
    }));

    const ActivityService = require('../../../services/activityService');
    const app = buildApp();

    await request(app).post('/api/activity/mark-read').send({ all: true }).expect(200);

    expect(ActivityService.markRead).toHaveBeenCalledWith(
      'legacy-user-123',
      expect.objectContaining({ all: true }),
    );
  });

  it('passes an exact human choice through the Activity route to DecisionRequest', async () => {
    jest.doMock('../../../middleware/auth', () => (req, res, next) => {
      req.userId = 'human-1';
      next();
    });
    jest.doMock('../../../services/decisionRequestService', () => ({
      chooseDecision: jest.fn(async () => ({ status: 200, body: { ok: true, decision: { id: 'decision-1' } } })),
      DecisionRequestError: class DecisionRequestError extends Error {},
    }));
    const DecisionRequestService = require('../../../services/decisionRequestService');
    const app = buildApp();

    await request(app)
      .post('/api/activity/decisions/decision-1/choose')
      .send({ value: 'Ship now' })
      .expect(200, { ok: true, decision: { id: 'decision-1' } });

    expect(DecisionRequestService.chooseDecision).toHaveBeenCalledWith({
      decisionId: 'decision-1', callerUserId: 'human-1', value: 'Ship now',
    });
  });
});
