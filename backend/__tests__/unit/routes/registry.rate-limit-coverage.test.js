/**
 * D175 follow-up: scoping the catalog limiter to catalog routes must not strip
 * rate limiting from the routers mounted after it. They used to inherit the
 * catalog's router-level limiter; they now share a registry-wide IP limiter
 * mounted right after the catalog, and generate-avatar (which calls a paid
 * image provider per request) also carries its own per-caller limiter.
 * Limiters skip themselves under NODE_ENV=test, so these guard the shape.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../../../middleware/auth', () => jest.fn((req, res, next) => next()));
jest.mock('../../../models/AgentRegistry', () => ({ AgentRegistry: {} }));
jest.mock('../../../services/agentIdentityService', () => ({}));
jest.mock('../../../routes/registry/helpers', () => ({ getUserId: jest.fn(), resolveUsername: jest.fn() }));
jest.mock('../../../utils/agentManifestRegistry', () => ({
  ManifestValidationError: class extends Error {},
  normalizePublishPayload: jest.fn(),
}));

describe('registry rate-limit coverage (D175)', () => {
  it('mounts a registry-wide limiter directly after the catalog router', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../routes/registry.ts'), 'utf8');
    const mounts = [...src.matchAll(/router\.use\((require\('\.\/registry\/([a-z-]+)'\)|rateLimit\()/g)]
      .map((m) => m[2] || 'LIMITER');
    const catalogAt = mounts.indexOf('catalog');
    expect(catalogAt).toBeGreaterThan(-1);
    expect(mounts[catalogAt + 1]).toBe('LIMITER');
    expect(mounts.filter((m) => m === 'LIMITER')).toHaveLength(1);
  });

  it('runs a limiter before auth on POST /generate-avatar', () => {
    const publishRouter = require('../../../routes/registry/publish');
    const layer = publishRouter.stack.find((l) => l.route && l.route.path === '/generate-avatar');
    expect(layer).toBeDefined();
    expect(typeof layer.route.stack[0].handle.resetKey).toBe('function');
  });

  it('gives every spelling of one token one shared avatar budget, through the route', async () => {
    // The limiter skips itself under NODE_ENV=test and reads it per request,
    // so lift that for this test only. auth is mocked to pass; the limiter
    // runs ahead of it, so the budget it enforces is the one under test.
    const express = require('express');
    const request = require('supertest');
    const publishRouter = require('../../../routes/registry/publish');
    const app = express();
    app.use(express.json());
    app.use(publishRouter);
    const spellings = [
      { Authorization: 'Bearer cm_avatar_budget' },
      { Authorization: 'cm_avatar_budget' },
      { 'x-auth-token': 'cm_avatar_budget' },
    ];
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const statuses = [];
      for (let i = 0; i < 11; i += 1) {
        // An empty body is answered 400 by the handler, after the limiter has counted it.
        // eslint-disable-next-line no-await-in-loop
        const res = await request(app).post('/generate-avatar').set(spellings[i % 3]).send({});
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
      expect(statuses[10]).toBe(429);

      const other = await request(app).post('/generate-avatar').set({ Authorization: 'Bearer cm_someone_else' }).send({});
      expect(other.status).toBe(400);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
