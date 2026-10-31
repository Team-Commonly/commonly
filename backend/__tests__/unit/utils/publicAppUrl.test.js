/**
 * The instance's own browser origin is the only host a product link may carry.
 * A prod literal in a fallback sent people on a self-hosted or dev instance to
 * commonly.me (TASK-285, same class as #2529 and #2568), so the source scan
 * below fails on any quoted commonly.me origin outside the reviewed allowlist.
 */
const fs = require('fs');
const path = require('path');
const { publicAppUrl, DEV_FALLBACK } = require('../../../utils/publicAppUrl');

const withEnv = (env, fn) => {
  const saved = { PUBLIC_APP_URL: process.env.PUBLIC_APP_URL, FRONTEND_URL: process.env.FRONTEND_URL };
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe('publicAppUrl', () => {
  it('prefers PUBLIC_APP_URL over FRONTEND_URL', () => {
    withEnv({ PUBLIC_APP_URL: 'https://pub.example.org', FRONTEND_URL: 'https://front.example.org' }, () => {
      expect(publicAppUrl()).toBe('https://pub.example.org');
    });
  });

  it('falls back to FRONTEND_URL, which is what the chart sets', () => {
    withEnv({ PUBLIC_APP_URL: undefined, FRONTEND_URL: 'https://team.example.org' }, () => {
      expect(publicAppUrl()).toBe('https://team.example.org');
    });
  });

  it('takes the first entry of a comma list and strips trailing slashes', () => {
    withEnv({ PUBLIC_APP_URL: 'https://a.example.org/, https://b.example.org' }, () => {
      expect(publicAppUrl()).toBe('https://a.example.org');
    });
  });

  it('never returns the commonly.me origin when neither variable is set', () => {
    withEnv({ PUBLIC_APP_URL: undefined, FRONTEND_URL: undefined }, () => {
      expect(publicAppUrl()).toBe(DEV_FALLBACK);
      expect(publicAppUrl()).not.toMatch(/commonly\.me/);
    });
  });
});

describe('no product file falls back to a prod origin', () => {
  // Quoted origins only: a comment, a User-Agent string or an env example that
  // mentions the host is not a link the product sends.
  const PROD_ORIGIN = /['"`]https?:\/\/(app\.)?commonly\.me['"`/]/;
  // corsPolicy's allowlist is the set of origins the API accepts; it is not a fallback.
  const ALLOWED = new Set([path.join('middleware', 'corsPolicy.ts')]);
  const backendRoot = path.join(__dirname, '..', '..', '..');

  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '__tests__', 'coverage', 'dist'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|js)$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  it('has no quoted commonly.me origin outside the reviewed allowlist', () => {
    const offenders = walk(backendRoot)
      .filter((file) => !ALLOWED.has(path.relative(backendRoot, file)))
      .filter((file) => PROD_ORIGIN.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(backendRoot, file));
    expect(offenders).toEqual([]);
  });
});
