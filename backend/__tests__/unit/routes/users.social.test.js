const request = require('supertest');
const express = require('express');

jest.mock('../../../controllers/userController', () => ({
  getCurrentProfile: jest.fn((req, res) => res.status(200).end()),
  updateProfile: jest.fn((req, res) => res.status(200).end()),
  getUserById: jest.fn((req, res) => res.status(200).end()),
  followUser: jest.fn((req, res) => res.status(200).end()),
  unfollowUser: jest.fn((req, res) => res.status(200).end()),
}));

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

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
});
