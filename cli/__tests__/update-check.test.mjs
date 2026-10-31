import {
  checkForCliUpdate,
  fetchLatestVersion,
  readCachedLatest,
  startUpdateNotice,
  updateNoticeLine,
  versionsBehind,
  UPDATE_CACHE_TTL_MS,
  UPDATE_NOTICE_MIN_BEHIND,
} from '../src/lib/update-check.js';

// TASK-660 item 3: a stale CLI says so in one start-up line; everything else
// (current, offline, slow, opted out) says nothing and costs start-up nothing.
// Every registry here is a fake, and every cache is an in-memory map.

const NOW = Date.parse('2026-10-31T12:00:00Z');

const registry = (version, calls = []) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, json: async () => ({ name: '@commonlyai/cli', version }) };
};

const memoryCache = (initial = {}) => {
  const files = { ...initial };
  return {
    files,
    readText: (path) => (path in files ? files[path] : null),
    writeText: (path, text) => { files[path] = text; },
  };
};

const base = (overrides = {}) => {
  const cache = memoryCache();
  return {
    installedVersion: '0.1.165',
    env: {},
    now: NOW,
    cachePath: '/fake/.commonly/update-check.json',
    readText: cache.readText,
    writeText: cache.writeText,
    ...overrides,
  };
};

describe('versionsBehind', () => {
  test('counts the patch gap within one release line', () => {
    expect(versionsBehind('0.1.165', '0.1.168')).toBe(3);
    expect(versionsBehind('0.1.168', '0.1.168')).toBe(0);
  });

  test('a newer minor or major is behind by an unknown, large distance', () => {
    expect(versionsBehind('0.1.168', '0.2.0')).toBe(Infinity);
    expect(versionsBehind('0.1.168', '1.0.0')).toBe(Infinity);
  });

  test('ahead of the registry is not behind', () => {
    expect(versionsBehind('0.1.170', '0.1.168')).toBe(0);
    expect(versionsBehind('0.2.0', '0.1.168')).toBe(0);
  });

  test('a non-version on either side is no answer', () => {
    expect(versionsBehind('dev', '0.1.168')).toBeNull();
    expect(versionsBehind('0.1.168', undefined)).toBeNull();
  });
});

describe('updateNoticeLine', () => {
  test('names the gap, both versions, the update command and the opt-out', () => {
    const line = updateNoticeLine({ installed: '0.1.165', latest: '0.1.168' });
    expect(line).toBe(
      'your CLI is 3 versions behind (installed 0.1.165, latest 0.1.168). '
      + 'Update: npm install -g @commonlyai/cli@latest (silence with COMMONLY_NO_UPDATE_CHECK=1)',
    );
  });

  test('stays quiet below the threshold', () => {
    expect(UPDATE_NOTICE_MIN_BEHIND).toBe(3);
    expect(updateNoticeLine({ installed: '0.1.166', latest: '0.1.168' })).toBeNull();
  });

  test('prints only the parsed triple of what the registry sent', () => {
    const line = updateNoticeLine({ installed: '0.1.100', latest: '0.1.168\u001b[2J; rm -rf ~' });
    expect(line).toContain('latest 0.1.168)');
    expect(line).not.toContain('rm -rf');
    expect(line).not.toContain('\u001b');
  });
});

