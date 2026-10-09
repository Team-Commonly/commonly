/**
 * TASK-108 — the IP-tier limiter for the public/anon surface.
 *
 * Three claims, three kinds of test:
 *
 *   1. BEHAVIOUR — over budget answers 429 carrying `status` and a named
 *      platform reason, which is the body shape the triage doc's §6 asks for so
 *      a client can classify the refusal instead of reading it as silence.
 *   2. KEY — the bucket is the CALLER, not one shared bucket: two callers with
 *      different `cf-connecting-ip` do not consume each other's budget. That is
 *      what makes an "IP tier" an IP tier; TASK-110 established the generator,
 *      and this is the route-level witness that the new limiters use it.
 *   3. WIRING — the routes this row is about carry the limiter AHEAD of their
 *      auth middleware, at the exact budget declared for each.
 *
 * The behaviour tests build their OWN limiter through the factory rather than
 * importing a route's, because a route's budget (600/60s) cannot be exhausted
 * inside a test. The wiring test is a source scan for the same reason: the
 * budget is declared at the route, and a test reading a number back out of a
 * running app could not distinguish a missing limiter from a permissive one.
 *
 * The limiters named here are keyed by `cloudflareIpRateLimitKeyGenerator`,
 * whose doc carries the assumptions the key rests on (a ClusterIP controller
 * behind the tunnel, an edge that rejects a forged header) and the no-tunnel
 * case (TASK-120). None of that is re-asserted here — this file tests that the
 * surface uses that generator, not that the infrastructure around it holds.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { platformIpRateLimit, PLATFORM_RATE_LIMIT_REASON } = require('../../../middleware/platformRateLimit');

const BACKEND_ROOT = path.resolve(__dirname, '../../..');

const buildApp = (options) => {
  const app = express();
  app.get('/probe', platformIpRateLimit(options), (_req, res) => res.json({ ok: true }));
  return app;
};

// The 429 body is JSON; supertest parses it into `res.body`.
const probe = (app, headers = {}) => request(app).get('/probe').set(headers);

// Each entry is a route this row limits: the file, the limiter's variable name,
// and the budget that file declares. The budget is asserted from the source so
// that a number changing has to be a deliberate edit here too.
const WIRED = [
  {
    file: 'routes/auth.ts',
    limiter: 'registrationPolicyLimit',
    windowMs: '60_000',
    limit: 60,
    route: "'/registration-policy'",
  },
  {
    file: 'routes/auth.ts',
    limiter: 'verifyEmailLimit',
    windowMs: '60_000',
    limit: 30,
    route: "'/verify-email'",
  },
  {
    file: 'routes/stats.ts',
    limiter: 'statsPublicLimit',
    windowMs: '60_000',
    limit: 600,
    route: "'/public'",
  },
  {
    file: 'routes/admin/globalIntegrations.ts',
    limiter: 'xOauthCallbackLimit',
    windowMs: '60_000',
    limit: 600,
    route: "'/x/oauth/callback'",
  },
  {
    file: 'routes/discord.ts',
    limiter: 'discordCallbackLimit',
    windowMs: '60_000',
    limit: 600,
    route: "'/callback'",
  },
  {
    file: 'routes/agentsRuntime.ts',
    limiter: 'longPollIpLimit',
    windowMs: '60_000',
    limit: 3000,
    route: "'/events'",
  },
  {
    file: 'routes/agentsRuntime.ts',
    limiter: 'longPollIpLimit',
    windowMs: '60_000',
    limit: 3000,
    route: "'/bot/events'",
  },
];

const read = (file) => fs.readFileSync(path.join(BACKEND_ROOT, file), 'utf8');

/**
 * The arguments of a `router.verb(path, …)` call, split at depth 0 so that a
 * middleware's own call — `requireApiTokenScopes(['agent:events:read'])`, or the
 * handler's `(req, res)` — stays one argument.
 *
 * Splitting rather than searching is deliberate: `line.indexOf('auth')` appears
 * INSIDE `xOauthCallbackLimit`, so a substring search reports the limiter as
 * coming after auth on the very registration that proves the opposite.
 */
const middlewareArgs = (line) => {
  const open = line.indexOf('(', line.indexOf('router.'));
  const chars = Array.from(line.slice(open + 1));
  const args = [];
  let depth = 0;
  let current = '';
  chars.forEach((ch) => {
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      return;
    }
    current += ch;
  });
  if (current.trim()) args.push(current.trim());
  return args;
};

const AUTH_MIDDLEWARE = ['auth', 'adminAuth', 'agentRuntimeAuth', 'requireApiTokenScopes'];

