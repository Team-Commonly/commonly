const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  next();
});

jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
}));

jest.mock('../../../models/Integration', () => ({
  aggregate: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const Integration = require('../../../models/Integration');
const integrationRoutes = require('../../../routes/integrations');

function mockPodFind(pods) {
  const lean = jest.fn().mockResolvedValue(pods);
  const select = jest.fn().mockReturnValue({ lean });
  Pod.find.mockReturnValue({ select });
  return { select, lean };
}

describe('integration catalog route', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', integrationRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns manifest-driven catalog entries with per-type stats', async () => {
    mockPodFind([{ _id: 'pod-1' }, { _id: 'pod-2' }]);
    Integration.aggregate.mockResolvedValue([
      { _id: 'slack', count: 2 },
      { _id: 'discord', count: 1 },
    ]);

    const res = await request(app).get('/api/integrations/catalog');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);

    const slackEntry = res.body.entries.find((entry) => entry.id === 'slack');
    expect(slackEntry).toBeTruthy();
    expect(slackEntry.stats).toEqual({ activeIntegrations: 2 });
    expect(slackEntry.catalog?.label).toBe('Slack');
  });

  it('returns catalog entries even when the user has no pods', async () => {
    mockPodFind([]);
    Integration.aggregate.mockResolvedValue([]);

    const res = await request(app).get('/api/integrations/catalog');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);

    const discordEntry = res.body.entries.find((entry) => entry.id === 'discord');
    expect(discordEntry).toBeTruthy();
    expect(discordEntry.stats?.activeIntegrations || 0).toBe(0);
  });
});
