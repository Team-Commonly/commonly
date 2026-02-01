const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const Pod = require('../../models/Pod');
const PodAsset = require('../../models/PodAsset');
const User = require('../../models/User');
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
});
