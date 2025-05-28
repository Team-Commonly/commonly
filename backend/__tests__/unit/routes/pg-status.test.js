const request = require('supertest');
const express = require('express');

jest.mock('../../../controllers/pgStatusController', () => ({
  checkStatus: jest.fn((req, res) => res.status(200).end()),
  syncUser: jest.fn((req, res) => res.status(200).end()),
}));

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

const routes = require('../../../routes/pg-status');
const controllers = require('../../../controllers/pgStatusController');

describe('pg status routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/pg/status', routes);

  it('GET /api/pg/status calls checkStatus', async () => {
    await request(app).get('/api/pg/status').expect(200);
    expect(controllers.checkStatus).toHaveBeenCalled();
  });
});
