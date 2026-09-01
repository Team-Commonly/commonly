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
      ruleTaskDecision: jest.fn(async () => ({ status: 200, body: { ok: true, ruling: 'Ship now' } })),
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

  it('passes a typed DECIDE option through the Activity route to the board ruling service', async () => {
    jest.doMock('../../../middleware/auth', () => (req, res, next) => {
      req.userId = 'human-1';
      next();
    });
    jest.doMock('../../../services/activityService', () => ({
      ruleTaskDecision: jest.fn(async () => ({ status: 200, body: { ok: true, ruling: 'Ship now' } })),
    }));
    const ActivityService = require('../../../services/activityService');
    const app = buildApp();

    await request(app)
      .post('/api/activity/tasks/TASK-024/rule')
      .send({ podId: 'pod-1', option: 'Ship now' })
      .expect(200, { ok: true, ruling: 'Ship now' });

    expect(ActivityService.ruleTaskDecision).toHaveBeenCalledWith({
      podId: 'pod-1', taskId: 'TASK-024', option: 'Ship now', userId: 'human-1',
    });
  });
});
