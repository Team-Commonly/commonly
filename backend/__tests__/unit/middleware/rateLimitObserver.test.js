// @ts-nocheck
// TASK-109 / TASK-097 §6: the watermark log that makes the fleet's real
// per-token request rate measurable, so the mount-level decision `(A)` is taken
// on a reading rather than a derivation.
//
// Three tiers of test here, deliberately:
//   - unit: the gating (flag, watermark), the emitted field set, and the
//     properties that make it safe to deploy (inert until enabled, always calls
//     next, a throwing sink cannot break a route);
//   - against the REAL limiter (express + express-rate-limit, the installed
//     version), because what this middleware reports is `req.rateLimit`, and
//     that shape belongs to the dependency rather than to us;
//   - the two assertions Vera asked for rather than assumed (71402): that with
//     two limiters stacked the reading is the TOKEN tier and not the IP tier,
//     and that the middleware is a no-op with the flag unset.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const supertest = require('supertest');

const {
  createRateLimitObserver,
  isObserveEnabled,
  observeWatermark,
  correlationKey,
  secondsUntilReset,
  DEFAULT_OBSERVE_WATERMARK,
  KEY_CORRELATION_LENGTH,
} = require('../../../middleware/rateLimitObserver');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const ENV_ON = { RATE_LIMIT_OBSERVE: 'true' };
const FIXED_NOW = new Date('2026-09-23T05:00:00.000Z');
const RESET_AT = new Date(FIXED_NOW.getTime() + 45_000);

const FULL_HASH = sha('Bearer cm_agent_secretvalue');
const FULL_TOKEN_KEY = `tok:${FULL_HASH}`;

/** A request as the limiter leaves it: rateLimit set, nothing else needed. */
const limitedReq = (rateLimitInfo, extras = {}) => ({
  rateLimit: rateLimitInfo,
  headers: {},
  method: 'POST',
  url: '/api/agents/runtime/pods/6a8f6dc7a1dccf2e02f31015/messages',
  ip: '203.0.113.7',
  ...extras,
});

const counter = (overrides = {}) => ({
  limit: 120,
  used: 60,
  remaining: 60,
  resetTime: RESET_AT,
  key: FULL_TOKEN_KEY,
  ...overrides,
});

const run = (observer, req) => {
  const next = jest.fn();
  observer(req, {}, next);
  return next;
};

const collect = (options = {}) => {
  const entries = [];
  const observer = createRateLimitObserver({
    env: { ...ENV_ON, ...options.env },
    sink: (e) => entries.push(e),
    replica: 'replica-a',
    now: () => FIXED_NOW,
    ...options.observer,
  });
  return { entries, observer };
};

describe('rateLimitObserver — the flag decides whether anything is read at all', () => {
  it('emits nothing when the flag is absent', () => {
    const entries = [];
    const observer = createRateLimitObserver({
      env: {},
      sink: (e) => entries.push(e),
      replica: 'replica-a',
    });
    run(observer, limitedReq(counter({ used: 120, remaining: 0 })));
    expect(entries).toEqual([]);
  });

  it.each(['0', 'off', 'false', 'no', '', '  ', 'TRUE-ish'])(
    'treats %p as off',
    (value) => {
      expect(isObserveEnabled({ RATE_LIMIT_OBSERVE: value })).toBe(false);
    },
  );

  it.each(['1', 'true', 'TRUE', ' yes ', 'On'])('treats %p as on', (value) => {
    expect(isObserveEnabled({ RATE_LIMIT_OBSERVE: value })).toBe(true);
  });

  // Ops flip the flag on a deployment story; nothing captures it at import time,
  // so a change takes effect on the next request.
  it('reads the flag per request, not at construction', () => {
    const env = {};
    const entries = [];
    const observer = createRateLimitObserver({
      env,
      sink: (e) => entries.push(e),
      replica: 'replica-a',
    });
    const req = limitedReq(counter({ used: 120, remaining: 0 }));
    run(observer, req);
    expect(entries).toHaveLength(0);
    env.RATE_LIMIT_OBSERVE = 'true';
    run(observer, req);
    expect(entries).toHaveLength(1);
  });
});

