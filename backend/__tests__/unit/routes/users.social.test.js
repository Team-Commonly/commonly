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
  req.user = { id: 'u1' };
  req.userId = 'u1';
  next();
});

const routes = require('../../../routes/users');
const controllers = require('../../../controllers/userController');

describe('users social routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/users', routes);

  it('POST /api/users/:id/follow calls followUser', async () => {
    await request(app).post('/api/users/user123/follow').send({}).expect(200);
    expect(controllers.followUser).toHaveBeenCalled();
  });

  it('DELETE /api/users/:id/follow calls unfollowUser', async () => {
    await request(app).delete('/api/users/user123/follow').expect(200);
    expect(controllers.unfollowUser).toHaveBeenCalled();
  });

  it('GET /api/users/:id/public-activity calls getUserPublicActivity', async () => {
    await request(app).get('/api/users/user123/public-activity').expect(200);
    expect(controllers.getUserPublicActivity).toHaveBeenCalled();
  });

  it('PUT /api/users/profile mounts the profile write limiter', async () => {
    const response = await request(app).put('/api/users/profile').send({ displayName: 'Lily' });

    expect(response.status).toBe(200);
    expect(response.headers).toHaveProperty('ratelimit-policy');
    expect(response.headers['ratelimit-policy']).toContain('30;w=900');
    expect(controllers.updateProfile).toHaveBeenCalled();
  });

  it('keys profile writes by authenticated credentials before auth runs', async () => {
    const accountA = 'Bearer account-a';
    const accountB = 'Bearer account-b';

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await request(app).put('/api/users/profile').set('Authorization', accountA).send({}).expect(200);
    }

    await request(app).put('/api/users/profile').set('Authorization', accountB).send({}).expect(200);
    await request(app).put('/api/users/profile').set('Authorization', accountA).send({}).expect(429);
  });
});
