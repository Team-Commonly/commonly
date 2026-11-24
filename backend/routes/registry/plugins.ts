// Registry routes the retired OpenClaw gateway served (F585, ADR-021).
//
// The plugin routes listed and installed plugins by running `openclaw plugins …`
// inside the OpenClaw gateway: `docker exec` into a `moltbot` container, or an
// exec into the gateway Deployment. The gateway left the chart, the workflows
// and the repo (#3728, ADR-021 Part B), and no compose file runs that
// container, so on every deployment the call threw and the catch-all answered
// 500. Nothing in the app, the CLI or the MCP server calls them. They answer
// 410 with a code, so a caller learns the feature is gone instead of seeing a
// server error.
//
// The rest are the gateway's other registry routes, removed with the backend
// driver: the bundled-skills list, the session clear, the HEARTBEAT.md write
// and the IDENTITY.md read and write. Each read or wrote the gateway's
// workspace, so each answers 410 runtime_retired. GET heartbeat-file stays in
// files.ts and reads the AgentProfile.
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../../middleware/ipRateLimit';

const express = require('express');
const auth = require('../../middleware/auth');
const { RUNTIME_RETIRED_BODY } = require('../../services/retiredRuntime');

const pluginsRouter = express.Router({ mergeParams: true });

// Ahead of auth, so auth's Mongo lookup is covered too (see files.ts).
const retiredRouteLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
});

const OPENCLAW_PLUGINS_RETIRED = {
  code: 'openclaw_plugins_retired',
  error: 'Plugin management was retired with the OpenClaw gateway. '
    + 'This instance has no OpenClaw runtime to list or install plugins in.',
};

const retired = (_req: any, res: any) => res.status(410).json(OPENCLAW_PLUGINS_RETIRED);
const runtimeRetired = (_req: any, res: any) => res.status(410).json(RUNTIME_RETIRED_BODY);

pluginsRouter.get('/pods/:podId/agents/:name/plugins', retiredRouteLimit, auth, retired);
pluginsRouter.post('/pods/:podId/agents/:name/plugins/install', retiredRouteLimit, auth, retired);

pluginsRouter.get('/openclaw/bundled-skills', retiredRouteLimit, auth, runtimeRetired);
pluginsRouter.post('/pods/:podId/agents/:name/runtime-clear-sessions', retiredRouteLimit, auth, runtimeRetired);
pluginsRouter.post('/pods/:podId/agents/:name/heartbeat-file', retiredRouteLimit, auth, runtimeRetired);
pluginsRouter.get('/pods/:podId/agents/:name/identity-file', retiredRouteLimit, auth, runtimeRetired);
pluginsRouter.post('/pods/:podId/agents/:name/identity-file', retiredRouteLimit, auth, runtimeRetired);

module.exports = pluginsRouter;
module.exports.OPENCLAW_PLUGINS_RETIRED = OPENCLAW_PLUGINS_RETIRED;

export {};