describe('rateLimitObserver — the watermark decides which requests are worth a line', () => {
  it('stays silent below the watermark and speaks at it', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq(counter({ used: 59, remaining: 61 })));
    expect(entries).toHaveLength(0);
    run(observer, limitedReq(counter({ used: 60, remaining: 60 })));
    expect(entries).toHaveLength(1);
  });

  it('defaults the watermark to half the token tier', () => {
    expect(DEFAULT_OBSERVE_WATERMARK).toBe(60);
    expect(observeWatermark({})).toBe(60);
  });

  it('honours an override', () => {
    const { entries, observer } = collect({ env: { RATE_LIMIT_OBSERVE_WATERMARK: '100' } });
    run(observer, limitedReq(counter({ used: 60 })));
    expect(entries).toHaveLength(0);
    run(observer, limitedReq(counter({ used: 100, remaining: 20 })));
    expect(entries).toHaveLength(1);
  });

  // A typo must not read as "the fleet is idle" — the failure mode of a silent
  // instrument is indistinguishable from the failure mode of no traffic.
  it.each(['abc', '0', '-5', ''])('falls back to the default for watermark %p', (value) => {
    expect(observeWatermark({ RATE_LIMIT_OBSERVE_WATERMARK: value })).toBe(DEFAULT_OBSERVE_WATERMARK);
  });

  it('emits nothing, and does not throw, when no limiter ran', () => {
    const { entries, observer } = collect();
    const next = run(observer, { headers: {}, method: 'GET', url: '/unlimited' });
    expect(entries).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('emits nothing when the limiter left no numeric counter', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq({ limit: 120, remaining: 0, resetTime: RESET_AT, key: FULL_TOKEN_KEY }));
    expect(entries).toEqual([]);
  });

  // A coerced counter would emit `used: '120'`, a line that looks like a reading
  // and is a fabrication. The types are the contract.
  it('emits nothing when the counter arrives as a string', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq(counter({ used: '120' })));
    expect(entries).toEqual([]);
  });
});

