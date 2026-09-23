// @ts-nocheck
// TASK-109 / TASK-097 §6: the watermark log that makes the fleet's real
// per-token request rate measurable, so the mount-level decision `(A)` is taken
// on a reading rather than a derivation.
//
// Two tiers of test here, deliberately:
//   - unit: the gating (flag, watermark), the emitted shape, and the properties
//     that make it safe to deploy (inert until enabled, always calls next, a
//     throwing sink cannot break a route);
//   - against the REAL limiter (express + express-rate-limit, the installed
//     version): because what this middleware reports is `req.rateLimit`, and
//     that shape belongs to the dependency, not to us. The docs say
//     `{limit, used, remaining, resetTime, key}`; the assertion below is against
//     the package, so a rename upstream fails here instead of silently
//     producing a watermark log of zeros.

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
  DEFAULT_OBSERVE_WATERMARK,
} = require('../../../middleware/rateLimitObserver');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const ENV_ON = { RATE_LIMIT_OBSERVE: 'true' };
const FIXED_NOW = new Date('2026-09-23T05:00:00.000Z');

/** A request as the limiter leaves it: rateLimit set, nothing else needed. */
const limitedReq = (rateLimitInfo, headers = {}) => ({
  rateLimit: rateLimitInfo,
  headers,
  method: 'POST',
  url: '/api/agents/runtime/pods/6a8f6dc7a1dccf2e02f31015/messages',
  ip: '203.0.113.7',
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
    run(observer, limitedReq({ limit: 120, used: 120, remaining: 0, resetTime: FIXED_NOW, key: 'tok:abc' }));
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

  // Ops flip the flag on a running deployment story; nothing captures it at
  // import time, so a change takes effect on the next request.
  it('reads the flag per request, not at construction', () => {
    const env = {};
    const entries = [];
    const observer = createRateLimitObserver({
      env,
      sink: (e) => entries.push(e),
      replica: 'replica-a',
    });
    const req = limitedReq({ limit: 120, used: 120, remaining: 0, resetTime: FIXED_NOW, key: 'tok:abc' });
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
    run(observer, limitedReq({ limit: 120, used: 59, remaining: 61, resetTime: FIXED_NOW, key: 'tok:abc' }));
    expect(entries).toHaveLength(0);
    run(observer, limitedReq({ limit: 120, used: 60, remaining: 60, resetTime: FIXED_NOW, key: 'tok:abc' }));
    expect(entries).toHaveLength(1);
  });

  it('defaults the watermark to half the token tier', () => {
    expect(DEFAULT_OBSERVE_WATERMARK).toBe(60);
    expect(observeWatermark({})).toBe(60);
  });

  it('honours an override', () => {
    const { entries, observer } = collect({ env: { RATE_LIMIT_OBSERVE_WATERMARK: '100' } });
    run(observer, limitedReq({ limit: 120, used: 60, remaining: 60, resetTime: FIXED_NOW, key: 'tok:abc' }));
    expect(entries).toHaveLength(0);
    run(observer, limitedReq({ limit: 120, used: 100, remaining: 20, resetTime: FIXED_NOW, key: 'tok:abc' }));
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
    run(observer, limitedReq({ limit: 120, remaining: 0, resetTime: FIXED_NOW, key: 'tok:abc' }));
    expect(entries).toEqual([]);
  });

  // A coerced counter would emit `used: '120'` beside `remaining: 0` — a line
  // that looks like a reading and is a fabrication. The types are the contract.
  it('emits nothing when the counter arrives as a string', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq({ limit: 120, used: '120', remaining: 0, resetTime: FIXED_NOW, key: 'tok:abc' }));
    expect(entries).toEqual([]);
  });
});

