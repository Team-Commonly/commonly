/**
 * TASK-126 — behavioural probe: no rate limiter mounted in the app may put two
 * callers that differ only in `cf-connecting-ip` into one bucket.
 *
 * Why each walked instance is re-mounted on a stub instead of being exercised
 * through the loaded app — all four measured, not assumed:
 *   - Every entry in the loaded router stack is a Layer whose `handle.name` is
 *     `''` and whose `entry.name` is `<anonymous>`, for middleware generally and
 *     for limiters specifically. Identity (`resetKey`/`getKey` own properties)
 *     is the only census instrument; anything name-keyed mis-attributes.
 *   - On a route carrying two limiters both write `RateLimit-Remaining` and the
 *     last one that runs wins. Proved on `POST /api/webhooks/groupme/:integrationId`:
 *     the 3000-max IP limiter reported `remaining` 599/598/597 (the 600-max
 *     limiter's values) and the walk entry for the 600-max limiter then read 596,
 *     because the first entry's three requests had decremented its bucket. So a
 *     hidden limiter's count is invisible in that response.
 *   - A limiter mounted behind `auth` (`routes/users.ts:171`
 *     `profileWriteUserLimit`) never runs for a header-free request.
 *   - Three instances never answer at all through the app: their handlers need
 *     Mongo and unit mode runs without it.
 * On the stub there are no params and no auth header, so every key function
 * takes its IP branch (each one falls back to the Cloudflare-aware helper), and
 * the 204 terminal answers for all of them — no exemption list, no database.
 *
 * The A,A,B sequence is deliberate: two requests cannot separate "different
 * buckets" from "not counting at all", so A2 is the instrument's own control.
 * The two fixtures prove the instrument discriminates on the stub itself: a
 * deliberately raw-`req.ip` limiter must COLLAPSE and a
 * `cloudflareIpRateLimitKeyGenerator` one must SEPARATE. A stub that separates
 * everything handed to it would pass all 82 and establish nothing.
 */
/* eslint-disable import/no-unresolved, import/extensions */
const fs = require('fs');
const express = require('express');
const request = require('supertest');
const rateLimit = require('express-rate-limit');
const { cloudflareIpRateLimitKeyGenerator } = require('../../../middleware/ipRateLimit');

// The app only mounts pg-messages/pg-status when PG_HOST is set AND the connect
// resolves truthy (server.ts:67,380-400), so the probe has to present that shape.
// process.env is per WORKER, not per file: leaving PG_HOST set would hand every
// later suite in this worker a PG-mounted app.
const ENTRY_PG_HOST = process.env.PG_HOST;
process.env.PG_HOST = ENTRY_PG_HOST || 'probe';
jest.mock('../../../config/db', () => jest.fn());
jest.mock('../../../config/db-pg', () => {
  const actual = jest.requireActual('../../../config/db-pg');
  const pool = { query: jest.fn().mockResolvedValue({ rows: [] }), on: jest.fn(), end: jest.fn() };
  return { ...actual, connectPG: jest.fn().mockResolvedValue(pool) };
});
jest.mock('../../../config/init-pg-db', () => jest.fn().mockResolvedValue(true));
jest.setTimeout(300000);

const { app } = require('../../../server');

const isLimiter = (fn) => fn && typeof fn === 'function'
  && Object.prototype.hasOwnProperty.call(fn, 'resetKey')
  && Object.prototype.hasOwnProperty.call(fn, 'getKey');

const prefixOf = (layer) => {
  const src = (layer.regexp && layer.regexp.source) || '';
  const m = src.match(/^\^\\?\/?([A-Za-z0-9_/\\-]*?)\\?\/\?\(\?=\\\/\|\$\)/);
  return m ? `/${m[1].replace(/\\\//g, '/').replace(/\/$/, '')}` : '';
};
const normPath = (p) => p.replace(/:[A-Za-z0-9_]+/g, 'test-id').replace(/\/{2,}/g, '/');

const collect = (router, prefix, found, seen) => {
  ((router && router.stack) || []).forEach((layer) => {
    if (layer.route) {
      const path = normPath(prefix + layer.route.path);
      const method = Object.keys(layer.route.methods || {})[0] || 'get';
      (layer.route.stack || []).forEach((entry) => {
        if (isLimiter(entry.handle) && !seen.has(entry.handle)) {
          seen.add(entry.handle);
          found.push({ instance: entry.handle, path, method });
        }
      });
      return;
    }
    if (isLimiter(layer.handle) && !seen.has(layer.handle)) {
      seen.add(layer.handle);
      found.push({ instance: layer.handle, path: normPath(prefix) || '/', method: 'get' });
    }
    if (layer.handle && layer.handle.stack) {
      collect(layer.handle, prefix + prefixOf(layer), found, seen);
    }
  });
};

const walked = [];
const seen = new Set();

const remainingOf = (res) => {
  if (res.headers['ratelimit-remaining'] !== undefined) return Number(res.headers['ratelimit-remaining']);
  const combined = res.headers.ratelimit;
  const m = combined && String(combined).match(/remaining=(\d+)/);
  return m ? Number(m[1]) : null;
};

const single = (instance) => {
  const stub = express();
  stub.all('/', instance, (_req, res) => res.status(204).end());
  return stub;
};

