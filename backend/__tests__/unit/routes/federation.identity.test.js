const request = require('supertest');
const express = require('express');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/federation', require('../../../routes/federation'));
  return app;
};

const buildPod = (userId, role = 'member') => ({
  _id: 'pod-1',
  members: [{ userId, role }],
});

describe('federation route identity handling', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('accepts req.userId without req.user._id', async () => {
    jest.doMock('../../../middleware/auth', () => (req, res, next) => {
      req.userId = 'user-from-user-id';
      req.user = { id: 'user-from-user-id' };
      next();
    });
    jest.doMock('../../../models/Pod', () => ({
      findById: jest.fn(() => ({
        lean: jest.fn().mockResolvedValue(buildPod('user-from-user-id')),
      })),
    }));
    jest.doMock('../../../models/PodLink', () => ({
      getLinksForPod: jest.fn().mockResolvedValue([]),
    }));
    jest.doMock('../../../services/federationService', () => ({}));

    const PodLink = require('../../../models/PodLink');
    const app = buildApp();

    const res = await request(app).get('/api/federation/pods/pod-1/links').expect(200);

    expect(res.body).toEqual({ links: [] });
    expect(PodLink.getLinksForPod).toHaveBeenCalledWith('pod-1', 'both');
  });

  it('accepts legacy req.user._id', async () => {
    jest.doMock('../../../middleware/auth', () => (req, res, next) => {
      req.user = { _id: 'legacy-user-id' };
      next();
    });
    jest.doMock('../../../models/Pod', () => ({
      findById: jest.fn(() => ({
        lean: jest.fn().mockResolvedValue(buildPod('legacy-user-id')),
      })),
    }));
    jest.doMock('../../../models/PodLink', () => ({
      getLinksForPod: jest.fn().mockResolvedValue([]),
    }));
    jest.doMock('../../../services/federationService', () => ({}));

    const PodLink = require('../../../models/PodLink');
    const app = buildApp();

    await request(app).get('/api/federation/pods/pod-1/links').expect(200);

    expect(PodLink.getLinksForPod).toHaveBeenCalledWith('pod-1', 'both');
  });
});
