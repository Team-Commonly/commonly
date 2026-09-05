const request = require('supertest');
const express = require('express');

jest.mock('../../../controllers/userController', () => ({
  getCurrentProfile: jest.fn((req, res) => res.status(200).end()),
  updateProfile: jest.fn((req, res) => res.status(200).end()),
  getUserById: jest.fn((req, res) => res.status(200).end()),
  getUserPublicActivity: jest.fn((req, res) => res.status(200).end()),
  followUser: jest.fn((req, res) => res.status(200).end()),
  unfollowUser: jest.fn((req, res) => res.status(200).end()),
}));

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const userId = req.get('authorization') || 'u1';
  req.user = { id: userId };
  req.userId = userId;
  next();
});

const buildApp = () => {
  // Re-import the router for every test so each rate limiter gets an isolated
  // memory store. Otherwise a quota test can make a later test pass or fail
  // because of requests it did not send.
  jest.resetModules();
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  const routes = require('../../../routes/users');
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  const controllers = require('../../../controllers/userController');
  const app = express();
  app.use(express.json());
  app.use('/api/users', routes);

  return { app, controllers };
};

describe('users social routes', () => {
  it('POST /api/users/:id/follow calls followUser', async () => {
    const { app, controllers } = buildApp();
    await request(app).post('/api/users/user123/follow').send({}).expect(200);
    expect(controllers.followUser).toHaveBeenCalled();
  });

  it('DELETE /api/users/:id/follow calls unfollowUser', async () => {
    const { app, controllers } = buildApp();
    await request(app).delete('/api/users/user123/follow').expect(200);
    expect(controllers.unfollowUser).toHaveBeenCalled();
  });

  it('GET /api/users/:id/public-activity calls getUserPublicActivity', async () => {
    const { app, controllers } = buildApp();
    await request(app).get('/api/users/user123/public-activity').expect(200);
    expect(controllers.getUserPublicActivity).toHaveBeenCalled();
  });

  it('PUT /api/users/profile mounts the profile write limiter', async () => {
    const { app, controllers } = buildApp();
    const response = await request(app).put('/api/users/profile').send({ displayName: 'Lily' });

    expect(response.status).toBe(200);
    expect(response.headers).toHaveProperty('ratelimit-policy');
    expect(response.headers['ratelimit-policy']).toContain('30;w=900');
    expect(controllers.updateProfile).toHaveBeenCalled();
  });

  it('lets each authenticated user use 30 profile writes and rejects the 31st', async () => {
    const { app } = buildApp();
    const accountA = 'Bearer account-a';
    const accountB = 'Bearer account-b';

    for (let attempt = 0; attempt < 30; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).put('/api/users/profile').set('Authorization', accountA).send({})
        .expect(200);
    }

    for (let attempt = 0; attempt < 30; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).put('/api/users/profile').set('Authorization', accountB).send({})
        .expect(200);
    }

    const capped = await request(app).put('/api/users/profile').set('Authorization', accountA).send({});
    expect(capped.status).toBe(429);
    expect(capped.headers['ratelimit-policy']).toContain('30;w=900');
    expect(capped.body).toEqual({ msg: 'rate limit exceeded: 30 profile writes per 15 minutes' });
  });

  it('rejects the 121st profile write from one address before auth', async () => {
    const { app } = buildApp();

    for (let attempt = 0; attempt < 120; attempt += 1) {
      // Unique credentials prove the ingress cap is independent of the
      // per-user limit mounted after auth.
      // eslint-disable-next-line no-await-in-loop
      await request(app).put('/api/users/profile')
        .set('Authorization', `Bearer ingress-account-${attempt}`)
        .send({})
        .expect(200);
    }

    const capped = await request(app).put('/api/users/profile')
      .set('Authorization', 'Bearer ingress-account-121')
      .send({});

    expect(capped.status).toBe(429);
    expect(capped.headers['ratelimit-policy']).toContain('120;w=900');
    expect(capped.body).toEqual({
      msg: 'rate limit exceeded: too many profile writes from this address',
    });
  });
});