describe('checkForCliUpdate', () => {
  test('a registry 3 versions ahead gives the notice, and the answer is cached', async () => {
    const calls = [];
    const opts = base({ fetchImpl: registry('0.1.168', calls) });
    const line = await checkForCliUpdate(opts);
    expect(line).toMatch(/^your CLI is 3 versions behind \(installed 0\.1\.165, latest 0\.1\.168\)/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://registry.npmjs.org/@commonlyai%2fcli/latest');
    expect(JSON.parse(opts.readText(opts.cachePath))).toEqual({
      checkedAt: new Date(NOW).toISOString(), latest: '0.1.168',
    });
  });

  test('an equal version gives none', async () => {
    expect(await checkForCliUpdate(base({ installedVersion: '0.1.168', fetchImpl: registry('0.1.168') }))).toBeNull();
  });

  test('a registry timeout gives none, inside the timeout, even when fetch ignores its abort signal', async () => {
    const hanging = () => new Promise(() => {});
    const started = Date.now();
    const line = await checkForCliUpdate(base({ fetchImpl: hanging, timeoutMs: 50 }));
    expect(line).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('offline (fetch rejects) gives none and writes no cache', async () => {
    const opts = base({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    expect(await checkForCliUpdate(opts)).toBeNull();
    expect(opts.readText(opts.cachePath)).toBeNull();
  });

  test('a registry error status or a body without a version gives none', async () => {
    expect(await checkForCliUpdate(base({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }))).toBeNull();
    expect(await checkForCliUpdate(base({ fetchImpl: registry(undefined) }))).toBeNull();
  });

  test('COMMONLY_NO_UPDATE_CHECK=1 never asks the registry', async () => {
    const calls = [];
    const line = await checkForCliUpdate(base({ env: { COMMONLY_NO_UPDATE_CHECK: '1' }, fetchImpl: registry('0.1.200', calls) }));
    expect(line).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('a cache younger than 24 h is used without a lookup', async () => {
    const cache = memoryCache({
      '/fake/.commonly/update-check.json': JSON.stringify({ checkedAt: new Date(NOW - 60_000).toISOString(), latest: '0.1.170' }),
    });
    const calls = [];
    const line = await checkForCliUpdate(base({ ...cache, fetchImpl: registry('0.1.999', calls) }));
    expect(calls).toHaveLength(0);
    expect(line).toContain('5 versions behind');
  });

  test('a cache 24 h old or older is looked up again', async () => {
    const cache = memoryCache({
      '/fake/.commonly/update-check.json': JSON.stringify({ checkedAt: new Date(NOW - UPDATE_CACHE_TTL_MS).toISOString(), latest: '0.1.165' }),
    });
    const calls = [];
    const line = await checkForCliUpdate(base({ ...cache, fetchImpl: registry('0.1.168', calls) }));
    expect(calls).toHaveLength(1);
    expect(line).toContain('3 versions behind');
  });

  test('a malformed or future-dated cache is ignored', () => {
    const path = '/c';
    expect(readCachedLatest({ cachePath: path, now: NOW, readText: () => 'not json' })).toBeNull();
    expect(readCachedLatest({
      cachePath: path, now: NOW, readText: () => JSON.stringify({ checkedAt: new Date(NOW + 60_000).toISOString(), latest: '0.1.1' }),
    })).toBeNull();
    expect(readCachedLatest({
      cachePath: path, now: NOW, readText: () => JSON.stringify({ checkedAt: new Date(NOW).toISOString(), latest: '../x' }),
    })).toBeNull();
  });

  test('an unwritable cache still returns the notice', async () => {
    const line = await checkForCliUpdate(base({
      fetchImpl: registry('0.1.168'),
      writeText: () => { throw new Error('EACCES'); },
    }));
    expect(line).toContain('3 versions behind');
  });
});

describe('startUpdateNotice', () => {
  test('returns before a hung registry answers, and logs nothing', async () => {
    const logged = [];
    const started = Date.now();
    const pending = startUpdateNotice({ ...base({ fetchImpl: () => new Promise(() => {}), timeoutMs: 50 }), log: (l) => logged.push(l) });
    // Start-up continues at once: the call returned a promise without waiting on it.
    expect(Date.now() - started).toBeLessThan(25);
    expect(logged).toEqual([]);
    await expect(pending).resolves.toBeNull();
    expect(logged).toEqual([]);
  });

  test('logs the one line when stale', async () => {
    const logged = [];
    await startUpdateNotice({ ...base({ fetchImpl: registry('0.1.168') }), log: (l) => logged.push(l) });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^your CLI is 3 versions behind/);
  });

  test('a throwing log sink does not reject', async () => {
    await expect(startUpdateNotice({
      ...base({ fetchImpl: registry('0.1.168') }),
      log: () => { throw new Error('EPIPE'); },
    })).resolves.toContain('3 versions behind');
  });
});

test('fetchLatestVersion sends an abort signal, and returns null without fetch', async () => {
  const calls = [];
  expect(await fetchLatestVersion({ fetchImpl: registry('0.1.168', calls), timeoutMs: 1000 })).toBe('0.1.168');
  expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  expect(await fetchLatestVersion({ fetchImpl: null })).toBeNull();
});
