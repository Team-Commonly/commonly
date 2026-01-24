const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const App = require('../../../models/App');
const AppInstallation = require('../../../models/AppInstallation');
const appAuth = require('../../../middleware/appAuth');
const { hash } = require('../../../utils/secret');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');

const JWT_SECRET = 'test-jwt-secret';

describe('appAuth middleware', () => {
  let app;
  let installToken;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    const owner = await App.create({
      name: 'MidApp',
      webhookUrl: 'https://example.com',
      webhookSecretHash: 'h',
      clientId: 'cid-mid',
      clientSecretHash: 'csecret',
      ownerId: '507f191e810c19729de860aa',
    });

    installToken = 'install-token';
    await AppInstallation.create({
      appId: owner._id,
      targetType: 'pod',
      targetId: '507f191e810c19729de860ff',
      scopes: ['messages:read'],
      events: ['message.created'],
      tokenHash: hash(installToken),
      createdBy: owner.ownerId,
    });

    app = express();
    app.use(express.json());
    app.get('/protected', appAuth, (req, res) => {
      res.json({ ok: true, install: req.appInstallation._id.toString() });
    });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  test('allows request with valid installation token', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${installToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('rejects missing token', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });

  test('rejects invalid token', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer bad');
    expect(res.status).toBe(401);
  });
});
