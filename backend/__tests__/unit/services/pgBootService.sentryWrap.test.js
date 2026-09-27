/**
 * TASK-172 — the PREMISE behind #1958's wrap clause, checked against the real
 * library instead of a stand-in.
 *
 * THE GAP THIS CLOSES. `pgBootService.test.js` proves the wrap clause works:
 * it hands `routerIsMounted` a layer whose handle it has wrapped by hand
 * (`wrapLikeSentry`). It cannot do better, because jest owns module loading and
 * `@sentry/node` patches express through a require-hook — so in-suite
 * `layer.handle === router` is TRUE even with Sentry initialised. The
 * consequence is that the suite pins the FIX and never the REASON: if a Sentry
 * upgrade stops exposing `.stack` on the wrapper, every case stays green and
 * production goes back to refusing a pod that has the PG routes mounted, which
 * is the rollout hang of 2026-09-27 (deploy `4e60f240`: `deployment.apps/backend`
 * did not become ready within 8m, `/api/pg/messages` 401 on a pod whose
 * `/ready` said "not mounted").
 *
 * HOW IT ESCAPES THE TIER. The probe is a spawned plain-`node` child
 * (`__tests__/utils/sentryLayerWrapProbe.js`), so the module registry is the
 * real one: `Sentry.init()` runs before `require('express')` and the patch
 * lands. `process.execPath` is used, so the child runs whatever node the suite
 * runs — the premise is checked under the interpreter that would run it.
 *
 * WHY THREE ASSERTIONS AND NOT ONE. "It reads true" can be true for the wrong
 * reason, so the probe reports the shape of the instrumentation as well as the
 * answer, and the suite pins both directions of the failure:
 *
 *   - `wrapped` false under Sentry  → the check is VACUOUS. Identity alone
 *     answers the question, so the suite would pass with the clause deleted and
 *     a future reader would be told the clause is load-bearing when it is not.
 *     (Or the instrumentation failed to install in the child, which is worth
 *     knowing too — the message names both.)
 *   - `wrapped` true, `handleHasStack` false → the exact production break: the
 *     clause can no longer match a mounted router, so readiness refuses a pod
 *     that has chat. Red here is a deploy-blocking regression caught pre-merge
 *     instead of at rollout.
 *   - no-wrong-answer direction: an unmounted router must be false, and a
 *     router mounted on a DIFFERENT app must be false. The clause WIDENS a
 *     match (it accepts `handle.stack === routerStack`), so this is the
 *     direction that would silently start reporting "mounted" for a router the
 *     app does not serve.
 *
 * The `PROBE_SENTRY=0` run is the positive control: identical construction with
 * no instrumentation. `wrapped` must be false there, which is what makes the
 * instrumented run's `wrapped: true` attributable to Sentry rather than to the
 * express version — and what proves the probe can see a difference rather than
 * reporting a blind null.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const PROBE = path.join(__dirname, '..', '..', 'utils', 'sentryLayerWrapProbe.js');
const BACKEND_ROOT = path.join(__dirname, '..', '..', '..');

const runProbe = (withSentry) => {
  const proc = spawnSync(process.execPath, [PROBE], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, PROBE_SENTRY: withSentry ? '1' : '0' },
  });

  const lines = (proc.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let result = null;
  try {
    result = JSON.parse(lines[lines.length - 1]);
  } catch (error) {
    result = null;
  }

  // Reported rather than asserted here, so each case can name what it expected
  // and the reader gets the child's own output when the probe could not run.
  return {
    result,
    status: proc.status,
    signal: proc.signal,
    stderr: (proc.stderr || '').trim(),
    stdout: (proc.stdout || '').trim(),
  };
};

const describeProbe = (label, run) => {
  const detail = `[${label}] exit=${run.status} signal=${run.signal} stdout=${run.stdout} stderr=${run.stderr}`;
  if (!run.result) throw new Error(`the probe produced no JSON result. ${detail}`);
  if (run.result.error) {
    throw new Error(`the probe threw in the child: ${run.result.error}. ${detail}`);
  }
  return run.result;
};

describe('routerIsMounted under real @sentry/node instrumentation (TASK-172)', () => {
  let plain;
  let instrumented;

  beforeAll(() => {
    plain = runProbe(false);
    instrumented = runProbe(true);
  });

  it('control: with no instrumentation the layer handle IS the router, and the answer is true', () => {
    const result = describeProbe('control', plain);
    expect(result.sentry).toBe(false);
    // The control is what gives the instrumented run meaning: if this were true
    // there too, the probe would be blind to the patch rather than measuring it.
    expect(result.wrapped).toBe(false);
    expect(result.self).toBe(true);
  });

  it('instrumentation really replaces the layer handle, so this suite is not vacuous', () => {
    const result = describeProbe('instrumented', instrumented);
    expect(result.sentry).toBe(true);
    expect(result.layerFound).toBe(true);
    expect(result.wrapped).toBe(true);
    expect(result.handleName).not.toBe('router');
    // The property #1958's clause keys on. If this goes false, the clause
    // cannot match and readiness refuses a pod that has the routes mounted —
    // the production shape this file exists to catch before a rollout.
    expect(result.handleHasStack).toBe(true);
  });

  it('answers true for a mounted router while instrumentation has wrapped its layer', () => {
    const result = describeProbe('instrumented', instrumented);
    expect(result.self).toBe(true);
  });

  it('answers false for a router that is not mounted, and for one mounted on another app', () => {
    const result = describeProbe('instrumented', instrumented);
    expect(result.unmounted).toBe(false);
    expect(result.foreign).toBe(false);
  });
});
