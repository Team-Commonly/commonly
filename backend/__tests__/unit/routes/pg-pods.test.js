const request = require('supertest');
const express = require('express');

jest.mock('../../../controllers/pgPodController', () => ({
  getAllPods: jest.fn((req, res) => res.status(200).end()),
  getPodById: jest.fn((req, res) => res.status(200).end()),
  createPod: jest.fn((req, res) => res.status(201).end()),
  updatePod: jest.fn((req, res) => res.status(200).end()),
  deletePod: jest.fn((req, res) => res.status(200).end()),
  joinPod: jest.fn((req, res) => res.status(200).end()),
  leavePod: jest.fn((req, res) => res.status(200).end()),
}));

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

const routes = require('../../../routes/pg-pods');
const controllers = require('../../../controllers/pgPodController');

describe('pg pods routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/pg/pods', routes);

  it('GET /api/pg/pods calls getAllPods', async () => {
    await request(app).get('/api/pg/pods').expect(200);
    expect(controllers.getAllPods).toHaveBeenCalled();
  });
});
