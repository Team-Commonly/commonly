import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  CALL_TIMEOUT_MS, npmWaitSettings, runNpm, waitForNpmServed,
} from '../scripts/npm-served-wait.mjs';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const PKG = '@commonlyai/cli';
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const e404 = { status: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found' };

// A fake npm: `view` names a version; `cache add` fails until the nth call.
const fakeNpm = ({ servedOnFetch = Infinity, version = '0.1.403' } = {}) => {
  const calls = [];
  let fetches = 0;
  const run = (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === 'view') return ok(`${version}\n`);
    fetches += 1;
    return fetches >= servedOnFetch ? ok() : e404;
  };
  return { run, calls, fetches: () => fetches };
};
const settings = (attempts, delaySeconds = 0, totalSeconds = 240) => ({ attempts, delaySeconds, totalSeconds });
const noSleep = () => { const waits = []; return { sleep: async (ms) => { waits.push(ms); }, waits }; };
const fixedNow = () => 0;

describe('waiting for npm to serve @latest', () => {
  test('returns after exactly 3 fetches when the tarball is served on the third try', async () => {
    const npm = fakeNpm({ servedOnFetch: 3 });
    const result = await waitForNpmServed({ pkg: PKG, run: npm.run, sleep: noSleep().sleep, settings: settings(10), now: fixedNow });
    expect(npm.fetches()).toBe(3);
    expect(result).toMatchObject({ served: true, version: '0.1.403', tries: 3 });
  });

  test('never served: stops after exactly N attempts and reports not served so the walk still runs', async () => {
    const npm = fakeNpm();
    const { sleep, waits } = noSleep();
    const result = await waitForNpmServed({ pkg: PKG, run: npm.run, sleep, settings: settings(4, 20), now: fixedNow });
    expect(npm.fetches()).toBe(4);
    expect(result.served).toBe(false);
    expect(waits).toEqual([20000, 20000, 20000]); // no sleep after the last try
  });

  test('resolves the version first, and the fetch names that exact version', async () => {
    const npm = fakeNpm({ servedOnFetch: 1, version: '0.1.402' });
    await waitForNpmServed({ pkg: PKG, run: npm.run, sleep: noSleep().sleep, settings: settings(3), npmBin: 'npm.cmd', now: fixedNow });
    expect(npm.calls).toEqual([
      ['npm.cmd', 'view', `${PKG}@latest`, 'version'],
      ['npm.cmd', 'cache', 'add', `${PKG}@0.1.402`],
    ]);
  });

  test('logs one line per try', async () => {
    const npm = fakeNpm({ servedOnFetch: 3 });
    const lines = [];
    await waitForNpmServed({ pkg: PKG, run: npm.run, sleep: noSleep().sleep, settings: settings(10), log: (l) => lines.push(l), now: fixedNow });
    expect(lines).toHaveLength(3);
  });

  test.each([
    ['non-numeric attempts', { attempts: 'abc', delaySeconds: 0, totalSeconds: 240 }],
    ['zero attempts', { attempts: 0, delaySeconds: 0, totalSeconds: 240 }],
    ['non-numeric delay', { attempts: 3, delaySeconds: 'x', totalSeconds: 240 }],
  ])('a bad setting (%s) throws at once with 0 fetches', async (_name, bad) => {
    const npm = fakeNpm();
    await expect(waitForNpmServed({ pkg: PKG, run: npm.run, sleep: noSleep().sleep, settings: bad, now: fixedNow })).rejects.toThrow(/must be/);
    expect(npm.calls).toHaveLength(0);
  });
});

