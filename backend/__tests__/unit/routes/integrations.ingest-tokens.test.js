const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/User', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/Integration', () => ({
  findById: jest.fn(),
}));

const User = require('../../../models/User');
const Integration = require('../../../models/Integration');
const integrationRoutes = require('../../../routes/integrations');

const app = express();
app.use(express.json());
app.use('/api/integrations', integrationRoutes);

describe('integration ingest token routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockResolvedValue({ _id: 'user-1', role: 'admin' });
  });

  it('issues a new ingest token', async () => {
    const integration = {
      _id: 'integration-1',
      type: 'slack',
      createdBy: { toString: () => 'user-1' },
      ingestTokens: [],
      save: jest.fn().mockResolvedValue(true),
    };

    Integration.findById.mockResolvedValue(integration);

    const res = await request(app)
      .post('/api/integrations/integration-1/ingest-tokens')
      .send({ label: 'provider' });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^cm_int_/);
    expect(integration.ingestTokens.length).toBe(1);
    expect(integration.save).toHaveBeenCalled();
  });

  it('lists ingest tokens', async () => {
    const integration = {
      _id: 'integration-1',
      type: 'slack',
      createdBy: { toString: () => 'user-1' },
      ingestTokens: [
        {
          _id: 'token-1',
          label: 'Provider A',
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          lastUsedAt: null,
          createdBy: 'user-1',
        },
      ],
    };

    Integration.findById.mockResolvedValue(integration);

    const res = await request(app).get('/api/integrations/integration-1/ingest-tokens');

    expect(res.status).toBe(200);
    expect(res.body.tokens).toHaveLength(1);
    expect(res.body.tokens[0].label).toBe('Provider A');
  });

  it('revokes an ingest token', async () => {
    const integration = {
      _id: 'integration-1',
      type: 'slack',
      createdBy: { toString: () => 'user-1' },
      ingestTokens: [
        {
          _id: { toString: () => 'token-1' },
          label: 'Provider A',
          createdAt: new Date(),
        },
      ],
      save: jest.fn().mockResolvedValue(true),
    };

    Integration.findById.mockResolvedValue(integration);

    const res = await request(app)
      .delete('/api/integrations/integration-1/ingest-tokens/token-1');

    expect(res.status).toBe(200);
    expect(integration.ingestTokens).toHaveLength(0);
    expect(integration.save).toHaveBeenCalled();
  });
});
