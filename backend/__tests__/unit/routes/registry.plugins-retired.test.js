// F585: the OpenClaw plugin routes answer 410, not 500.
//
// Listing or installing a plugin ran `openclaw plugins …` inside the OpenClaw
// gateway, by `docker exec` into a `moltbot` container or by exec into the
// gateway Deployment. The gateway left the chart, the workflows and the repo
// (#3728), and no compose file runs that container, so on every deployment the
// call threw and the catch-all answered 500. Prod logged a GET and a POST that
// way twice on 2026-11-24 UTC. Nothing in the app, the CLI or the MCP server calls
// these routes; a caller that does gets a plain answer it can act on.
const express = require('express');
const request = require('supertest');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  if (req.headers['x-test-signed-out']) return res.status(401).json({ code: 'signed_out' });
  req.user = { id: '6a0000000000000000000001' };
  req.userId = '6a0000000000000000000001';
  next();
});

jest.mock('../../../services/agentProvisionerService', () => ({
  ...jest.requireActual('../../../services/agentProvisionerService'),
  listOpenClawPlugins: jest.fn(),
  installOpenClawPlugin: jest.fn(),
  restartAgentRuntime: jest.fn(),
  syncOpenClawSkills: jest.fn(),
}));

const provisioner = require('../../../services/agentProvisionerService');
const { OPENCLAW_PLUGINS_RETIRED } = require('../../../routes/registry/plugins');

const app = express();
app.use(express.json());
app.use('/api/registry', require('../../../routes/registry'));

const POD = '6a0000000000000000000002';

describe('F585: the OpenClaw plugin routes are retired', () => {
  let errorSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  test.each([
    ['GET', `/api/registry/pods/${POD}/agents/openclaw/plugins`, undefined],
    ['POST', `/api/registry/pods/${POD}/agents/openclaw/plugins/install`, { spec: '@scope/plugin' }],
  ])('%s %s answers 410 openclaw_plugins_retired without touching a runtime', async (method, path, body) => {
    const call = method === 'GET' ? request(app).get(path) : request(app).post(path).send(body);
    const res = await call;
    expect(res.status).toBe(410);
    expect(res.body).toEqual(OPENCLAW_PLUGINS_RETIRED);
    expect(OPENCLAW_PLUGINS_RETIRED.code).toBe('openclaw_plugins_retired');
    expect(provisioner.listOpenClawPlugins).not.toHaveBeenCalled();
    expect(provisioner.installOpenClawPlugin).not.toHaveBeenCalled();
    expect(provisioner.restartAgentRuntime).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('still asks a signed-out caller to sign in first', async () => {
    const res = await request(app)
      .get(`/api/registry/pods/${POD}/agents/openclaw/plugins`)
      .set('x-test-signed-out', '1');
    expect(res.status).toBe(401);
  });
});