describe('the env settings', () => {
  test('default to 10 tries, 20 s apart, 240 s in all', () => {
    expect(npmWaitSettings({})).toEqual({ attempts: 10, delaySeconds: 20, totalSeconds: 240 });
  });
  test('read the variables', () => {
    expect(npmWaitSettings({ COMMONLY_BYO_NPM_WAIT_ATTEMPTS: '3', COMMONLY_BYO_NPM_WAIT_DELAY_SECONDS: '0' }))
      .toEqual({ attempts: 3, delaySeconds: 0, totalSeconds: 240 });
  });
  test.each(['abc', '0', '-1', '1.5', '999'])('rejects attempts %j', (v) => {
    expect(() => npmWaitSettings({ COMMONLY_BYO_NPM_WAIT_ATTEMPTS: v })).toThrow(/COMMONLY_BYO_NPM_WAIT_ATTEMPTS/);
  });
  test.each(['-1', '1.5', 'NaN', '301'])('rejects delay %j', (v) => {
    expect(() => npmWaitSettings({ COMMONLY_BYO_NPM_WAIT_DELAY_SECONDS: v })).toThrow(/COMMONLY_BYO_NPM_WAIT_DELAY_SECONDS/);
  });
  test.each(['abc', '0', '59', '601', '2.5'])('rejects total %j', (v) => {
    expect(() => npmWaitSettings({ COMMONLY_BYO_NPM_WAIT_TOTAL_SECONDS: v })).toThrow(/COMMONLY_BYO_NPM_WAIT_TOTAL_SECONDS/);
  });
  test('reads the total', () => {
    expect(npmWaitSettings({ COMMONLY_BYO_NPM_WAIT_TOTAL_SECONDS: '120', COMMONLY_BYO_NPM_WAIT_ATTEMPTS: '2' }).totalSeconds).toBe(120);
  });
  test('rejects attempts x delay beyond the total', () => {
    expect(() => npmWaitSettings({ COMMONLY_BYO_NPM_WAIT_ATTEMPTS: '60', COMMONLY_BYO_NPM_WAIT_DELAY_SECONDS: '20' })).toThrow(/exceeds/);
    expect(() => npmWaitSettings({ COMMONLY_BYO_NPM_WAIT_ATTEMPTS: '10', COMMONLY_BYO_NPM_WAIT_DELAY_SECONDS: '25' })).toThrow(/exceeds/);
  });
  test('the same limits hold for settings passed in directly', async () => {
    const npm = fakeNpm();
    await expect(waitForNpmServed({ pkg: PKG, run: npm.run, sleep: noSleep().sleep, settings: settings(10, 25, 240), now: fixedNow })).rejects.toThrow(/exceeds/);
    expect(npm.calls).toHaveLength(0);
  });
  test('a call is cut off at 30 s', () => {
    expect(CALL_TIMEOUT_MS).toBe(30_000);
  });
  // The real runner, with spawnSync replaced: every npm call it makes carries
  // the cut-off, on POSIX and through cmd.exe on Windows.
  test.each(['linux', 'win32'])('runNpm passes the 30 s cut-off to the spawn on %s', (platform) => {
    const spawns = [];
    const spawn = (cmd, args, options) => {
      spawns.push({ cmd, args, options });
      return { status: 0, stdout: '0.1.403\n', stderr: '' };
    };
    const result = runNpm(platform === 'win32' ? 'npm.cmd' : 'npm', ['view', PKG, 'version'], { spawn, platform });
    expect(result).toEqual({ status: 0, stdout: '0.1.403\n', stderr: '' });
    expect(spawns).toHaveLength(1);
    expect(spawns[0].options.timeout).toBe(30_000);
    expect(spawns[0].cmd).toBe(platform === 'win32' ? 'cmd.exe' : 'npm');
  });
});

