/**
 * Agent Registry Routes
 *
 * API for the agent "package manager" - discover, install, configure agents.
 * Routes are split into focused sub-modules under ./registry/ (GH#112).
 */

const express = require('express');

const router = express.Router();

router.use(require('./registry/runtime'));
router.use(require('./registry/templates'));
router.use(require('./registry/catalog'));
router.use(require('./registry/admin'));
router.use(require('./registry/agent-tokens'));
router.use(require('./registry/pod-agents'));
router.use(require('./registry/plugins'));
router.use(require('./registry/files'));
router.use(require('./registry/presets-router'));
router.use(require('./registry/install'));
router.use(require('./registry/provision'));
router.use(require('./registry/agent-config'));
router.use(require('./registry/publish'));

module.exports = router;
