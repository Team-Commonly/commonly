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

const router: ReturnType<typeof express.Router> = express.Router();

// eslint-disable-next-line global-require
router.use(require('./registry/runtime'));
// eslint-disable-next-line global-require
router.use(require('./registry/manage-grants'));
// eslint-disable-next-line global-require
router.use(require('./registry/templates'));
// eslint-disable-next-line global-require
router.use(require('./registry/catalog'));
// Every router mounted below shares this per-IP budget (D175). It used to
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
router.use(require('./registry/provider-key'));
// eslint-disable-next-line global-require
router.use(require('./registry/publish'));
// eslint-disable-next-line global-require
router.use(require('./registry/owned-entry'));

module.exports = router;

export {};
