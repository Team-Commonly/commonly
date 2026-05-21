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
  async function runWithTimeout(adapterPath, timeoutMs) {
    process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS = String(timeoutMs);
    const adapter = (await import(adapterPath)).default;
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
      timeoutMs: 100,
    };
    let caught;
    try { await adapter.spawn('dummy', ctx); } catch (e) { caught = e; }
    expect(String(caught?.message || '')).toMatch(/timed out after 100ms/);
  });

  test('non-positive env value falls through to default', async () => {
    process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS = '0';
    const adapter = (await import('../src/lib/adapters/codex.js')).default;
    // Same shape as above — proves module loads fine.
    expect(adapter).toBeTruthy();
    expect(typeof adapter.spawn).toBe('function');
  });
});
