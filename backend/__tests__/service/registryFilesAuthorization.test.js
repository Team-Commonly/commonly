const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');

// An agent's heartbeat file and its persona generator belong to whoever
// installed that agent. Pod membership lets a person see the agent; it does
// not let them read its heartbeat or spend a model call on its persona. The
// LLM call is the side-effect boundary; auth, pod access, installation lookup
// and the AgentProfile read run against the real models. (The heartbeat write
// and the identity-file routes served the retired OpenClaw gateway; plugins.ts
// answers them 410, covered by registry.plugins-retired.)
jest.mock('../../services/llmService', () => ({
  generateText: jest.fn(async () => JSON.stringify({ tone: 'calm', specialties: [], boundaries: [] })),
}));
const { generateText } = require('../../services/llmService');
const filesRouter = require('../../routes/registry/files');

const SECRET = 'registry-files-authorization-test';
const AgentProfileModule = require('../../models/AgentProfile');

const AgentProfile = AgentProfileModule.default || AgentProfileModule;

// [method, path suffix, what the installer gets through to]
const operations = [
  ['post', 'persona/generate', (res) => expect(generateText).toHaveBeenCalled()],
  ['get', 'heartbeat-file', (res) => expect(res.body).toEqual({ content: '- check in', accountId: 'curator' })],
];

describe('agent workspace files are read and written only by the agent installer', () => {
  let server;
  let owner;
  let otherOwner;
  let member;
  let creator;
  let admin;
  let outsider;
  let pod;
  let installation;
  let ipCounter = 0;
  const effects = () => generateText.mock.calls.length;
  let soloPod;
  const call = (method, operation, user, { instanceId = 'curator', podId } = {}) => {
    ipCounter += 1;
    const url = `/api/registry/pods/${podId || pod._id}/agents/codex/${operation}`;
    const req = request(server)[method](url)
      .set('Authorization', `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`)
      .set('cf-connecting-ip', `198.51.100.${ipCounter % 250}`);
    return method === 'get'
      ? req.query({ instanceId })
      : req.send({ instanceId, content: '- check in' });
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    [owner, otherOwner, member, creator, admin, outsider] = await Promise.all(
      ['owner', 'other-owner', 'member', 'creator', 'admin', 'outsider'].map((name) => User.create({
        username: `files-${name}`,
        email: `files-${name}@example.test`,
        password: 'test-password',
        role: name === 'admin' ? 'admin' : 'user',
      })),
    );
    pod = await Pod.create({
      name: 'Agent files',
      createdBy: creator._id,
      members: [owner._id, otherOwner._id, member._id, creator._id],
    });
    installation = await AgentInstallation.create({
      agentName: 'codex', instanceId: 'curator', podId: pod._id, version: '1', installedBy: owner._id,
    });
    await AgentProfile.create({
      agentId: 'codex:curator', agentName: 'codex', instanceId: 'curator', podId: pod._id,
      name: 'Curator', purpose: 'Keeps the pod tidy.', createdBy: owner._id, heartbeatContent: '- check in',
    });
    // A pod with exactly one active install, so a request for any other
    // instance would have resolved to it under the old one-install fallback.
    soloPod = await Pod.create({ name: 'Solo agent', createdBy: owner._id, members: [owner._id] });
    await AgentInstallation.create({
      agentName: 'codex', instanceId: 'default', podId: soloPod._id, version: '1', installedBy: owner._id,
    });
    await AgentInstallation.create({
      agentName: 'codex', instanceId: 'scout', podId: pod._id, version: '1', installedBy: otherOwner._id,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/registry', filesRouter);
    server = await new Promise((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
  });
  beforeEach(() => { generateText.mockClear(); });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await clearMongoDb();
    await closeMongoDb();
  });

  describe.each(operations)('%s %s', (method, operation, reached) => {
    it('answers a pod member who did not install the agent with 403 installer_only', async () => {
      const res = await call(method, operation, member);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('installer_only');
      expect(effects()).toBe(0);
    });

    it('answers the pod creator who did not install the agent with 403 installer_only', async () => {
      const res = await call(method, operation, creator);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('installer_only');
      expect(effects()).toBe(0);
    });

    it('matches the instance exactly: the installer of one instance cannot act on another', async () => {
      const res = await call(method, operation, owner, { instanceId: 'scout' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('installer_only');
      expect(effects()).toBe(0);
    });

    it('does not fall back to another instance when the requested one is not installed', async () => {
      const res = await call(method, operation, owner, { instanceId: 'missing' });
      expect(res.status).toBe(404);
      expect(effects()).toBe(0);
    });

    it('keeps refusing a caller outside the pod', async () => {
      const res = await call(method, operation, outsider);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Access denied');
      expect(res.body.code).toBeUndefined();
      expect(effects()).toBe(0);
    });

    it('lets the installer through', async () => {
      const res = await call(method, operation, owner);
      expect(res.status).toBe(200);
      reached(res);
    });

    it('lets an instance admin (role read from the database) through', async () => {
      const res = await call(method, operation, admin);
      expect(res.status).toBe(200);
      reached(res);
    });
  });

  it.each([
    ['get', 'heartbeat-file'],
    ['post', 'persona/generate'],
  ])('%s %s answers 404 for a named instance even when the pod has exactly one install', async (method, operation) => {
    const res = await call(method, operation, owner, { podId: soloPod._id, instanceId: 'other' });
    expect(res.status).toBe(404);
    expect(effects()).toBe(0);
  });
});
