const request = require('supertest');
const express = require('express');

jest.mock('../../../controllers/podController', () => ({
  getAllPods: jest.fn((req, res) => res.status(200).end()),
  getPodsByType: jest.fn((req, res) => res.status(200).end()),
  getPodById: jest.fn((req, res) => res.status(200).end()),
  createPod: jest.fn((req, res) => res.status(201).end()),
  joinPod: jest.fn((req, res) => res.status(200).end()),
  leavePod: jest.fn((req, res) => res.status(200).end()),
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
});
