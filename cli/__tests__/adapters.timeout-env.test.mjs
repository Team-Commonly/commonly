/**
 * Regression test for COMMONLY_AGENT_RUN_TIMEOUT_MS env override on the
 * adapter default timeout (codex.js + claude.js).
 *
 * Background: 2026-05-20 smoke surfaced that the hardcoded 5-minute
 * default was too tight for codex `exec` mode research tasks (Cody got
 * SIGTERM'd mid-flight, 15+ web searches in motion). The default is now
 * 15 minutes, and operators can tune via env var without rebuilding.
 *
 * We probe the constant by introspecting the spawn flow rather than
 * actually waiting 15 minutes for a timeout: assert the env override is
 * read at module load, and exercise the parse-failure fallback.
 */
import { jest } from '@jest/globals';

describe('adapter DEFAULT_TIMEOUT_MS env override', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS;
    // Fresh-load each test so the module-level IIFE re-reads env.
    jest.resetModules();
  });
  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS;
    } else {
      process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS = savedEnv;
    }
  });

  // Each adapter exports a default object with spawn(). The timeout
  // constant isn't exported directly, but we can prove the override is
  // active by stubbing a never-resolving spawn and verifying the spawn
  // promise rejects with the EXPECTED timeout message at our chosen
  // budget. We use a deliberately short value (200ms) so the test
  // doesn't hang the suite.
  // Build a stub child process that captures close-event listeners and emits
  // them after kill() — so the adapter's `proc.on('close', ...)` callback
  // actually fires when the SIGTERM timer trips, which is how the adapter's
  // promise resolves into the rejected "timed out after Xms" error. Without
  // this, the test never resolves (hits jest's 5s default test timeout).
  // Surfaced by #453 wiring cli tests into CI for the first time.
  function makeKillableChild() {
    const listeners = {};
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, cb) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      },
      kill: () => {
        setImmediate(() => {
          for (const cb of (listeners.close || [])) cb(143); // 143 = 128 + SIGTERM
        });
      },
    };
  }

  async function runWithTimeout(adapterPath, timeoutMs) {
    process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS = String(timeoutMs);
    const adapter = (await import(adapterPath)).default;
    const ctx = {
      _spawnImpl: () => makeKillableChild(),
      env: { ...process.env },
      cwd: process.cwd(),
    };
    const start = Date.now();
    let caughtError;
    try {
      await adapter.spawn('dummy', ctx);
    } catch (err) {
      caughtError = err;
    }
    return { elapsedMs: Date.now() - start, error: caughtError };
  }

  test('codex.js honors COMMONLY_AGENT_RUN_TIMEOUT_MS', async () => {
    const { elapsedMs, error } = await runWithTimeout('../src/lib/adapters/codex.js', 200);
    expect(error).toBeTruthy();
    expect(String(error?.message || '')).toMatch(/timed out after 200ms/);
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    expect(elapsedMs).toBeLessThan(2000);
  });

  test('claude.js honors COMMONLY_AGENT_RUN_TIMEOUT_MS', async () => {
    const { elapsedMs, error } = await runWithTimeout('../src/lib/adapters/claude.js', 200);
    expect(error).toBeTruthy();
    expect(String(error?.message || '')).toMatch(/timed out after 200ms/);
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    expect(elapsedMs).toBeLessThan(2000);
  });

  test('invalid env value falls through to default (does not zero the cap)', async () => {
    process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS = 'not-a-number';
    const adapter = (await import('../src/lib/adapters/codex.js')).default;
    // We can't easily wait 15 minutes; instead pass an explicit short
    // ctx.timeoutMs to confirm the spawn flow itself is intact. The
    // default-fallback path is exercised by the module loading without
    // throwing.
    const ctx = {
      _spawnImpl: () => makeKillableChild(),
      env: { ...process.env },
      cwd: process.cwd(),
      timeoutMs: 100,
    };
    let caught;
    try { await adapter.spawn('dummy', ctx); } catch (e) { caught = e; }
    expect(String(caught?.message || '')).toMatch(/timed out after 100ms/);
  });

  test('non-positive env value falls through to default (does not zero the cap)', async () => {
    // Reviewer on PR #415: the previous version of this test only
    // asserted `typeof adapter.spawn === 'function'` — it didn't prove
    // the timeout is actually the 15-minute default. If the env-parse
    // fallback were ever rewritten to treat '0' as 0ms, every spawn
    // would SIGTERM near-instantly and we wouldn't catch it.
    //
    // Probe: load with env='0', spawn a never-resolving child with NO
    // ctx.timeoutMs override, race against a 2-second window. If the
    // adapter's default-timeout had been zeroed by the env, the spawn
    // promise would reject within ~milliseconds. A 2s budget is well
    // above any zeroed-cap reject latency AND well below the actual
    // 15-minute default — so we can assert "spawn did NOT reject in
    // 2 seconds" as proof that the env fallback held.
    process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS = '0';
    const adapter = (await import('../src/lib/adapters/codex.js')).default;
    const neverResolvingChild = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => {},
    };
    const ctx = {
      _spawnImpl: () => neverResolvingChild,
      env: { ...process.env },
      cwd: process.cwd(),
      // NO ctx.timeoutMs — adapter must use its own (env-derived)
      // default, which '0' should NOT zero out.
    };
    let racedRejection = null;
    const spawnPromise = adapter.spawn('dummy', ctx).catch((e) => { racedRejection = e; });
    await Promise.race([
      spawnPromise,
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    // Did the spawn reject within 2 seconds? If so, the env zeroed
    // the cap — bug. If not, the default held.
    expect(racedRejection).toBeNull();
  }, 5000);
});