describe('rateLimitObserver — what a line carries, and what it never carries', () => {
  it('emits the counter, the limiter key, the replica and the time', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq({ limit: 120, used: 61, remaining: 59, resetTime: FIXED_NOW, key: 'tok:abc123' }));
    expect(entries).toEqual([
      {
        event: 'agent_rate_limit_watermark',
        key: 'tok:abc123',
        used: 61,
        limit: 120,
        remaining: 59,
        resetTime: String(FIXED_NOW),
        replica: 'replica-a',
        at: FIXED_NOW.toISOString(),
      },
    ]);
  });

  it('pins the emitted field set — the line is a counter, not a traffic log', () => {
    const { entries, observer } = collect();
    run(
      observer,
      limitedReq(
        { limit: 120, used: 120, remaining: 0, resetTime: FIXED_NOW, key: `hdr:${sha('Bearer cm_agent_secretvalue')}` },
        { authorization: 'Bearer cm_agent_secretvalue', 'cf-connecting-ip': '198.51.100.10' },
      ),
    );
    expect(Object.keys(entries[0]).sort()).toEqual(
      ['at', 'event', 'key', 'limit', 'remaining', 'replica', 'resetTime', 'used'].sort(),
    );
    const line = JSON.stringify(entries[0]);
    // The credential is in the request and must not be in the observation. The
    // key the limiter hands us is already a hash; nothing here re-derives or
    // widens it.
    expect(line).not.toContain('cm_agent_secretvalue');
    expect(entries[0].key).toBe(`hdr:${sha('Bearer cm_agent_secretvalue')}`);
    for (const material of ['method', 'url', 'headers', 'body', 'query', 'ip']) {
      expect(Object.keys(entries[0])).not.toContain(material);
    }
  });

  it('keeps a null resetTime rather than inventing one', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq({ limit: 120, used: 60, remaining: 60, key: 'tok:abc' }));
    expect(entries[0].resetTime).toBeNull();
  });

  it('reports an absent key as unknown rather than leaving it undefined', () => {
    const { entries, observer } = collect();
    run(observer, limitedReq({ limit: 120, used: 60, remaining: 60 }));
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
      run(observer, limitedReq({ limit: 120, used: 60, remaining: 60, key: 'tok:abc' }));
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
      run(observer, limitedReq({ limit: 120, used: 60, remaining: 60, key: 'tok:abc' }));
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
    const req = limitedReq({ limit: 120, used: 120, remaining: 0, resetTime: FIXED_NOW, key: 'tok:abc' });
    expect(run(observer, req)).toHaveBeenCalledTimes(1);
    expect(run(observer, limitedReq({ limit: 120, used: 1, remaining: 119, key: 'tok:abc' }))).toHaveBeenCalledTimes(1);
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
    expect(() =>
      observer(limitedReq({ limit: 120, used: 60, remaining: 60, key: 'tok:abc' }), {}, next),
    ).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('rateLimitObserver — against the real limiter (express-rate-limit 8.3.2)', () => {
  const buildApp = (entries, watermark) => {
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, max: 3, standardHeaders: true, legacyHeaders: false, keyGenerator: () => 'test-key' }));
    app.use(
      createRateLimitObserver({
        env: { RATE_LIMIT_OBSERVE: 'true', RATE_LIMIT_OBSERVE_WATERMARK: String(watermark) },
        sink: (e) => entries.push(e),
        replica: 'replica-a',
        now: () => FIXED_NOW,
      }),
    );
    app.get('/x', (_req, res) => res.json({ ok: true }));
    return app;
  };

  it('reads the counter the limiter actually sets, and never sees the refusal', async () => {
    const entries = [];
    const app = buildApp(entries, 2);

    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await supertest(app).get('/x');
      statuses.push(res.status);
    }

    // 3 pass, the 4th is refused by the limiter — and the refusal is answered
    // there, so this middleware never runs for it.
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(entries.map((e) => e.used)).toEqual([2, 3]);
    expect(entries.map((e) => e.limit)).toEqual([3, 3]);
    expect(entries.map((e) => e.remaining)).toEqual([1, 0]);
    expect(entries.every((e) => e.key === 'test-key')).toBe(true);
    // The consequence, stated as an assertion: the log is a LOWER bound on the
    // peak. A window in which 50 requests were refused still logs `used == 3`.
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => e.used > 3)).toBe(false);
  });

  it('emits nothing from a real limiter below the watermark', async () => {
    const entries = [];
    const app = buildApp(entries, 3);
    const res = await supertest(app).get('/x');
    expect(res.status).toBe(200);
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
    expect(stack).toContain('phase4AgentRateLimit');
    expect(stack).toContain('phase4IpRateLimit');
  });

  it('imports the observer it mounts', () => {
    expect(source).toContain("const { rateLimitObserver } = require('../middleware/rateLimitObserver');");
  });
});
