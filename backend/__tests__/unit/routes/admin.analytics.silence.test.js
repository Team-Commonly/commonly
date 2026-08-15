const request = require('supertest');
const express = require('express');

// GET /api/admin/analytics/silence — the pull half of the onboarding-silence
// alert (W4 item 2). The cron pushes; this exists so "did the fix work" is
// answerable without hand-reading production transcripts, which is how every
// onboarding defect was found on 2026-08-14.

let mockRole = 'admin';
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'admin1' };
  req.userId = 'admin1';
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => {
  if (mockRole !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  return next();
});
jest.mock('../../../middleware/ipRateLimit', () => ({
  cloudflareIpRateLimitKeyGenerator: () => 'test-key',
}));
jest.mock('../../../models/User', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ aggregate: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { distinct: jest.fn() } }));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const mockFind = jest.fn();
jest.mock('../../../models/OnboardingSilenceEpisode', () => ({ find: (...a) => mockFind(...a) }));

const routes = require('../../../routes/admin/analytics');

const chain = (rows) => ({
  sort: () => ({ limit: () => ({ lean: () => Promise.resolve(rows) }) }),
});

const ep = (over = {}) => ({
  _id: 'ep1',
  userId: 'u1',
  username: 'newcomer',
  podId: 'p1',
  podName: 'My Workspace',
  firstTypedAt: new Date('2026-08-15T11:30:00Z'),
  accountAgeMinutes: 12,
  messageCount: 2,
  status: 'open',
  eventSnapshot: {
    total: 0, byStatus: {}, targets: [], noneEnqueued: true,
  },
  ...over,
});

describe('GET /api/admin/analytics/silence', () => {
  let app;
  beforeEach(() => {
    jest.clearAllMocks();
    mockRole = 'admin';
    app = express();
    app.use('/api/admin/analytics', routes);
  });

  it('returns episodes with a diagnosis and a status split', async () => {
    mockFind.mockReturnValue(chain([
      ep(),
      ep({
        _id: 'ep2',
        status: 'resolved',
        outcome: 'human-rescued',
        resolutionLagSeconds: 36000,
        eventSnapshot: {
          total: 2, byStatus: { pending: 2 }, targets: ['scout/u1'], noneEnqueued: false,
        },
      }),
    ]));

    const res = await request(app).get('/api/admin/analytics/silence');

    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      episodes: 2, open: 1, resolved: 1, humanRescued: 1,
    });
    expect(res.body.totals.byDiagnosis).toEqual({
      'never-enqueued': 1, 'enqueued-never-answered': 1,
    });
    expect(res.body.thresholdMinutes).toBe(15);
  });

  it('reports whether an alert would actually reach anyone', async () => {
    mockFind.mockReturnValue(chain([]));
    delete process.env.ONBOARDING_ALERT_EMAIL;

    const res = await request(app).get('/api/admin/analytics/silence');

    // A dashboard that shows "0 stranded users" while delivery is unconfigured
    // is indistinguishable from a healthy funnel. Say which one it is.
    expect(res.body.alertRecipientConfigured).toBe(false);
  });

  it('clamps days to [1, 90]', async () => {
    mockFind.mockReturnValue(chain([]));

    const res = await request(app).get('/api/admin/analytics/silence?days=9999');

    expect(res.body.days).toBe(90);
  });

  it('403s non-admins', async () => {
    mockRole = 'user';
    const res = await request(app).get('/api/admin/analytics/silence');
    expect(res.status).toBe(403);
  });
});
