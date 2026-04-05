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
      getPodFeed: jest.fn(async () => ({ activities: [], hasMore: false })),
      getPendingApprovals: jest.fn(async () => []),
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
});
