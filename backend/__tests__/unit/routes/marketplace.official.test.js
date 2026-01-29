const request = require('supertest');
const express = require('express');

const marketplaceRoutes = require('../../../routes/marketplace');

describe('official marketplace route', () => {
  const app = express();
  app.use('/api/marketplace', marketplaceRoutes);

  it('returns official marketplace entries', async () => {
    const res = await request(app).get('/api/marketplace/official');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version');
    expect(Array.isArray(res.body.entries)).toBe(true);

    if (res.body.entries.length > 0) {
      const discord = res.body.entries.find((entry) => entry.id === 'discord');
      expect(discord).toBeTruthy();
      expect(discord).toHaveProperty('name');
      expect(discord).toHaveProperty('type');
    }
  });
});
