/* eslint-disable import/no-unresolved, import/extensions */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const catalogRoutes = require('../../routes/registry/catalog');

const JWT_SECRET = 'test-jwt-secret-byo-next-name';

describe('BYO next-free-name lookup', () => {
  let app;
  let owner;
  let other;
  let token;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    app = express();
    app.use('/api/registry', catalogRoutes);
    owner = await User.create({ username: 'name-owner', email: 'name-owner@test.com', password: 'password123' });
    other = await User.create({ username: 'name-other', email: 'name-other@test.com', password: 'password123' });
    token = jwt.sign({ id: String(owner._id) }, JWT_SECRET);
  });

  afterAll(async () => { await closeMongoDb(); });

  beforeEach(async () => {
    await AgentInstallation.deleteMany({});
    await Pod.deleteMany({});
  });

  const pod = async (name, memberIds, publicRead = false) => Pod.create({
    name, type: 'chat', createdBy: memberIds[0], members: memberIds, publicRead,
  });
  const install = (target, name, installedBy = owner._id, status = 'active') => AgentInstallation.create({
    podId: target._id, agentName: name, instanceId: 'default', version: '1.0.0', installedBy, status,
  });

  it('uses active names in the caller’s private member pods and skips other scopes', async () => {
    const first = await pod('one', [owner._id]);
    const second = await pod('two', [other._id, owner._id]);
    const publicPod = await pod('public', [owner._id], true);
    const unrelated = await pod('unrelated', [other._id]);
    await Promise.all([
      install(first, 'sam-claude'),
      install(second, 'sam-claude-2', other._id),
      install(publicPod, 'sam-claude-3'),
      install(unrelated, 'sam-claude-3', other._id),
      install(first, 'sam-claude-3', owner._id, 'uninstalled'),
    ]);

    const response = await request(app)
      .get('/api/registry/agents/next-free-name?base=sam-claude')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ name: 'sam-claude-3' });
  });

  it('requires authentication and a valid base', async () => {
    expect((await request(app).get('/api/registry/agents/next-free-name?base=sam-claude')).status).toBe(401);
    const invalid = await request(app)
      .get('/api/registry/agents/next-free-name?base[$ne]=x')
      .set('Authorization', `Bearer ${token}`);
    expect(invalid.status).toBe(400);
  });
});
