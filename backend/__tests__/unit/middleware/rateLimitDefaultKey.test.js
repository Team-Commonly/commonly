/**
 * Guards the invariant that no rate limiter in `backend/` keys on
 * express-rate-limit's DEFAULT key generator — which is `req.ip`, and `req.ip`
 * is not the client here.
 *
 * Earned 2026-09-23 (TASK-110). nginx REPLACES `X-Forwarded-For` with its own
 * peer (`proxy_set_header X-Forwarded-For $remote_addr`, default controller
 * config) and parks the incoming chain on `X-Original-Forwarded-For`, while
 * `trust proxy` (server.ts) trusts every in-cluster hop — so `req.ip` walks to
 * a cloudflared pod address, one of two, for EVERY external caller. Thirty-one
 * limiters keyed on `cf-connecting-ip`, the address the edge records; seven
 * took the default, so `routes/pods.ts` (admin, agent-states, visibility), both
 * registry routes, `routes/admin/pods.ts` and `routes/billing.ts` were a
 * two-bucket global limiter for the whole internet. The fix was one line per
 * site; this file is what stops the next one.
 *
 * WHY A SOURCE SCAN AND NOT A REQUEST. The key is chosen at construction, and
 * a limiter is constructed in 74 places with no registry. A behavioural test
 * would have to stand up every route in the app to notice the one that
 * regressed — so it would notice none of them. The fixtures below are the
 * compensation: they prove this scanner reports a missing key, so a green run
 * means the property holds rather than that the detector is asleep.
 *
 * KNOWN LIMIT OF THIS FILE, stated rather than left implicit: the general scan
 * asserts a `keyGenerator` is PRESENT, not that it is the Cloudflare one — some
 * limiters legitimately key on a token or a composite. The seven sites TASK-110
 * fixed — and, since TASK-125, `routes/users.ts`'s profile-write ingress cap —
 * are therefore ALSO pinned by name to the exact expression, which is what makes
 * `keyGenerator: (req) => req.ip` red rather than green. That eighth site is the
 * one TASK-110's census missed by checking only that A key was set.
 *
 * SCOPE: `backend/**` `.ts` and `.js`, excluding `__tests__`, `node_modules`
 * and `coverage`. A limiter constructed from a variable is FLAGGED rather than
 * skipped — `rateLimit(someOptions)` hides whether a key was set, which is the
 * same defect with the evidence moved out of reach.
 */

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'coverage', '.git']);

/** Strip comments and string/template literals so a mention in prose is not a call. */
const stripCommentsAndStrings = (source) => {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      if (ch === '\\') { out += '  '; i += 2; continue; }
      if (ch === quote) { quote = null; }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ' '; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
};

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

const walk = (dir, acc = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), acc);
    } else if (/\.(ts|js)$/.test(entry.name)) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
};

/** Every `rateLimit(` call in one source, with the config block it was given. */
const findConfigs = (rawSource) => {
  const source = stripCommentsAndStrings(rawSource);
  const found = [];
  const re = /\brateLimit\s*(?:<[^>(]*>)?\s*\(/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    let i = open + 1;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] !== '{') {
      found.push({ line: lineOf(source, match.index), body: null });
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < source.length; j += 1) {
      if (source[j] === '{') depth += 1;
      else if (source[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push({ line: lineOf(source, match.index), body: source.slice(i, j + 1) });
  }
  return found;
};

/** Pinned to the exact expression: the seven TASK-110 fixed, then TASK-125's. */
const PINNED = [
  ['routes/pods.ts', 'podAdminRateLimit'],
  ['routes/pods.ts', 'agentStatesRateLimit'],
  ['routes/pods.ts', 'podVisibilityRateLimit'],
  ['routes/registry/install.ts', 'installRateLimit'],
  ['routes/registry/provision.ts', 'provisionRateLimit'],
  ['routes/admin/pods.ts', 'adminPodsRateLimit'],
  ['routes/billing.ts', 'checkoutLimit'],
  ['routes/users.ts', 'profileWriteIngressLimit'],
];

describe('rate limiters never take express-rate-limit\'s default (req.ip) key', () => {
  const files = walk(BACKEND_ROOT);

  it('the scanner reports a missing key, so a green run is not a sleeping detector', () => {
    const flagged = findConfigs('const x = rateLimit({ windowMs: 1000, limit: 5 });');
    expect(flagged).toHaveLength(1);
    expect(flagged[0].body).not.toContain('keyGenerator');

    const clean = findConfigs(
      "const y = rateLimit({ windowMs: 1000, keyGenerator: cloudflareIpRateLimitKeyGenerator });",
    );
    expect(clean).toHaveLength(1);
    expect(clean[0].body).toContain('keyGenerator');

    // A variable is flagged, not skipped: the evidence is out of reach.
    const indirect = findConfigs('const z = rateLimit(someOptions);');
    expect(indirect).toHaveLength(1);
    expect(indirect[0].body).toBeNull();
  });

  it('scans the whole backend rather than a sample', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('every limiter config in backend/ sets a keyGenerator', () => {
    const violations = [];
    let configs = 0;
    for (const file of files) {
      for (const cfg of findConfigs(fs.readFileSync(file, 'utf8'))) {
        configs += 1;
        if (cfg.body === null || !cfg.body.includes('keyGenerator')) {
          violations.push(`${path.relative(BACKEND_ROOT, file)}:${cfg.line}`);
        }
      }
    }
    // Vacuity floor: 74 configs on the day this landed (TASK-110, 2026-09-23).
    expect(configs).toBeGreaterThanOrEqual(60);
    expect(violations).toEqual([]);
  });

  // Vacuity floor for the pinned list itself: a row deleted from `PINNED` is
  // otherwise a silent coverage loss, because `it.each` over a shorter array
  // reports fewer passes and no failures. Growth is fine; shrinkage reddens.
  it('keeps pinning every site the list names', () => {
    expect(PINNED.length).toBeGreaterThanOrEqual(8);
  });

  it.each(PINNED)('pins %s %s to the Cloudflare key expression', (relPath, name) => {
    const source = stripCommentsAndStrings(fs.readFileSync(path.join(BACKEND_ROOT, relPath), 'utf8'));
    const re = new RegExp(`const\\s+${name}\\s*=\\s*rateLimit\\(\\{`);
    const match = re.exec(source);
    expect(match).not.toBeNull();
    let depth = 0;
    let j = match.index + match[0].length - 1;
    for (; j < source.length; j += 1) {
      if (source[j] === '{') depth += 1;
      else if (source[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    expect(source.slice(match.index, j + 1)).toContain(
      'keyGenerator: cloudflareIpRateLimitKeyGenerator',
    );
  });
});
