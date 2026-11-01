/**
 * D175 — the catalog's IP limiter must stay on the catalog's own routes.
 *
 * registry.ts mounts catalogRouter ahead of pod-agents, files, install and
 * the rest. A `catalogRouter.use(limiter)` therefore ran for EVERY
 * /api/registry/* request that reached it, and /v2/agents (one
 * `/pods/:podId/agents` read per pod) hit 429 on all 62 calls from its third
 * load on a 62-pod account (prod, 10-28). The limiter skips itself under
 * NODE_ENV=test, so this guards the shape instead: catalogRouter carries no
 * router-level middleware, and every route it declares runs the limiter.
 */

jest.mock('../../../middleware/auth', () => jest.fn((req, res, next) => next()));
jest.mock('../../../models/Pod', () => ({}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: { search: jest.fn(), getByName: jest.fn() },
  AgentInstallation: { find: jest.fn(), getInstalledAgents: jest.fn() },
}));

const catalogRouter = require('../../../routes/registry/catalog');

describe('catalog rate limiter scope (D175)', () => {
  const layers = catalogRouter.stack;

  it('has no router-level middleware that would run for later registry routers', () => {
    const routerLevel = layers.filter((layer) => !layer.route);
    expect(routerLevel).toHaveLength(0);
  });

  it('runs the same limiter on every catalog route, ahead of auth', () => {
    const routes = layers.filter((layer) => layer.route);
    expect(routes.length).toBeGreaterThan(0);
    const firstHandlers = routes.map((layer) => layer.route.stack[0].handle);
    const limiter = firstHandlers[0];
    expect(firstHandlers.every((handle) => handle === limiter)).toBe(true);
    // express-rate-limit's middleware exposes resetKey; auth does not.
    expect(typeof limiter.resetKey).toBe('function');
  });

  it('does not declare /pods/:podId/agents, which belongs to pod-agents', () => {
    const paths = layers.filter((layer) => layer.route).map((layer) => layer.route.path);
    expect(paths).not.toContain('/pods/:podId/agents');
  });
});
