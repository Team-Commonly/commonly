const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = 'user123';
  req.user = { id: 'user123' };
  next();
});

jest.mock('../../../services/activityService', () => ({
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

const routes = require('../../../routes/activity');
const ActivityService = require('../../../services/activityService');

describe('activity read routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/activity', routes);

  it('GET /api/activity/unread-count calls getUnreadCount', async () => {
    await request(app).get('/api/activity/unread-count').expect(200);
    expect(ActivityService.getUnreadCount).toHaveBeenCalled();
  });

  it('POST /api/activity/mark-read with all:true calls markRead', async () => {
    await request(app).post('/api/activity/mark-read').send({ all: true }).expect(200);
    expect(ActivityService.markRead).toHaveBeenCalledWith('user123', expect.objectContaining({ all: true }));
  });

  it('POST /api/activity/mark-read without args returns 400', async () => {
    await request(app).post('/api/activity/mark-read').send({}).expect(400);
  });
});