const authIndex = (args) => args.findIndex((arg) => AUTH_MIDDLEWARE.some((name) => arg === name
  || arg.startsWith(`${name}.`) || arg.startsWith(`${name}(`)));

describe('platformIpRateLimit — the refusal a client has to be able to classify', () => {
  test('over budget answers 429 with status, the platform reason, and the legacy code', async () => {
    const app = buildApp({ windowMs: 60000, limit: 2, label: 'test budget' });
    await probe(app).expect(200);
    await probe(app).expect(200);
    const res = await probe(app).expect(429);
    expect(res.body).toEqual({
      status: 429,
      reason: 'platform_rate_limited',
      code: 'rate_limited',
      message: 'rate limit exceeded: test budget',
    });
  });

  test('the named reason cannot be mistaken for an upstream refusal', () => {
    // `cli/src/lib/claim-outcome.js` enumerates the kernel's refusal classes and
    // maps anything unknown to `delivery-refused`. A platform budget failure
    // reported as `upstream-refused` would record OUR limit as the model
    // provider's fault, which is a different fact about a different party.
    expect(PLATFORM_RATE_LIMIT_REASON).toBe('platform_rate_limited');
    expect(['upstream-refused', 'cascade-cap', 'delivery-refused']).not.toContain(PLATFORM_RATE_LIMIT_REASON);
    expect(PLATFORM_RATE_LIMIT_REASON).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe('platformIpRateLimit — the bucket is the caller', () => {
  test('a second caller is not charged for the first caller\'s requests', async () => {
    const app = buildApp({ windowMs: 60000, limit: 1, label: 'test budget' });
    await probe(app, { 'cf-connecting-ip': '203.0.113.7' }).expect(200);
    // Same caller: budget spent.
    await probe(app, { 'cf-connecting-ip': '203.0.113.7' }).expect(429);
    // A different caller has its own bucket — this is the property, and without
    // it every caller in the world shares one budget.
    await probe(app, { 'cf-connecting-ip': '203.0.113.8' }).expect(200);
    await probe(app, { 'cf-connecting-ip': '203.0.113.8' }).expect(429);
  });

  test('the budget is enforced per caller, so the shared bucket is not what expires', async () => {
    const app = buildApp({ windowMs: 60000, limit: 2, label: 'test budget' });
    const spendTwo = async (ip) => {
      await probe(app, { 'cf-connecting-ip': ip }).expect(200);
      await probe(app, { 'cf-connecting-ip': ip }).expect(200);
    };
    await spendTwo('198.51.100.4');
    await probe(app, { 'cf-connecting-ip': '198.51.100.4' }).expect(429);
    // Three fresh callers still get their own two each — sequential on purpose,
    // because a concurrent burst would not prove WHICH request spent the
    // bucket, and the claim is about per-caller accounting, not concurrency.
    await spendTwo('198.51.100.5');
    await spendTwo('198.51.100.6');
    await spendTwo('198.51.100.7');
  });
});

describe('platformIpRateLimit — wiring on the surface this row is about', () => {
  test.each(WIRED)('$file declares $limiter and mounts it on $route ahead of auth', (row) => {
    const source = read(row.file);
    const block = source.match(new RegExp(`const ${row.limiter} = platformIpRateLimit\\(\\{([\\s\\S]*?)\\n\\}\\);`));
    // Named in the message: a null here means the limiter was renamed, moved or
    // replaced by a hand-rolled `rateLimit({...})`, and those are three
    // different fixes.
    expect(block === null ? `${row.limiter} not declared in ${row.file}` : 'declared').toBe('declared');
    expect(block[1]).toMatch(new RegExp(`windowMs: ${row.windowMs},`));
    expect(block[1]).toMatch(new RegExp(`limit: ${row.limit},`));
    // The registration itself: limiter before any auth middleware, which is the
    // repo's own guard rule (routeRateLimitGuard) and the order that keeps a
    // refusal from costing the work auth would have done.
    const lines = source.split('\n').filter((line) => line.includes(row.route) && /router\.(get|post)\(/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach((line) => {
      const args = middlewareArgs(line);
      const limiterAt = args.indexOf(row.limiter);
      expect(limiterAt).toBeGreaterThan(-1);
      const authAt = authIndex(args);
      if (authAt > -1) expect(limiterAt).toBeLessThan(authAt);
    });
  });

  test('the factory is the only shape these routes use', () => {
    // A route that built its own `rateLimit({...})` here could quietly key on
    // the default `req.ip` (TASK-110's defect class) or emit the legacy body.
    WIRED.forEach((row) => {
      expect(read(row.file)).toContain('platformIpRateLimit');
    });
  });
});
