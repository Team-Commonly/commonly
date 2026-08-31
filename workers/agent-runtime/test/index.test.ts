import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

// The router's two bearers. Admin does everything; the optional status token
// reads /status and nothing else. Every other route stays 401 for it, and an
// unset status token grants nothing.
const makeEnv = (overrides: Record<string, unknown> = {}) => {
  const stubFetch = vi.fn(async (req: Request) => Response.json({ routed: new URL(req.url).pathname, method: req.method }));
  const env = {
    RUNTIME_ADMIN_TOKEN: 'admin-secret',
    RUNTIME_STATUS_TOKEN: 'status-secret',
    COMMONLY_API_URL: 'https://api.test',
    AGENT: { idFromName: vi.fn(() => 'id'), get: vi.fn(() => ({ fetch: stubFetch })) },
    ...overrides,
  };
  return { env, stubFetch };
};

const call = (env: unknown, method: string, path: string, bearer?: string) => worker.fetch(
  new Request(`https://runtime.test${path}`, { method, headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }),
  env as never,
);

describe('router bearers', () => {
  it('503s when the admin token is unset, before any auth decision', async () => {
    const { env } = makeEnv({ RUNTIME_ADMIN_TOKEN: undefined });
    const res = await call(env, 'GET', '/agents/scout/default/status', 'status-secret');
    expect(res.status).toBe(503);
  });

  it('admin bearer reaches every route', async () => {
    const { env, stubFetch } = makeEnv();
    for (const [method, tail] of [['POST', '/provision'], ['POST', '/deprovision'], ['GET', '/status']] as const) {
      const res = await call(env, method, `/agents/scout/default${tail}`, 'admin-secret');
      expect(res.status).toBe(200);
    }
    expect(stubFetch).toHaveBeenCalledTimes(3);
  });

  it('status bearer reads /status and nothing else', async () => {
    const { env, stubFetch } = makeEnv();
    expect((await call(env, 'GET', '/agents/scout/default/status', 'status-secret')).status).toBe(200);
    expect((await call(env, 'POST', '/agents/scout/default/provision', 'status-secret')).status).toBe(401);
    expect((await call(env, 'POST', '/agents/scout/default/deprovision', 'status-secret')).status).toBe(401);
    expect((await call(env, 'POST', '/agents/scout/default/status', 'status-secret')).status).toBe(401);
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });

  it('an unset status token grants nothing; no bearer and a wrong bearer are 401', async () => {
    const { env } = makeEnv({ RUNTIME_STATUS_TOKEN: undefined });
    expect((await call(env, 'GET', '/agents/scout/default/status', 'status-secret')).status).toBe(401);
    expect((await call(env, 'GET', '/agents/scout/default/status')).status).toBe(401);
    expect((await call(env, 'GET', '/agents/scout/default/status', 'nope')).status).toBe(401);
  });

  it('404s an unrouted path (still behind the admin gate)', async () => {
    const { env } = makeEnv();
    expect((await call(env, 'GET', '/nope', 'admin-secret')).status).toBe(404);
    expect((await call(env, 'GET', '/nope', 'status-secret')).status).toBe(404);
  });

  it('a status token equal to the admin token refuses the configuration outright (503, every route, every bearer)', async () => {
    // Otto, #1374 round 2: when the secrets are byte-identical, the admin
    // check accepts the "status" bearer anyway — nothing downstream can
    // distinguish the holders. So the router refuses to serve at all.
    const { env, stubFetch } = makeEnv({ RUNTIME_STATUS_TOKEN: 'admin-secret' });
    expect((await call(env, 'POST', '/agents/scout/default/provision', 'admin-secret')).status).toBe(503);
    expect((await call(env, 'GET', '/agents/scout/default/status', 'admin-secret')).status).toBe(503);
    expect((await call(env, 'GET', '/agents/scout/default/status', 'status-secret')).status).toBe(503);
    expect(stubFetch).not.toHaveBeenCalled();
  });
});
