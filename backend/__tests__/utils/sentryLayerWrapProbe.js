/**
 * TASK-172 — the real-Sentry proof of the premise behind #1958's wrap clause.
 *
 * WHY THIS IS A SPAWNED CHILD AND NOT A SUITE. Jest cannot host this check.
 * `@sentry/node` patches `express` through OpenTelemetry's require-hook, which
 * installs itself on `Module._load` when `Sentry.init()` runs; jest owns module
 * loading instead, so express is never patched in-suite and
 * `layer.handle === router` stays TRUE there. That is exactly why
 * `pgBootService.test.js` has to fake the wrapper with `wrapLikeSentry` — and
 * exactly why the faked wrapper pins the FIX and can never pin the PREMISE.
 * The premise is a fact about the real library, so it needs a real `node`.
 *
 * It lives under `__tests__/utils/` because jest's `testMatch` collects
 * everything under `__tests__/` and would otherwise fail this directory-shaped
 * way ("your test suite must contain at least one test" — the same reason
 * `utils/` is already ignored in `backend/jest.config.js`). This file is data
 * for a test, never a test.
 *
 * WHAT IT MEASURES. Three facts, because "the guard reads true" alone can be
 * true for the wrong reason:
 *   1. `wrapped` — did instrumentation actually replace the layer handle with a
 *      wrapper? If this is false, the suite is vacuous: identity alone answers
 *      the question, and a future Sentry that stops wrapping would silently
 *      retire the premise while this probe kept reporting `self: true`.
 *   2. `handleHasStack` — does the wrapper expose the router's own stack array?
 *      That is the property #1958's clause keys on.
 *   3. `self` / `unmounted` / `foreign` — the real `routerIsMounted` answering
 *      true for the mounted router, false for a router that is not mounted, and
 *      false for an app that mounted a DIFFERENT router (the false-positive
 *      direction, which matters because the clause widens a match).
 *
 * `PROBE_SENTRY=0` runs the identical construction with no instrumentation, as
 * the positive control: `wrapped` must be false there, so the difference in
 * `self` is attributable to Sentry rather than to the express version.
 *
 * Prints one JSON line and always exits 0; the suite asserts on the fields, so
 * a crash is reported as a missing result with stderr attached rather than as
 * an opaque non-zero status.
 */
const withSentry = process.env.PROBE_SENTRY === '1';
const out = { sentry: withSentry };

try {
  // ts-node first: nothing else may load express before Sentry.init().
  require('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true },
  });

  if (withSentry) {
    const Sentry = require('@sentry/node');
    Sentry.init({
      // A syntactically valid DSN with a non-resolving host: init() must run for
      // the express instrumentation to install, and no event should ever leave.
      dsn: 'https://0123456789abcdef0123456789abcdef@example.invalid/1',
      tracesSampleRate: 0,
    });
  }

  const express = require('express');
  // A literal path, both so eslint can see the target and so ts-node's hook is
  // the only thing that has to understand the extension.
  const { routerIsMounted } = require('../../services/pgBootService.ts');

  const app = express();
  const router = express.Router();
  const other = express.Router();
  const neverMounted = express.Router();
  router.get('/', (req, res) => res.json({ ok: true }));
  other.get('/', (req, res) => res.json({ ok: true }));
  app.use('/api/pg/messages', router);
  app.use('/api/other', other);

  // A second app that mounts only the other router: asking it about `router`
  // must be false, whether or not the layers are wrapped.
  const foreignApp = express();
  foreignApp.use('/api/other', other);

  const stackOf = (a) => (a._router && a._router.stack) || (a.router && a.router.stack) || [];
  const layerFor = (a, target) => stackOf(a).find(
    (l) => l.handle === target || (l.handle && l.handle.stack === target.stack),
  );

  const layer = layerFor(app, router);
  const foreignLayer = layerFor(foreignApp, other);

  out.layerFound = Boolean(layer);
  out.wrapped = Boolean(layer) && layer.handle !== router;
  out.handleType = layer ? typeof layer.handle : null;
  out.handleName = (layer && layer.handle && layer.handle.name) || null;
  out.handleHasStack = Boolean(layer && layer.handle && layer.handle.stack);
  out.foreignWrapped = Boolean(foreignLayer) && foreignLayer.handle !== other;
  out.self = routerIsMounted(app, router);
  out.unmounted = routerIsMounted(app, neverMounted);
  out.foreign = routerIsMounted(foreignApp, router);
} catch (error) {
  out.error = (error && error.message) || String(error);
  out.stack = (error && error.stack) || null;
}

process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
