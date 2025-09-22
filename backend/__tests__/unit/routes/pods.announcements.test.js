const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});

const Pod = require('../../../models/Pod');
const Announcement = require('../../../models/Announcement');

jest.mock('../../../models/Pod');
jest.mock('../../../models/Announcement');

const routes = require('../../../routes/pods');

describe('pods routes - announcements', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/pods', routes);
    jest.clearAllMocks();
  });

  it('creates an announcement successfully', async () => {
    const podSave = jest.fn();
    Pod.findById.mockResolvedValue({
      createdBy: { toString: () => 'user1' },
      announcements: [],
      save: podSave,
    });
    const annSave = jest.fn();
    Announcement.mockImplementation((data) => ({
      ...data,
      save: annSave,
      _id: 'a1',
    }));

    await request(app)
      .post('/api/pods/announcement')
      .send({ podId: 'p1', title: 't', content: 'c' })
      .expect(201);

    expect(Announcement).toHaveBeenCalledWith({
      podId: 'p1',
      title: 't',
      content: 'c',
      createdBy: 'user1',
    });
    expect(annSave).toHaveBeenCalled();
    expect(podSave).toHaveBeenCalled();
  });

  it('returns 400 when required fields missing', async () => {
    await request(app).post('/api/pods/announcement').send({}).expect(400);
  });

  it('returns 404 when pod not found', async () => {
    Pod.findById.mockResolvedValue(null);
    await request(app)
      .post('/api/pods/announcement')
      .send({ podId: 'p1', title: 't', content: 'c' })
      .expect(404);
  });

  it('returns 403 when user is not owner', async () => {
    Pod.findById.mockResolvedValue({ createdBy: { toString: () => 'other' } });
    await request(app)
      .post('/api/pods/announcement')
      .send({ podId: 'p1', title: 't', content: 'c' })
      .expect(403);
  });

  it('returns 404 when pod missing on announcements fetch', async () => {
    Pod.findById.mockResolvedValue(null);
    await request(app).get('/api/pods/p1/announcements').expect(404);
  });

  it('fetches announcements successfully', async () => {
    Pod.findById.mockResolvedValue({ members: ['user1'] });
    Announcement.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      populate: jest.fn().mockResolvedValue(['a1']),
    });
    const res = await request(app)
      .get('/api/pods/p1/announcements')
      .expect(200);
    expect(res.body).toEqual(['a1']);
  });
});
