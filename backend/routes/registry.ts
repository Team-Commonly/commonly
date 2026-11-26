/**
 * Agent Registry Routes
 *
 * API for the agent "package manager" - discover, install, configure agents.
 * Routes are split into focused sub-modules under ./registry/ (GH#112).
 */

// eslint-disable-next-line global-require
const express = require('express');

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { rateLimit } = require('express-rate-limit');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { cloudflareIpRateLimitKeyGenerator } = require('../middleware/ipRateLimit');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { requireObjectIdParam, INVALID_POD_ID } = require('../middleware/objectIdParam');

const router: ReturnType<typeof express.Router> = express.Router();

// A pod id that can't be an ObjectId answers 400 before any router below casts
// it (F566). Without this, Mongoose throws a CastError and each route's
// catch-all answers 500. On 2026-11-23 UTC a PowerShell call arrived as
// `/agents/<name>/pods/=default`, because PowerShell reads `$podId?instanceId`
// as one variable. This runs ahead of each route's auth, unlike F330's guards.
// That is safe because the answer depends only on the URL's shape: it says
// nothing about any pod, and an existing route already answers 401. It also
// runs ahead of the runtime routes' audit line, which is fine: a refused call
// never reaches a pod.
// Install (POST /agents/:name/pods/:podId) keeps its own pinned 404 for a
// malformed id, so only the DELETE on that path is guarded here. All three are
// middleware (`use`), not route registrations: the guard does no I/O, and the
// routes it fronts keep their own limiters below.
const podIdGuard = requireObjectIdParam('podId', INVALID_POD_ID);
router.use(['/pods/:podId', '/agents/:name/manage-settings/pods/:podId'], podIdGuard);
router.use('/agents/:name/pods/:podId', (req: any, res: any, next: any) => (
  req.method === 'DELETE' ? podIdGuard(req, res, next) : next()
));

// eslint-disable-next-line global-require
router.use(require('./registry/runtime'));
// eslint-disable-next-line global-require
router.use(require('./registry/manage-grants'));
// eslint-disable-next-line global-require
router.use(require('./registry/templates'));
// eslint-disable-next-line global-require
router.use(require('./registry/catalog'));
// Every router mounted below shares this per-IP budget. It used to
// share the catalog's 120/min, which a per-pod read like /v2/agents spends in
// two page loads. Routers above it (runtime, grants, templates) are not
// covered, as before. Sized for fan-out: a 62-pod account is ~125 requests
// per load.
router.use(rateLimit({
  windowMs: 60_000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: any) => cloudflareIpRateLimitKeyGenerator(req),
  handler: (_req: any, res: any) => res.status(429).json({ code: 'rate_limited' }),
}));
// eslint-disable-next-line global-require
router.use(require('./registry/admin'));
// eslint-disable-next-line global-require
router.use(require('./registry/agent-tokens'));
// eslint-disable-next-line global-require
router.use(require('./registry/pod-agents'));
// eslint-disable-next-line global-require
router.use(require('./registry/plugins'));
// eslint-disable-next-line global-require
router.use(require('./registry/files'));
// eslint-disable-next-line global-require
router.use(require('./registry/presets-router'));
// eslint-disable-next-line global-require
router.use(require('./registry/install'));
// eslint-disable-next-line global-require
router.use(require('./registry/provision'));
// eslint-disable-next-line global-require
router.use(require('./registry/agent-config'));
// eslint-disable-next-line global-require
router.use(require('./registry/manage-settings'));
// eslint-disable-next-line global-require
router.use(require('./registry/agent-turns'));
router.use(require('./registry/provider-key'));
// eslint-disable-next-line global-require
router.use(require('./registry/publish'));
// eslint-disable-next-line global-require
router.use(require('./registry/owned-entry'));

module.exports = router;

export {};
