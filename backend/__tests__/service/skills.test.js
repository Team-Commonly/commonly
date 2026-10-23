const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const Pod = require('../../models/Pod');
const PodAsset = require('../../models/PodAsset');
const PodAssetService = require('../../services/podAssetService').default;
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const { issueRuntimeTokenForAgent } = require('../../routes/registry/tokens');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');
const skillsRoutes = require('../../routes/skills');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const JWT_SECRET = 'test-jwt-secret';

describe('Skills Catalog Routes', () => {
  test('normalizes long punctuation runs without changing scoped skill keys', () => {
    expect(PodAssetService.normalizeSkillKey(`${'-'.repeat(100_000)}Focus---Mode${'-'.repeat(100_000)}`))
      .toBe('focus-mode');
    expect(PodAssetService.buildScopedSkillKey({ name: 'Focus Mode', scope: 'agent', agentName: 'Scout', instanceId: 'default' }))
      .toBe('focus-mode-scout-default');
  });

  let app;
  let authToken;
  let userId;
  let podId;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/skills', skillsRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    const user = await User.create({
      username: 'skilluser',
      email: 'skilluser@example.com',
      password: 'password123',
    });
    userId = user._id.toString();
    authToken = jwt.sign({ id: userId }, JWT_SECRET);

    const pod = await Pod.create({
      name: 'Skill Pod',
      description: 'Test pod for skills',
      type: 'chat',
      createdBy: user._id,
      members: [user._id],
    });
    podId = pod._id.toString();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  test('lists catalog items', async () => {
    const res = await request(app)
      .get('/api/skills/catalog?source=awesome')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('awesome');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  test('imports a skill into a pod', async () => {
    const res = await request(app)
      .post('/api/skills/import')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        podId,
        name: 'Focus Mode',
        content: '# Focus Mode\n\nUse this to stay focused.',
        tags: ['focus', 'productivity'],
        sourceUrl: 'https://example.com/skill',
        license: 'MIT',
        scope: 'pod',
      });

    expect(res.status).toBe(201);
    expect(res.body.podId).toBe(podId);
    expect(res.body.name).toBe('Focus Mode');

    const asset = await PodAsset.findOne({
      podId,
      type: 'skill',
      'metadata.skillName': 'Focus Mode',
      'metadata.sourceUrl': 'https://example.com/skill',
    });
    expect(asset).toBeTruthy();
    expect(asset.metadata.license).toBe('MIT');
  });

  test('only the installer or instance admin can add and remove agent skills', async () => {
    const member = await User.create({ username: 'skillmember', email: 'skillmember@example.com', password: 'password123' });
    await Pod.updateOne({ _id: podId }, { $push: { members: member._id } });
    const memberToken = jwt.sign({ id: member._id.toString() }, JWT_SECRET);
    await AgentInstallation.create({ agentName: 'scout', instanceId: 'default', podId, version: '1.0.0', installedBy: userId });
    const body = { podId, name: 'Review', content: '# Review', scope: 'agent', agentName: 'scout', instanceId: 'default' };

    const deniedAdd = await request(app).post('/api/skills/import').set('Authorization', `Bearer ${memberToken}`).send(body);
    expect(deniedAdd.status).toBe(403);
    expect(await PodAsset.countDocuments({ podId, type: 'skill', 'metadata.skillName': 'Review' })).toBe(0);

    const admin = await User.create({ username: 'skilladmin', email: 'skilladmin@example.com', password: 'password123', role: 'admin' });
    await Pod.updateOne({ _id: podId }, { $push: { members: admin._id } });
    const adminToken = jwt.sign({ id: admin._id.toString() }, JWT_SECRET);
    const adminAdd = await request(app).post('/api/skills/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ ...body, name: 'Admin review' });
    expect(adminAdd.status).toBe(201);

    const added = await request(app).post('/api/skills/import').set('Authorization', `Bearer ${authToken}`).send(body);
    expect(added.status).toBe(201);
    const url = `/api/skills/pods/${podId}/imported?scope=agent&agentName=scout&instanceId=default&name=Review`;
    const deniedRemove = await request(app).delete(url).set('Authorization', `Bearer ${memberToken}`);
    expect(deniedRemove.status).toBe(403);
    expect(await PodAsset.countDocuments({ podId, status: 'active', 'metadata.skillName': 'Review' })).toBe(1);

    const removed = await request(app).delete(url).set('Authorization', `Bearer ${authToken}`);
    expect(removed.status).toBe(200);
    expect(await PodAsset.countDocuments({ podId, status: 'active', 'metadata.skillName': 'Review' })).toBe(0);
  });

  test('records mounted names for the authenticated agent and returns them to the page', async () => {
    await request(app).post('/api/skills/import').set('Authorization', `Bearer ${authToken}`)
      .send({ podId, name: 'review', content: '# Review', scope: 'agent', agentName: 'scout', instanceId: 'default' });
    await request(app).post('/api/skills/import').set('Authorization', `Bearer ${authToken}`)
      .send({ podId, name: 'local-only', content: '# Local', metadataOnly: true, scope: 'agent', agentName: 'scout', instanceId: 'default' });
    const installation = await AgentInstallation.findOne({ podId, agentName: 'scout' });
    const agentUser = await AgentIdentityService.getOrCreateAgentUser('scout', { instanceId: 'default' });
    const { token } = await issueRuntimeTokenForAgent(agentUser, 'test skill mount', installation);
    const feed = await request(app).get(`/api/agents/runtime/pods/${podId}/skills`)
      .set('Authorization', `Bearer ${token}`);
    expect(feed.status).toBe(200);
    expect(feed.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'review', content: '# Review' }),
    ]));
    expect(feed.body.items.map((item) => item.name)).not.toContain('local-only');
    const path = `/api/agents/runtime/pods/${podId}/skill-load`;
    const posted = await request(app).post(path).set('Authorization', `Bearer ${token}`)
      .send({ mounted: ['review', 'private-operator-skill'], conflicted: ['draft'] });
    expect(posted.status).toBe(200);
    const installAfter = await AgentInstallation.findById(installation._id).lean();
    expect(installAfter.skillLoad).toMatchObject({ mounted: ['review', 'private-operator-skill'], conflicted: ['draft'] });
    expect(installAfter.skillLoad.at).toBeInstanceOf(Date);

    const read = await request(app).get(`/api/skills/pods/${podId}/imported?scope=agent&agentName=scout&instanceId=default`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(read.status).toBe(200);
    expect(read.body.skillLoad).toMatchObject({ mounted: ['review'], conflicted: [] });
    expect(JSON.stringify(read.body)).not.toContain('private-operator-skill');
    expect(read.body.canEdit).toBe(true);

    const unavailable = await request(app).post(path).set('Authorization', `Bearer ${token}`)
      .send({ mounted: [], conflicted: [], status: 'unavailable' });
    expect(unavailable.status).toBe(200);
    const unavailableRead = await request(app).get(`/api/skills/pods/${podId}/imported?scope=agent&agentName=scout&instanceId=default`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(unavailableRead.body.skillLoad).toMatchObject({ status: 'unavailable', mounted: [], conflicted: [] });

    const invalid = await request(app).post(path).set('Authorization', `Bearer ${token}`)
      .send({ mounted: ['/private/skill'], conflicted: [] });
    expect(invalid.status).toBe(400);
    expect((await AgentInstallation.findById(installation._id).lean()).skillLoad.status)
      .toBe('unavailable');

    await request(app).delete(`/api/skills/pods/${podId}/imported?scope=agent&agentName=scout&instanceId=default&name=review`)
      .set('Authorization', `Bearer ${authToken}`);
    const afterRemove = await request(app).get(`/api/agents/runtime/pods/${podId}/skills`)
      .set('Authorization', `Bearer ${token}`);
    expect(afterRemove.status).toBe(200);
    expect(afterRemove.body.items.map((item) => item.name)).not.toContain('review');
  });
});