describe('rateLimitObserver — what a line carries, and what it never carries', () => {
  it('emits the counter, the bucket, the route pattern, the window and the replica', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq(counter({ used: 61, remaining: 59 }), { route: { path: '/pods/:podId/messages' } }));
    expect(entries).toEqual([
      {
        event: 'agent_rate_limit_watermark',
        key: `tok:${FULL_HASH.slice(0, KEY_CORRELATION_LENGTH)}`,
        route: '/pods/:podId/messages',
        used: 61,
        resetInSeconds: 45,
        replica: 'replica-a',
      },
    ]);
  });

  it('pins the emitted field set — the line is a counter, not a traffic log', () => {
    const { entries, observer } = collect();
    run(
      observer,
      limitedReq(counter({ used: 120, remaining: 0 }), {
        authorization: 'Bearer cm_agent_secretvalue',
        'cf-connecting-ip': '198.51.100.10',
        originalUrl: '/api/agents/runtime/pods/6a8f6dc7a1dccf2e02f31015/messages?foo=bar',
        route: { path: '/pods/:podId/messages' },
      }),
    );
    // `limit` and `remaining` are absent by spec: one repeats a constant, the
    // other is arithmetic on the fields that are here.
    expect(Object.keys(entries[0]).sort()).toEqual(
      ['event', 'key', 'replica', 'resetInSeconds', 'route', 'used'].sort(),
    );
    const line = JSON.stringify(entries[0]);
    expect(line).not.toContain('cm_agent_secretvalue');
    expect(line).not.toContain(FULL_HASH);
    // The route pattern is the pattern: ids and query strings stay out.
    expect(line).not.toContain('6a8f6dc7a1dccf2e02f31015');
    expect(line).not.toContain('foo=bar');
    expect(line).not.toContain('198.51.100.10');
    for (const material of ['method', 'url', 'originalUrl', 'headers', 'body', 'query', 'ip', 'status']) {
      expect(Object.keys(entries[0])).not.toContain(material);
    }
  });

  it('keeps the bucket prefix, and only the head of the hash', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq(counter({ used: 60, key: `hdr:${sha('Bearer raw-token-xyz')}` })));
    expect(entries[0].key).toBe(`hdr:${sha('Bearer raw-token-xyz').slice(0, 12)}`);
    expect(entries[0].key.length).toBe('hdr:'.length + 12);
  });

  // The prefix is what tells a per-seat reading from a per-connection one, which
  // is the whole difference TASK-110 exists to fix.
  it.each([
    ['tok:abcdef0123456789', 'tok:abcdef012345'],
    ['hdr:fedcba9876543210', 'hdr:fedcba987654'],
    ['ip:203.0.113.7', 'ip:203.0.113.7'],
    ['no-prefix-key', 'no-prefix-ke'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    [42, 'unknown'],
  ])('shortens %p to %p', (input, expected) => {
    expect(correlationKey(input)).toBe(expected);
  });

  // An IP bucket is kept whole: it is a prefix, not a secret, and shortening it
  // costs the bucket while hiding nothing (Vera 71426). The assertion names it
  // because the mutation that removes the exception must have one owner.
  it('keeps an IP bucket whole — it is a bucket, not a secret', () => {
    expect(correlationKey('ip:2001:db8:1234:5678::/64')).toBe('ip:2001:db8:1234:5678::/64');
    expect(correlationKey('ip:203.0.113.7')).toBe('ip:203.0.113.7');
  });

  it('reports a missing route pattern as null rather than guessing one', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq(counter()));
    expect(entries[0].route).toBeNull();
  });

  it('reports the seconds left in the window, and never a negative', () => {
    expect(secondsUntilReset(RESET_AT, FIXED_NOW)).toBe(45);
    // Half a second rounds up: "1 second left" is truer than "0" for a window
    // that has not expired.
    expect(secondsUntilReset(new Date(FIXED_NOW.getTime() + 500), FIXED_NOW)).toBe(1);
    // Clock skew between the store and the app must not produce "-3 seconds".
    expect(secondsUntilReset(new Date(FIXED_NOW.getTime() - 3_000), FIXED_NOW)).toBe(0);
    expect(secondsUntilReset(undefined, FIXED_NOW)).toBeNull();
    expect(secondsUntilReset('2026-09-23T05:00:45.000Z', FIXED_NOW)).toBeNull();
  });

  it('reports the window as null when the limiter gave no reset time', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq(counter({ resetTime: undefined })));
    expect(entries[0].resetInSeconds).toBeNull();
  });

  it('reports an absent key as unknown rather than leaving it undefined', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq(counter({ key: undefined })));
    expect(entries[0].key).toBe('unknown');
  });

  // The in-memory store is per PROCESS, so a reading without its replica cannot
  // be aggregated: two replicas at 60/60s each is a different fleet fact from
  // one replica at 120/60s.
  it('names the replica as unknown when the environment does not identify one', () => {
    const saved = process.env.HOSTNAME;
    delete process.env.HOSTNAME;
    try {
      const entries = [];
      const observer = createRateLimitObserver({ env: ENV_ON, sink: (e) => entries.push(e) });
      run(observer, limitedReq(counter()));
      expect(entries[0].replica).toBe('unknown');
    } finally {
      if (saved === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = saved;
    }
  });

  it('takes the replica from the environment when it is there', () => {
    const saved = process.env.HOSTNAME;
    process.env.HOSTNAME = 'commonly-backend-7d9f8c-abcde';
    try {
      const entries = [];
      const observer = createRateLimitObserver({ env: ENV_ON, sink: (e) => entries.push(e) });
      run(observer, limitedReq(counter()));
      expect(entries[0].replica).toBe('commonly-backend-7d9f8c-abcde');
    } finally {
      if (saved === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = saved;
    }
  });
});

