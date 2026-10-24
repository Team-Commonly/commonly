// The anonymous marketplace reads take the IP tier (300 per minute per IP).
// The route guard proves a limiter is registered by name; this proves the
// budget trips, on the one read that needs no database.
const request = require('supertest');
const express = require('express');

const marketplaceRoutes = require('../../../routes/marketplace');

describe('marketplace read limit', () => {
  it('answers 300 reads a minute from one IP, then a named 429', async () => {
    const app = express();
    app.use('/api/marketplace', marketplaceRoutes);
    for (let i = 0; i < 300; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await request(app).get('/api/marketplace/official');
      expect(ok.status).toBe(200);
    }
    const res = await request(app).get('/api/marketplace/official');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ reason: 'platform_rate_limited', code: 'rate_limited' });
  });
});
