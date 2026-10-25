const request = require('supertest');
const express = require('express');

jest.mock('../../../controllers/podController', () => ({
  getAllPods: jest.fn((req, res) => res.status(200).end()),
  getPodsByType: jest.fn((req, res) => res.status(200).end()),
  getPodById: jest.fn((req, res) => res.status(200).end()),
  createPod: jest.fn((req, res) => res.status(201).end()),
  joinPod: jest.fn((req, res) => res.status(200).end()),
  leavePod: jest.fn((req, res) => res.status(200).end()),
  removeMember: jest.fn((req, res) => res.status(200).end()),
  deletePod: jest.fn((req, res) => res.status(200).end()),
}));

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

const routes = require('../../../routes/pods');
const controllers = require('../../../controllers/podController');

describe('pods routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/pods', routes);

  it('GET /api/pods calls getAllPods', async () => {
    await request(app).get('/api/pods').expect(200);
    expect(controllers.getAllPods).toHaveBeenCalled();
  });

  it('POST /api/pods calls createPod', async () => {
    await request(app).post('/api/pods').send({}).expect(201);
    expect(controllers.createPod).toHaveBeenCalled();
  });

  it('GET /api/pods/type calls getPodsByType', async () => {
    await request(app).get('/api/pods/chat').expect(200);
    expect(controllers.getPodsByType).toHaveBeenCalled();
  });

  it('POST /api/pods/123/join calls joinPod', async () => {
    await request(app).post('/api/pods/123/join').expect(200);
    expect(controllers.joinPod).toHaveBeenCalled();
  });

  it('rate-limits direct join attempts to 20 per token per minute', async () => {
    const authorization = 'Bearer join-rate-limit-test';
    for (let index = 0; index < 20; index += 1) {
      await request(app)
        .post('/api/pods/123/join')
        .set('Authorization', authorization)
        .expect(200);
    }

    const limited = await request(app)
      .post('/api/pods/123/join')
      .set('Authorization', authorization)
      .expect(429);
    expect(limited.body.msg).toMatch(/20 pod joins per 60s/);
  });

  it.each([
    ['post', '/api/pods', 201, 'createPod'],
    ['post', '/api/pods/123/leave', 200, 'leavePod'],
    ['delete', '/api/pods/123/members/456', 200, 'removeMember'],
  ])('bounds lifecycle writes on %s %s without consuming another token’s budget', async (method, url, status, handler) => {
    const token = `Bearer lifecycle-${handler}`;
    const callsBefore = controllers[handler].mock.calls.length;
    for (let i = 0; i < 60; i += 1) {
      await request(app)[method](url).set('Authorization', token).expect(status);
    }
    await request(app)[method](url).set('Authorization', token).expect(429);
    expect(controllers[handler].mock.calls.length - callsBefore).toBe(60);
    await request(app)[method](url).set('Authorization', `${token}-other`).expect(status);
  });

  it('DELETE /api/pods/123/members/456 calls removeMember', async () => {
    await request(app).delete('/api/pods/123/members/456').expect(200);
    expect(controllers.removeMember).toHaveBeenCalled();
  });
});
