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
});
