const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const App = require('../../models/App');
const AppInstallation = require('../../models/AppInstallation');
const User = require('../../models/User');
const appsRoutes = require('../../routes/apps');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const JWT_SECRET = 'test-jwt-secret';

describe('Apps Platform Routes', () => {
  let app;
  let authToken;
  let userId;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/apps', appsRoutes);

    // create user for ownership
    const user = await User.create({
      username: 'appowner',
      email: 'appowner@example.com',
      password: 'password123',
    });
    userId = user._id.toString();
    authToken = jwt.sign({ id: userId }, JWT_SECRET);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  test('creates an app and returns secrets', async () => {
    const res = await request(app)
      .post('/api/apps')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Test App', webhookUrl: 'https://example.com/webhook' });

    if (res.status !== 201) {
      throw new Error(`create app failed: ${JSON.stringify(res.body)}`);
    }
    expect(res.status).toBe(201);
    expect(res.body.clientId).toBeTruthy();
    expect(res.body.clientSecret).toBeTruthy();
    expect(res.body.webhookSecret).toBeTruthy();

    const saved = await App.findOne({ clientId: res.body.clientId });
    expect(saved).toBeTruthy();
    expect(saved.name).toBe('Test App');
  });

  test('lists apps for current user without secrets', async () => {
    // app created above should be visible
    const res = await request(app)
      .get('/api/apps')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).not.toHaveProperty('clientSecretHash');
    expect(res.body[0]).not.toHaveProperty('webhookSecretHash');
  });

  test('creates an installation and returns token', async () => {
    const appDoc = await App.create({
      name: 'Installable',
      webhookUrl: 'https://example.com/hook',
      webhookSecretHash: 'x',
      clientId: 'cid',
      clientSecretHash: 'csecret',
      ownerId: userId,
    });

    const res = await request(app)
      .post('/api/apps/installations')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ appId: appDoc._id, targetType: 'pod', targetId: '507f191e810c19729de860ff' });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();

    const inst = await AppInstallation.findById(res.body.installationId);
    expect(inst).toBeTruthy();
    expect(inst.appId.toString()).toBe(appDoc._id.toString());
  });

  test('prevents creating app without required fields', async () => {
    const res = await request(app)
      .post('/api/apps')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ description: 'missing fields' });

    expect(res.status).toBe(400);
  });
});
