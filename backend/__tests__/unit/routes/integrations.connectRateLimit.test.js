// TASK-261 — POST /:id/connect and POST /:id/disconnect carry the connector
// write limiter, ahead of auth, and spend the same bucket as every other
// connector write.
//
// `routeRateLimitGuard` reads NAMES, so it witnesses presence and mount order
// and nothing else: a route-local `rateLimit()` given a `*RateLimit*` name, or a
// bound nobody chose, satisfies it exactly as well as the shared limiter does.
// This suite loads the real `middleware/integrationRateLimit` and drives the
// real router, so what it measures is the count.
//
// No database. `Integration.findById` answers null, so every request the
// limiter lets through is the handler's own 404 — cheap, and distinguishable
// from the limiter's 429 by status and by body. `auth` counts its calls: a
// refusal that ran auth first would still be a 429 here, and the DB lookup auth
// does is the cost the limiter exists to spare.
//
// The budget and the 429 body are restated from the module (30 writes/60s), as
// its own suite does, so a change to either reddens this file too. The store is
// module-level and persists across tests, so each test presents its own token.
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => jest.fn((req, _res, next) => {
  req.user = { id: 'user-1' };
  next();
}));
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/DiscordIntegration', () => function DiscordIntegration(data) {
  Object.assign(this, data);
  this.save = jest.fn().mockResolvedValue(this);
});
jest.mock('../../../services/discordService', () => jest.fn().mockImplementation(() => ({
  connect: jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(true),
})));
jest.mock('../../../models/Integration', () => {
  function Integration(data) {
    Object.assign(this, data);
  }
  Integration.findById = jest.fn().mockResolvedValue(null);
  return Integration;
});

const auth = require('../../../middleware/auth');
const integrationRoutes = require('../../../routes/integrations');

const app = express();
app.use(express.json());
app.use('/api/integrations', integrationRoutes);

const WRITE_BUDGET = 30;
const WRITE_MSG = 'rate limit exceeded: 30 writes per 60s';

const token = (name) => ({ authorization: `Bearer ${name}` });

// Sequential on purpose: the limiter counts on arrival, so a concurrent burst
// would decide which request is refused by timing rather than by order.
const send = (paths, headers) => paths.reduce(
  (prior, path) => prior.then(async (seen) => {
    const res = await request(app).post(path).set(headers).send({});
    return seen.concat({ status: res.status, msg: res.body && res.body.msg });
  }),
  Promise.resolve([]),
);

const times = (n, path) => Array.from({ length: n }, () => path);

describe('the connector connect and disconnect routes are rate-limited (TASK-261)', () => {
  beforeEach(() => {
    auth.mockClear();
  });

  it.each(['connect', 'disconnect'])(
    '%s reaches its handler 30 times, then the limiter refuses before auth',
    async (verb) => {
      const path = `/api/integrations/i-261/${verb}`;
      const seen = await send(times(WRITE_BUDGET + 1, path), token(`t261-${verb}`));

      // Up to the bound, every answer is the handler's own 404, so a limiter
      // that refused early would show here rather than read as a passing loop.
      expect(seen.slice(0, WRITE_BUDGET).every((entry) => entry.status === 404)).toBe(true);
      expect(seen[WRITE_BUDGET]).toEqual({ status: 429, msg: WRITE_MSG });
      // 31 requests, 30 auth calls: the refused one never reached auth.
      expect(auth).toHaveBeenCalledTimes(WRITE_BUDGET);
    },
  );

  it('spends one bucket with the other connector writes, and a fresh credential has its own', async () => {
    const half = WRITE_BUDGET / 2;
    const spent = await send([
      ...times(half, '/api/integrations/i-261/connect'),
      ...times(half, '/api/integrations/i-261/disconnect'),
    ], token('t261-shared'));
    expect(spent.every((entry) => entry.status === 404)).toBe(true);

    // The create route has carried the shared limiter since #1297. A
    // route-local limiter on either verb would leave this bucket at 15 and let
    // the create through to its handler.
    const [create] = await send(['/api/integrations'], token('t261-shared'));
    expect(create).toEqual({ status: 429, msg: WRITE_MSG });

    // The control: the refusal above is this credential's spent bucket, not a
    // blanket one.
    const [fresh] = await send(['/api/integrations/i-261/connect'], token('t261-fresh'));
    expect(fresh.status).toBe(404);
  });
});
