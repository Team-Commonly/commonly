/* eslint-disable global-require */
/**
 * TASK-150, the route half.
 *
 * The declared-entry guard admits exactly ONE http entry: the grant broker, at
 * `/api/mcp/grants/<id>` on this instance's own origin. That is the set this
 * test has to prove is redirect-free, because the hop the guard cannot see is
 * one WE serve: Claude Code follows a cross-origin redirect and codex 0.153.4
 * refuses one, so a 3xx here either moves the seat's call off the instance or
 * breaks it. Pinning the origin in the guard does not cover it — the origin is
 * ours on both legs.
 *
 * Mounted on the EXPORTED app, not the router alone. `mcpGrants.test.js`
 * builds `express().use('/api/mcp/grants', router)`, which is right for the
 * protocol and blind to everything mounted ahead of the router — and that is
 * exactly where a redirect would come from (cors, a proxy-header or https
 * rewrite, a static handler, a rate limiter that answers with one). The
 * witness below shows this harness sees a hop that a router-only harness
 * cannot.
 *
 * Every method, unauthenticated and authenticated, answers outside 300-399 and
 * carries no `Location`.
 */
const request = require('supertest');

jest.mock('../../../config/db', () => jest.fn());
jest.mock('../../../config/db-pg', () => ({ connectPG: jest.fn().mockResolvedValue(null) }));
jest.mock('../../../config/init-pg-db', () => jest.fn());
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});

// This test is about the middleware stack in FRONT of the route, not about
// authentication or the broker, so both are stubbed: the auth middleware
// accepts a bearer and refuses a request without one (the two arms the
// assertion needs), and the broker server answers the MCP handshake so the
// authenticated POST is shown to reach the handler rather than 404. What is
// under test — a redirect ahead of the router — behaves identically for a live
// grant row, because neither the row nor the broker runs before the hop does.
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  if (!req.headers.authorization) return res.status(401).json({ error: 'agent_identity_required' });
  req.agentUser = {
    _id: 'agent-a',
    username: 'openclaw-aria',
    botMetadata: { agentName: 'openclaw', instanceId: 'aria' },
  };
  req.agentInstallation = { agentName: 'openclaw', instanceId: 'aria' };
  return next();
});
const mockListToolsForGrant = jest.fn();
const mockCallTool = jest.fn();
jest.mock('../../../services/toolBrokerService', () => ({
  getToolDefinitions: () => [],
  listToolsForGrant: mockListToolsForGrant,
  callTool: mockCallTool,
}));

const GRANT_URL = '/api/mcp/grants/grant_4df79b67';
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
const HANDSHAKE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'task-150-route-test', version: '1' },
  },
};

// One row per method, so a failure names the method that hopped instead of
// reporting "something in this list redirected".
const BODY_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const survey = async (app, { auth }) => Promise.all(METHODS.map(async (method) => {
  let call = request(app)[method](GRANT_URL);
  // The MCP transport answers 406 without a streamable-http Accept.
  if (BODY_METHODS.has(method)) call = call.set('Accept', 'application/json, text/event-stream');
  if (auth) call = call.set('Authorization', 'Bearer cm_agent_test-token');
  // The handshake body only goes on the methods that carry one: superagent
  // passes an object straight to `end` on GET/HEAD/OPTIONS and throws.
  if (BODY_METHODS.has(method)) call = call.send(HANDSHAKE);
  const res = await call;
  return { method, status: res.status, location: res.headers.location };
}));

const hopped = (rows) => rows.filter((row) => (row.status >= 300 && row.status < 400) || row.location);

describe('the declared grant-broker path answers no redirect (TASK-150)', () => {
  let app;

  beforeAll(() => {
    // eslint-disable-next-line import/no-unresolved, import/extensions
    ({ app } = require('../../../server'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockListToolsForGrant.mockResolvedValue([]);
  });

  it('unauthenticated: no method answers 3xx and none sets Location', async () => {
    const rows = await survey(app, { auth: false });
    expect(hopped(rows)).toEqual([]);
    // The path is really mounted and really gated: the POST is the only method
    // with a handler, and without a token it is refused rather than redirected.
    expect(rows.find((row) => row.method === 'post').status).toBe(401); 
  });

  it('authenticated: the handler answers, and no method answers 3xx or sets Location', async () => {
    const rows = await survey(app, { auth: true });
    expect(hopped(rows)).toEqual([]);
    // Non-vacuity: the authenticated POST reached the MCP transport (200) and
    // the other methods fell through to the app's handler (404). Without this,
    // an app that answered 404 to everything would satisfy the assertion above.
    expect(rows.find((row) => row.method === 'post').status).toBe(200);
    // The CORS preflight answers 204 (no Location, which is what the assertion
    // above reads); every other method that has no handler falls through to the
    // app's 404. 204 and 404 are what a seat sees today and neither is a hop.
    expect(rows.find((row) => row.method === 'options').status).toBe(204);
    const others = rows.filter((r) => !['post', 'options'].includes(r.method));
    // Compared as pairs so a failure names the method instead of printing
    // "expected false to be true".
    expect(others.map((r) => [r.method, r.status])).toEqual(others.map((r) => [r.method, 404]));
  });

  it('witness: this harness sees a hop mounted ahead of the app', async () => {
    const express = require('express');
    const wrapped = express();
    wrapped.use((_req, res) => res.redirect(307, 'https://attacker.test/collect'));
    wrapped.use(app);
    const rows = await survey(wrapped, { auth: true });
    expect(hopped(rows)).toHaveLength(METHODS.length);
    expect(rows[0].location).toBe('https://attacker.test/collect');
  });
});
