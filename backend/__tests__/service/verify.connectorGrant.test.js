/** TASK-289: connector-grant HTTP scenario for TASK-514's production app factory.
 * Real auth, Mongo and PostgreSQL. GitHub is intercepted only at Axios's HTTP
 * adapter; no route, middleware, service or database model is mocked.
 *
 * The existing GitHub App connect route is admin-only. The first case protects
 * that boundary; the broker case explicitly uses an admin, and does NOT claim
 * ordinary-user onboarding. Lily approved admin bootstrap on 2026-10-25;
 * ordinary-user connection acceptance is tracked separately as TASK-290.
 * This mutating fixture is local/CI only, never a staging/prod walk.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { generateKeyPairSync, randomUUID } = require('crypto');
const { setupMongoDb, closeMongoDb, setupPgDb, closePgDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Installable = require('../../models/Installable');
const Integration = require('../../models/Integration');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { buildGithubToolInstallable } = require('../../services/installable/toolInstallables');
const AgentIdentityService = require('../../services/agentIdentityService');
const { digestArgs } = require('../../models/ToolCall');
const { hash } = require('../../utils/secret');

const tier1 = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const rpc = (response) => {
  const frame = response.text.split('\n').find((line) => line.startsWith('data:'));
  return frame ? JSON.parse(frame.slice(5)) : response.body;
};

tier1('commonly verify connector-grant — admin bootstrap boundary', () => {
  let app;
  let pg;
  let admin;
  let member;
  let agent;
  let pod;
  let previousAdapter;
  let previousEnv;
  const suffix = randomUUID().slice(0, 8);
  const instanceId = `verify-grant-${suffix}`;
  const seatToken = `cm_agent_verify-${randomUUID()}`;
  const installationId = '289001';
  const repository = { owner: 'verify-fixture', repo: 'one-repo' };
  const upstreamToken = `fixture-installation-${suffix}`;
  const vendorRequests = [];
  const headers = (token) => ({ Authorization: `Bearer ${token}` });
  const humanToken = (user) => jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET);

  beforeAll(async () => {
    const envKeys = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_PAT'];
    previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.GITHUB_APP_ID = '289';
    process.env.GITHUB_APP_PRIVATE_KEY = keys.privateKey;
    delete process.env.GITHUB_PAT;
    previousAdapter = axios.defaults.adapter;
    axios.defaults.adapter = async (config) => {
      const url = new URL(config.url);
      const method = String(config.method).toUpperCase();
      vendorRequests.push({ method, path: url.pathname });
      const response = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
      expect(url.origin).toBe('https://api.github.com');
      if (method === 'POST' && url.pathname === `/app/installations/${installationId}/access_tokens`) {
        const signed = String(config.headers.Authorization).replace(/^Bearer /, '');
        expect(jwt.verify(signed, keys.publicKey, { algorithms: ['RS256'] }).iss).toBe('289');
        return response({ token: upstreamToken, expires_at: new Date(Date.now() + 3600000).toISOString() });
      }
      if (method === 'GET' && url.pathname === `/repos/${repository.owner}/${repository.repo}/issues`) {
        expect(config.headers.Authorization).toBe(`Bearer ${upstreamToken}`);
        return response([{ number: 289, title: 'Granted issue', body: 'Fixture text',
          html_url: 'https://github.com/verify-fixture/one-repo/issues/289', labels: [] }]);
      }
      throw new Error(`Unexpected vendor HTTP request: ${method} ${url.pathname}`);
    };

    const { createApp } = require('../../server');
    await setupMongoDb();
    pg = await setupPgDb();
    app = createApp();
    admin = await User.create({ username: `verify-admin-${suffix}`, email: `admin-${suffix}@test.invalid`,
      password: 'fixture-password', role: 'admin' });
    member = await User.create({ username: `verify-member-${suffix}`, email: `member-${suffix}@test.invalid`,
      password: 'fixture-password', role: 'user' });
    agent = await User.create({ username: AgentIdentityService.buildAgentUsername('openclaw', instanceId),
      email: `seat-${suffix}@test.invalid`, password: 'fixture-password', isBot: true, botType: 'agent',
      botMetadata: { agentName: 'openclaw', instanceId },
      agentRuntimeTokens: [{ tokenHash: hash(seatToken), lastUsedAt: new Date() }] });
    pod = await Pod.create({ name: `Verify grant ${suffix}`, type: 'team', publicRead: false,
      joinPolicy: 'invite-only', createdBy: admin._id, members: [admin._id, member._id, agent._id] });
    await AgentInstallation.create({ agentName: 'openclaw', instanceId, podId: pod._id, installedBy: admin._id,
      version: '1.0.0', status: 'active', config: { runtime: { runtimeType: 'native' } } });
    await Installable.create(buildGithubToolInstallable());
    for (const user of [admin, member, agent]) {
      await pg.query('INSERT INTO users (_id, username, is_bot) VALUES ($1,$2,$3)',
        [String(user._id), user.username, Boolean(user.isBot)]);
    }
    await pg.query('INSERT INTO pods (id,name,type,created_by) VALUES ($1,$2,$3,$4)',
      [String(pod._id), pod.name, pod.type, String(admin._id)]);
  }, 120000); // Cold production-route loading and real-store bootstrap, not a request timeout.

  afterAll(async () => {
    axios.defaults.adapter = previousAdapter;
    if (previousEnv) {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    if (app) await new Promise((resolve) => app.locals.socketServer.close(resolve));
    const { pool } = require('../../config/db-pg');
    if (pool) await pool.end();
    await closePgDb();
    await closeMongoDb();
  });

  test('a fresh ordinary member cannot bind the server-held App credential', async () => {
    const result = await request(app).post('/api/integrations/github-app').set(headers(humanToken(member)))
      .send({ installationId, ...repository });
    expect(result.status).toBe(403);
    expect(result.body.message).toBe('Admin access required');
    expect(await Integration.countDocuments({ type: 'github-app', installationId })).toBe(0);
    expect(vendorRequests).toEqual([]);
  });

  test('admin connects one repository; the agent can spend only its read grant and PG records all outcomes', async () => {
    const connected = await request(app).post('/api/integrations/github-app').set(headers(humanToken(admin)))
      .send({ installationId, ...repository }).expect(201);
    const connectionId = connected.body.integration._id;
    const minted = await request(app).post('/api/grants').set(headers(humanToken(admin))).send({
      connectionId, target: { kind: 'pod', id: String(pod._id) }, audience: [String(agent._id)],
      tools: ['github.list_issues'], writeMode: 'read', budget: { calls: 5 },
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }).expect(201);
    const grantId = minted.body.grantId;
    const call = async (id, name, args) => rpc(await request(app).post(`/api/mcp/grants/${grantId}`)
      .set(headers(seatToken)).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }).expect(200));
    const allowed = await call(1, 'github.list_issues', {});
    expect(allowed.result.isError).not.toBe(true);
    expect(JSON.parse(allowed.result.content[0].text).issues[0].number).toBe(289);
    expect(vendorRequests).toEqual([
      { method: 'POST', path: `/app/installations/${installationId}/access_tokens` },
      { method: 'GET', path: '/repos/verify-fixture/one-repo/issues' },
    ]);
    const outsideTool = await call(2, 'github.create_issue', { title: 'Must not write' });
    expect(outsideTool.result.isError).toBe(true);
    expect(JSON.parse(outsideTool.result.content[0].text).error).toBe('tool_not_allowed');
    const outsideRepo = await call(3, 'github.list_issues', { owner: 'another-owner', repo: 'another-repo' });
    expect(outsideRepo.result.isError).toBe(true);
    expect(JSON.parse(outsideRepo.result.content[0].text).error).toBe('invalid_tool_args');
    expect(vendorRequests).toHaveLength(2);

    const rows = (await pg.query('SELECT * FROM tool_calls WHERE grant_id=$1 ORDER BY occurred_at,call_id', [grantId])).rows;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.tool, row.outcome, row.reason])).toEqual(expect.arrayContaining([
      ['github.list_issues', 'ok', null],
      ['github.create_issue', 'refused', 'tool_not_allowed'],
      ['github.list_issues', 'refused', 'invalid_tool_args'],
    ]));
    for (const row of rows) {
      expect(row.agent_user_id).toBe(String(agent._id));
      expect(row.pod_id).toBe(String(pod._id));
      expect(row.args_digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(rows.find((row) => row.outcome === 'ok').credential_owner_id).toBe(String(admin._id));
    expect(rows.find((row) => row.outcome === 'ok').args_digest).toBe(digestArgs({}));
    const trail = await request(app).get(`/api/grants/${grantId}/calls`).set(headers(humanToken(admin))).expect(200);
    expect(JSON.stringify(trail.body)).toContain(rows[0].call_id);
    for (const secret of [upstreamToken, seatToken, process.env.GITHUB_APP_PRIVATE_KEY, 'Must not write', 'another-owner', 'another-repo']) {
      expect(JSON.stringify({ allowed, outsideTool, outsideRepo, trail: trail.body, rows })).not.toContain(secret);
    }
  });
});
