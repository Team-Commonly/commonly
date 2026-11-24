// OpenClaw plugin management, retired (F585).
//
// These routes listed and installed plugins by running `openclaw plugins …`
// inside the OpenClaw gateway: `docker exec` into a `moltbot` container, or an
// exec into the gateway Deployment. The gateway left the chart, the workflows
// and the repo (#3728, ADR-021 Part B), and no compose file runs that
// container, so on every deployment the call threw and the catch-all answered
// 500. Nothing in the app, the CLI or the MCP server calls them. They now
// answer 410 with a code, so a caller learns the feature is gone instead of
// seeing a server error. The provisioner's OpenClaw functions stay until the
// moltbot driver's own removal.
const express = require('express');
const auth = require('../../middleware/auth');

const pluginsRouter = express.Router({ mergeParams: true });

const OPENCLAW_PLUGINS_RETIRED = {
  code: 'openclaw_plugins_retired',
  error: 'Plugin management was retired with the OpenClaw gateway. '
    + 'This instance has no OpenClaw runtime to list or install plugins in.',
};

const retired = (_req: any, res: any) => res.status(410).json(OPENCLAW_PLUGINS_RETIRED);

pluginsRouter.get('/pods/:podId/agents/:name/plugins', auth, retired);
pluginsRouter.post('/pods/:podId/agents/:name/plugins/install', auth, retired);

module.exports = pluginsRouter;
module.exports.OPENCLAW_PLUGINS_RETIRED = OPENCLAW_PLUGINS_RETIRED;

export {};
