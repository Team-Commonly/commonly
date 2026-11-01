const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const identity = require('../../services/agentIdentityService');
const agentTokensRouter = require('../../routes/registry/agent-tokens');

const SECRET = 'user-token-metadata-test';

// The metadata route reads a select:false digest. This runs the route's own
// query against a real database, so the projection is what decides the answer.
describe('registry user-token metadata on a real database', () => {
  let app;
  let owner;
  let pod;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', agentTokensRouter);
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await clearMongoDb();
    owner = await User.create({ username: 'metadata-owner', email: 'metadata-owner@example.test', password: 'test-password' });
    pod = await Pod.create({ name: 'Token metadata', createdBy: owner._id, members: [owner._id] });
    await AgentInstallation.create({
      agentName: 'openclaw', instanceId: 'curator', podId: pod._id, version: '1', installedBy: owner._id,
    });
  });

  const metadata = () => request(app)
    .get(`/api/registry/pods/${pod._id}/agents/openclaw/user-token`)
    .query({ instanceId: 'curator' })
    .set('Authorization', `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`);

  it('finds the installed agent and reports its digest-only token', async () => {
    const bot = await identity.getOrCreateAgentUser('openclaw', { instanceId: 'curator' });
    expect((await metadata()).body).toEqual({ hasToken: false, scopes: [], scopeMode: 'none' });

    bot.generateApiToken();
    bot.apiTokenScopes = ['agent:context:read'];
    await bot.save();
    const stored = await User.collection.findOne({ _id: bot._id });
    expect(stored.apiToken).toBeUndefined();
    expect(typeof stored.apiTokenHash).toBe('string');

    const res = await metadata();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasToken: true, scopes: ['agent:context:read'], scopeMode: 'scoped' });
    expect(JSON.stringify(res.body)).not.toContain(stored.apiTokenHash);
  });
});