const hit = async (stub, ip) => {
  const entry = process.env.NODE_ENV;
  let outcome;
  try {
    process.env.NODE_ENV = 'development';
    const res = await request(stub).get('/').set('cf-connecting-ip', ip)
      .timeout({ response: 5000, deadline: 8000 });
    outcome = { remaining: remainingOf(res), status: res.status };
  } catch (err) {
    outcome = { error: String((err && err.message) || err).slice(0, 80) };
  } finally {
    // Restore per REQUEST, not per suite: a throw mid-walk would otherwise leave
    // NODE_ENV flipped for the rest of this worker and silently un-skip every
    // limiter in later suites.
    process.env.NODE_ENV = entry;
  }
  if (process.env.NODE_ENV !== entry) throw new Error('NODE_ENV leaked');
  return outcome;
};

const observe = async (instance, tag) => {
  const a = `198.51.100.${tag}`;
  const b = `203.0.113.${tag}`;
  const stub = single(instance);
  const first = await hit(stub, a);
  const second = await hit(stub, a);
  const other = await hit(stub, b);
  return {
    r1: first.remaining, r2: second.remaining, r3: other.remaining, status: first.status, error: first.error,
  };
};

const fmt = (label, rec) => {
  const head = `${label} [r1=${rec.r1} r2=${rec.r2} r3=${rec.r3} status=${rec.status}`;
  return `${head}${rec.error ? ` err=${rec.error}` : ''}]`;
};

describe('TASK-126 ip key separation', () => {
  afterAll(() => {
    if (ENTRY_PG_HOST === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = ENTRY_PG_HOST;
  });

  beforeAll(async () => {
    // pg-messages and pg-status mount from promise callbacks (server.ts:380-400),
    // so the walk has to wait for the PG connect to resolve or those limiters are
    // invisible to it.
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    collect(app._router || app.router, '', walked, seen);
  });

  it('walks the loaded app and finds limiter instances by identity', () => {
    expect(walked.some((w) => w.path.startsWith('/api/pg/messages'))).toBe(true);
    expect(walked.length).toBeGreaterThanOrEqual(80);
    const distinct = new Set(walked.map((w) => w.instance));
    expect(distinct.size).toBe(walked.length);
  });

  it('negative control: the instrument catches a raw req.ip limiter on a stub', async () => {
    const raw = rateLimit({
      windowMs: 60000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => req.ip,
    });
    const rec = await observe(raw, 250);
    expect(rec.r2).toBe(rec.r1 - 1);
    expect(rec.r3).toBe(rec.r2 - 1);
    expect(rec.r3).not.toBe(rec.r1);
  });

  it('positive control: the CF-aware key separates on the same stub', async () => {
    const cf = rateLimit({
      windowMs: 60000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => cloudflareIpRateLimitKeyGenerator(req),
    });
    const rec = await observe(cf, 251);
    expect(rec.r2).toBe(rec.r1 - 1);
    expect(rec.r3).toBe(rec.r1);
  });

  it('every walked instance counts and separates; none collapses', async () => {
    const results = [];
    const runs = walked.map(async (w, i) => {
      const rec = await observe(w.instance, i + 1);
      results[i] = { path: w.path, method: w.method, ...rec };
    });
    await Promise.all(runs);

    const unseen = results.filter((r) => r.r1 === null || r.r1 === undefined);
    const notCounting = results.filter((r) => r.r1 !== null && r.r1 !== undefined && r.r2 !== r.r1 - 1);
    // Collapse signature is r3 === r2 - 1, NOT r3 === r2: a third request into the
    // same bucket keeps counting down. Measured on the raw-req.ip fixture below.
    const collapsed = results.filter((r) => r.r1 !== null && r.r3 === r.r2 - 1);
    const separated = results.filter((r) => r.r1 !== null && r.r3 === r.r1);

    expect(unseen.map((r) => fmt(`${r.method.toUpperCase()} ${r.path}`, r))).toEqual([]);
    expect(notCounting.map((r) => fmt(`${r.method.toUpperCase()} ${r.path}`, r))).toEqual([]);
    expect(collapsed.map((r) => fmt(`${r.method.toUpperCase()} ${r.path}`, r))).toEqual([]);
    expect(separated.length).toBe(results.length);
    // The floor is on observations, not violations: an assertion that every
    // member of an EMPTY set is fine would pass on a walk that found nothing.
    expect(separated.length).toBeGreaterThanOrEqual(80);
    fs.writeFileSync(process.env.PROBE_CENSUS || '/tmp/kai126-probe-census.json', JSON.stringify({
      instances: results.length,
      separated: separated.length,
      notCounting: notCounting.length,
      collapsed: collapsed.length,
      unseen: unseen.length,
      paths: results.map((r) => `${r.method.toUpperCase()} ${r.path}`),
    }, null, 1));
  });

  it('finds the limiters that mount late or behind a router', () => {
    const modules = ['../../../routes/agentHooks', '../../../routes/podInvites', '../../../routes/pg-messages'];
    const report = modules.map((mod) => {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const router = require(mod);
      const found = [];
      collect(router, '', found, new Set());
      const missing = found.filter((f) => !seen.has(f.instance));
      return { mod, found: found.length, missing: missing.length };
    });
    expect(report.filter((r) => r.found === 0).map((r) => r.mod)).toEqual([]);
    expect(report.filter((r) => r.missing > 0).map((r) => r.mod)).toEqual([]);
  });
});
