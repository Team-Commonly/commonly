/**
 * Route rate-limit guard (readiness plan §3B row B3, 2026-09-12).
 *
 * Every `<router>.<verb>(path, …middleware)` under backend/routes must carry
 * a rate limiter AHEAD of any auth middleware. CodeQL's js/missing-rate-limiting
 * query found three such routes after they were pushed on 2026-09-11; this
 * test finds the next one before the push, in `npm test`.
 *
 * The rule is read from names, not behaviour — see
 * `__tests__/utils/routeRateLimitScan.js` for the classifier and its limits.
 * The canonical shape is routes/agentHooks.ts:
 *
 *   router.post('/pods/:podId/hooks', hookRateLimit, agentRuntimeAuth, …)
 *
 * with the limiter built inline from `express-rate-limit` and keyed by
 * `middleware/agentRateLimit.ts` (runtime tokens), `middleware/ipRateLimit.ts`
 * (anonymous callers) or `middleware/integrationRateLimit.ts` (connectors).
 *
 * `routeRateLimitGuard.baseline.json` lists every registration that already
 * violated the rule when the guard landed, keyed `file METHOD path [reason]`.
 * The baseline is a burn-down list in the sense of the parked eslint rules in
 * .eslintrc.js: it may only shrink. A new violation fails the first test and
 * must be fixed in the route, not added here. A baseline row that becomes
 * compliant (or whose route is removed or renamed) fails the second test and
 * must be deleted from the file, so the list never over-reports.
 */

const path = require('path');
const { scanRoutes, scanSource, violationKey } = require('../../utils/routeRateLimitScan');
const baseline = require('./routeRateLimitGuard.baseline.json');

const BACKEND_DIR = path.resolve(__dirname, '../../..');

const countBy = (keys) => keys.reduce((acc, key) => acc.set(key, (acc.get(key) || 0) + 1), new Map());

// Multiset difference: rows in `left` beyond what `right` accounts for.
const surplus = (left, right) => {
  const remaining = countBy(right);
  return left.filter((key) => {
    const n = remaining.get(key) || 0;
    if (n > 0) {
      remaining.set(key, n - 1);
      return false;
    }
    return true;
  });
};

describe('route rate-limit guard', () => {
  const rows = scanRoutes(BACKEND_DIR);
  const violations = rows.filter((row) => row.reason !== 'ok');
  const currentKeys = violations.map(violationKey);

  test('scans a non-trivial route surface', () => {
    expect(rows.length).toBeGreaterThan(300);
    expect(new Set(rows.map((row) => row.file)).size).toBeGreaterThan(50);
  });

  test('every new route registration carries a rate limiter ahead of auth', () => {
    const fresh = surplus(currentKeys, baseline);
    const detail = violations
      .filter((row) => fresh.includes(violationKey(row)))
      .map((row) => `  ${row.file}:${row.line}  ${row.method} ${row.path}  (${row.reason}`
        + `${row.auth ? `; auth=${row.auth}` : ''}${row.limiter ? `; limiter=${row.limiter}` : ''})`)
      .join('\n');
    if (fresh.length > 0) {
      throw new Error([
        'Route registrations without a rate limiter ahead of auth:',
        detail,
        'Fix the route, not the baseline:',
        "  import rateLimit from 'express-rate-limit';",
        '  const <name>RateLimit = rateLimit({ windowMs, max, keyGenerator, standardHeaders: true, legacyHeaders: false });',
        '  router.<verb>(path, <name>RateLimit, auth /* or agentRuntimeAuth, dualAuth */, handler);',
        'The limiter goes FIRST (routes/agentHooks.ts is the shape; key generators live in',
        'middleware/agentRateLimit.ts, ipRateLimit.ts, integrationRateLimit.ts). Auth does a',
        'Mongo lookup, so a limiter behind it protects nothing and CodeQL flags the route.',
      ].join('\n'));
    }
  });

  test('the baseline only lists registrations that still violate the rule', () => {
    const stale = surplus(baseline, currentKeys);
    if (stale.length > 0) {
      throw new Error([
        'Baseline rows that no longer match a violating registration (fixed, removed',
        'or renamed). Delete them from routeRateLimitGuard.baseline.json so the',
        'burn-down list stays honest:',
        stale.map((key) => `  ${key}`).join('\n'),
      ].join('\n'));
    }
  });

  test('the baseline is sorted and free of duplicates', () => {
    expect(baseline).toEqual([...baseline].sort());
    expect(new Set(baseline).size).toBe(baseline.length);
  });
});

describe('route rate-limit scanner classification', () => {
  const only = (lines) => scanSource(lines.join('\n'), 'routes/x.ts')
    .map(({ method, path: p, reason }) => ({ method, path: p, reason }));

  test('limiter before auth passes', () => {
    expect(only(["router.post('/a', fooRateLimit, auth, handler);"]))
      .toEqual([{ method: 'POST', path: '/a', reason: 'ok' }]);
  });

  test('limiter after auth is a violation', () => {
    expect(only(["router.post('/a', agentRuntimeAuth, fooRateLimit, handler);"]))
      .toEqual([{ method: 'POST', path: '/a', reason: 'limiter-after-auth' }]);
  });

  test('no limiter is a violation, with or without auth', () => {
    expect(only([
      "router.get('/a', auth, handler);",
      "router.get('/b', async (req, res) => res.json({}));",
    ])).toEqual([
      { method: 'GET', path: '/a', reason: 'unlimited' },
      { method: 'GET', path: '/b', reason: 'unlimited' },
    ]);
  });

  test('a preceding file-level router.use(limiter) covers later registrations only', () => {
    expect(only([
      "router.get('/before', auth, handler);",
      'router.use(fooRateLimit);',
      "router.get('/after', auth, handler);",
    ])).toEqual([
      { method: 'GET', path: '/before', reason: 'unlimited' },
      { method: 'GET', path: '/after', reason: 'ok' },
    ]);
  });

  test('inline rateLimit({...}) and limiter factories count as limiters', () => {
    expect(only([
      "router.post('/a', rateLimit({ windowMs: 60_000, max: 10 }), auth, handler);",
      "router.post('/b', taskWriteRateLimit(30), dualAuth, handler);",
    ])).toEqual([
      { method: 'POST', path: '/a', reason: 'ok' },
      { method: 'POST', path: '/b', reason: 'ok' },
    ]);
  });

  test('the word limit inside a handler body is not a limiter', () => {
    expect(only([
      "router.get('/a', auth, async (req, res) => { const limit = '20'; res.json({ limit }); });",
    ])).toEqual([{ method: 'GET', path: '/a', reason: 'unlimited' }]);
  });

  test('named routers, require<Capital> guards and the webhook signer are recognised', () => {
    expect(only([
      "catalogRouter.get('/a', requireAdmin, catalogRateLimit, handler);",
      "router.post('/events', signed, hookRateLimit, handler);",
    ])).toEqual([
      { method: 'GET', path: '/a', reason: 'limiter-after-auth' },
      { method: 'POST', path: '/events', reason: 'limiter-after-auth' },
    ]);
  });

  test('router.use mounts and non-literal first arguments are ignored', () => {
    expect(only([
      "router.use('/sub', subRouter);",
      'router.get(dynamicPath, auth, handler);',
    ])).toEqual([]);
  });
});
