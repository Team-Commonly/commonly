/**
 * Agent Registry Routes
 *
 * API for the agent "package manager" - discover, install, configure agents.
 * Routes are split into focused sub-modules under ./registry/ (GH#112).
 */

// eslint-disable-next-line global-require
const express = require('express');

const router: ReturnType<typeof express.Router> = express.Router();

// eslint-disable-next-line global-require
router.use(require('./registry/runtime'));
// eslint-disable-next-line global-require
router.use(require('./registry/templates'));
// eslint-disable-next-line global-require
router.use(require('./registry/catalog'));
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
router.use(require('./registry/publish'));

module.exports = router;

export {};