describe('rateLimitObserver — the instrument cannot break the route', () => {
  it('calls next exactly once on every path', () => {
    const { observer } = collect();
    const req = limitedReq(counter({ used: 120, remaining: 0 }));
    expect(run(observer, req)).toHaveBeenCalledTimes(1);
    expect(run(observer, limitedReq(counter({ used: 1, remaining: 119 })))).toHaveBeenCalledTimes(1);
    const off = createRateLimitObserver({ env: {}, sink: () => {}, replica: 'replica-a' });
    expect(run(off, req)).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing sink', () => {
    const observer = createRateLimitObserver({
      env: ENV_ON,
      sink: () => {
        throw new Error('log sink exploded');
      },
      replica: 'replica-a',
    });
    const next = jest.fn();
    expect(() => observer(limitedReq(counter()), {}, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('rateLimitObserver — against the real limiter (express-rate-limit 8.3.2)', () => {
  const buildApp = (entries, { watermark, observe = true, ipMax = 1000, tokenMax = 3 } = {}) => {
    const app = express();
    const router = express.Router();
    const ipTier = rateLimit({
      windowMs: 60_000,
      max: ipMax,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: () => 'ip:198.51.100',
    });
    const tokenTier = rateLimit({
      windowMs: 60_000,
      max: tokenMax,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: () => 'tok:testkey',
    });
    router.post(
      '/pods/:podId/messages',
      ipTier,
      tokenTier,
      createRateLimitObserver({
        env: observe ? { RATE_LIMIT_OBSERVE: 'true', RATE_LIMIT_OBSERVE_WATERMARK: String(watermark) } : {},
        sink: (e) => entries.push(e),
        replica: 'replica-a',
      }),
      (req, res) => res.json({ ok: true }),
    );
    app.use('/api/agents/runtime', router);
    return app;
  };

  const fire = async (app, times) => {
    const statuses = [];
    for (let i = 0; i < times; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await supertest(app).post('/api/agents/runtime/pods/6a8f6dc7a1dccf2e02f31015/messages?foo=bar');
      statuses.push(res.status);
    }
    return statuses;
  };

  it('reads the counter the limiter actually sets, and never sees the refusal', async () => {
    const entries = [];
    const app = buildApp(entries, { watermark: 2 });

    const statuses = await fire(app, 4);

    // 3 pass, the 4th is refused by the token tier — and the refusal is answered
    // there, so this middleware never runs for it.
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(entries.map((e) => e.used)).toEqual([2, 3]);
    // The consequence, asserted rather than described: the log is a LOWER bound
    // on peaks. A window in which 50 requests were refused still logs used == 3.
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => e.used > 3)).toBe(false);
    expect(entries.every((e) => e.replica === 'replica-a')).toBe(true);
  });

  // Vera's 71402 assertion, as a test rather than an assumption: with two
  // limiters stacked, req.rateLimit is the TOKEN tier's counter — the IP tier
  // here allows 1000, so a reading of it would show rising `used` and no 429.
  it('reports the token tier, not the IP tier, when two limiters are stacked', async () => {
    const entries = [];
    const app = buildApp(entries, { watermark: 2, ipMax: 1000, tokenMax: 3 });

    const statuses = await fire(app, 4);

    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(entries.map((e) => e.used)).toEqual([2, 3]);
    expect(entries.every((e) => e.key === 'tok:testkey')).toBe(true);
    expect(entries.some((e) => e.key.startsWith('ip:'))).toBe(false);
  });

  it('reports the route pattern, with no ids or query strings from the request', async () => {
    const entries = [];
    const app = buildApp(entries, { watermark: 1 });

    await fire(app, 2);

    expect(entries.map((e) => e.route)).toEqual(['/pods/:podId/messages', '/pods/:podId/messages']);
    expect(JSON.stringify(entries)).not.toContain('6a8f6dc7a1dccf2e02f31015');
    expect(JSON.stringify(entries)).not.toContain('foo=bar');
  });

  it('reports a window that has not expired yet', async () => {
    const entries = [];
    const app = buildApp(entries, { watermark: 1 });
    await fire(app, 1);
    expect(entries[0].resetInSeconds).toBeGreaterThan(0);
    expect(entries[0].resetInSeconds).toBeLessThanOrEqual(60);
  });

  it('emits nothing from a real limiter below the watermark', async () => {
    const entries = [];
    const app = buildApp(entries, { watermark: 3 });
    const statuses = await fire(app, 1);
    expect(statuses).toEqual([200]);
    expect(entries).toEqual([]);
  });

  // Vera's second 71402 assertion: the middleware is a no-op with the flag unset.
  it('is a no-op — on the wire, not just in the sink — with the flag unset', async () => {
    const entries = [];
    const app = buildApp(entries, { watermark: 1, observe: false });
    const statuses = await fire(app, 3);
    expect(statuses).toEqual([200, 200, 200]);
    expect(entries).toEqual([]);
  });
});

describe('rateLimitObserver — mounted where the reading comes from', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../routes/agentsRuntime.ts'), 'utf8');

  it('is the LAST limiter in the phase4RateLimit stack', () => {
    const match = source.match(/const phase4RateLimit = \[([^\]]*)\];/);
    expect(match).not.toBeNull();
    const stack = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    // Last position is the whole point: each limiter overwrites req.rateLimit,
    // so an observer mounted before the token tier would report the IP tier's
    // 3000/60s numbers and `(A)` would be decided on the wrong counter.
    expect(stack[stack.length - 1]).toBe('rateLimitObserver');
    expect(stack).toEqual(['phase4IpRateLimit', 'phase4AgentRateLimit', 'rateLimitObserver']);
  });

  it('imports the observer it mounts', () => {
    expect(source).toContain("const { rateLimitObserver } = require('../middleware/rateLimitObserver');");
  });
});