describe('the total deadline', () => {
  // A clock the fake npm and the fake sleep both advance.
  const clock = () => { let t = 0; return { now: () => t, advance: (ms) => { t += ms; } }; };
  const hangingNpm = (c, log) => (bin, args) => {
    log.push({ at: c.now(), args });
    c.advance(CALL_TIMEOUT_MS); // each call hangs until its timeout
    return { status: 1, stdout: '', stderr: 'timed out' };
  };

  test('a runner that hangs stops at the deadline and says not served, so the walk still runs', async () => {
    const c = clock();
    const result = await waitForNpmServed({
      pkg: PKG, run: hangingNpm(c, []), sleep: async (ms) => c.advance(ms), now: c.now, settings: settings(10, 20, 240),
    });
    expect(result.served).toBe(false);
    expect(c.now()).toBeLessThanOrEqual(240_000);
    expect(result.tries).toBeLessThan(10);
  });

  test('no try starts when it could not finish inside the deadline', async () => {
    const c = clock();
    const calls = [];
    const total = 240;
    await waitForNpmServed({
      pkg: PKG, run: hangingNpm(c, calls), sleep: async (ms) => c.advance(ms), now: c.now, settings: settings(10, 20, total),
    });
    // A try is a view then a cache add; each try starts with two calls' time left.
    calls.filter((x) => x.args[0] === 'view').forEach((x) => {
      expect(x.at + 2 * CALL_TIMEOUT_MS).toBeLessThanOrEqual(total * 1000);
    });
    expect(calls.length).toBeGreaterThan(0);
  });

  test('does not sleep when no further try could start', async () => {
    const c = clock();
    const waits = [];
    const result = await waitForNpmServed({
      pkg: PKG, run: hangingNpm(c, []), sleep: async (ms) => { waits.push(ms); c.advance(ms); }, now: c.now, settings: settings(4, 20, 100),
    });
    // Try 1 hangs 30 s on the view. 30 + 20 s sleep + 60 s for a next try is past 100 s, so it stops without sleeping.
    expect(waits).toEqual([]);
    expect(result.tries).toBe(1);
    expect(c.now()).toBeLessThanOrEqual(100_000);
  });
});

describe('reading the version npm names', () => {
  const viewing = (stdout, status = 0) => {
    const calls = [];
    const run = (bin, args) => { calls.push(args); return args[0] === 'view' ? { status, stdout, stderr: '' } : ok(); };
    return { run, calls };
  };
  const tryOnce = async (npm, log = () => {}) => waitForNpmServed({
    pkg: PKG, run: npm.run, sleep: noSleep().sleep, settings: settings(1), log, now: fixedNow,
  });
  const cacheAdds = (npm) => npm.calls.filter((a) => a[0] === 'cache');

  test('takes the last line that is a version, past a warning line before it', async () => {
    const npm = viewing('npm warn something\n0.1.403\n');
    await tryOnce(npm);
    expect(cacheAdds(npm)).toEqual([['cache', 'add', `${PKG}@0.1.403`]]);
  });

  test.each([
    ['a warning line only', 'npm warn deprecated thing\n'],
    ['trailing text on the version line', '0.1.403 (latest)\n'],
    ['a shell metacharacter', '0.1.403;calc\n'],
    ['a quote', '0.1.403"&calc\n'],
    ['nothing', ''],
  ])('%s gives no cache add and logs that npm named no version', async (_n, stdout) => {
    const npm = viewing(stdout);
    const lines = [];
    const result = await tryOnce(npm, (l) => lines.push(l));
    expect(cacheAdds(npm)).toHaveLength(0);
    expect(result.served).toBe(false);
    expect(lines.join('\n')).toMatch(/npm view named no version/);
  });

  test('a non-zero npm view exit gives no cache add and logs that npm view failed', async () => {
    const npm = viewing('0.1.403\n', 1);
    const lines = [];
    await tryOnce(npm, (l) => lines.push(l));
    expect(cacheAdds(npm)).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/npm view failed/);
  });
});

describe('the scripts only wait, they never gate the walk on the result', () => {
  const read = (name) => readFileSync(resolve(SCRIPTS, name), 'utf8');

  test.each([
    ['windows-byo-smoke.mjs', "await walk('published')"],
    ['daemon-setup-line-smoke.mjs', 'const pastedAt = Date.now()'],
  ])('%s calls the gate as a bare statement, before the walk', (file, walkText) => {
    const text = read(file);
    const at = text.indexOf('await waitForNpmServed(');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(text.indexOf(walkText));
    // Bare call: the return value is not assigned, tested or returned.
    expect(text.slice(text.lastIndexOf('\n', at), at)).not.toMatch(/(=|if \(|return|!)\s*$/);
    expect(text).not.toMatch(/=\s*await waitForNpmServed|if \(\s*!?\s*\(?await waitForNpmServed|\.served/);
  });
});
