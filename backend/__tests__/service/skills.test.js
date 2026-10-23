const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const Pod = require('../../models/Pod');
const PodAsset = require('../../models/PodAsset');
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const skillsRoutes = require('../../routes/skills');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const JWT_SECRET = 'test-jwt-secret';

describe('Skills Catalog Routes', () => {
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
});
