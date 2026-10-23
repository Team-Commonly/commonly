const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const authRoutes = require('../../routes/auth');
const adminRoutes = require('../../routes/admin/users');
const { socketAuthMiddleware } = require('../../middleware/socketAuth');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

describe('human session revocation and absolute lifetime', () => {
  let app;
  let user;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'session-token-service-test';
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api/admin/users', adminRoutes);
  });
  afterAll(closeMongoDb);
  afterEach(async () => {
    await clearMongoDb();
    delete process.env.SESSION_ABSOLUTE_LIFETIME_DAYS;
  });
  beforeEach(async () => {
    user = await User.create({ username: 'session-user', email: 'session@example.com', password: 'Password123!', verified: true });
  });

  const getUser = (token) => request(app).get('/api/auth/user').set('Authorization', `Bearer ${token}`);
  const login = () => request(app).post('/api/auth/login').send({ email: 'session@example.com', password: 'Password123!' });

  it('accepts a pre-change token at version zero, then refuses it on the next request after sign out everywhere', async () => {
    const legacy = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '7d' });
    await getUser(legacy).expect(200);
    await request(app).post('/api/auth/sessions/revoke').set('Authorization', `Bearer ${legacy}`).expect(200);
    await getUser(legacy).expect(401);
    await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${legacy}`).expect(401);
    const socketNext = jest.fn();
    await socketAuthMiddleware({ handshake: { auth: { token: legacy } } }, socketNext);
    expect(socketNext).toHaveBeenCalledWith(expect.any(Error));
    expect((await User.findById(user._id)).tokenVersion).toBe(1);
    const signedInAgain = await login().expect(200);
    expect(jwt.decode(signedInAgain.body.token).tokenVersion).toBe(1);
    await getUser(signedInAgain.body.token).expect(200);
  });

  it('keeps the original sign-in time and refuses refresh after the absolute lifetime', async () => {
    const first = await login().expect(200);
    const firstClaims = jwt.decode(first.body.token);
    const refreshed = await request(app).post('/api/auth/refresh')
      .set('Authorization', `Bearer ${first.body.token}`).expect(200);
    expect(jwt.decode(refreshed.body.token).sessionStartedAt).toBe(firstClaims.sessionStartedAt);

    const pastStart = Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60;
    const oldButUnexpired = jwt.sign({ id: String(user._id), tokenVersion: 0, sessionStartedAt: pastStart },
      process.env.JWT_SECRET, { expiresIn: '7d' });
    await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${oldButUnexpired}`).expect(401);

    const nearDeadline = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60 + 30;
    const nearDeadlineToken = jwt.sign({ id: String(user._id), tokenVersion: 0, sessionStartedAt: nearDeadline },
      process.env.JWT_SECRET, { expiresIn: '7d' });
    const finalRefresh = await request(app).post('/api/auth/refresh')
      .set('Authorization', `Bearer ${nearDeadlineToken}`).expect(200);
    expect(jwt.decode(finalRefresh.body.token).exp).toBeLessThanOrEqual(nearDeadline + 30 * 24 * 60 * 60);
  });

  it('revokes on password change and admin revoke without banning the account', async () => {
    const original = (await login().expect(200)).body.token;
    const resetToken = jwt.sign({ id: String(user._id), purpose: 'password-reset' },
      `${process.env.JWT_SECRET}:${user.password}`, { expiresIn: '1h' });
    await request(app).post('/api/auth/reset-password')
      .send({ token: resetToken, password: 'A-new-password-123!' }).expect(200);
    await getUser(original).expect(401);

    const replacement = (await request(app).post('/api/auth/login')
      .send({ email: 'session@example.com', password: 'A-new-password-123!' }).expect(200)).body.token;
    const admin = await User.create({ username: 'session-admin', email: 'admin@example.com', password: 'Password123!', role: 'admin' });
    const adminToken = jwt.sign({ id: String(admin._id) }, process.env.JWT_SECRET);
    await request(app).post(`/api/admin/users/${user._id}/sessions/revoke`)
      .set('Authorization', `Bearer ${replacement}`).expect(403);
    await request(app).post(`/api/admin/users/${user._id}/sessions/revoke`)
      .set('Authorization', `Bearer ${adminToken}`).expect(200);
    await getUser(replacement).expect(401);
    expect((await User.findById(user._id)).banned).toBe(false);
  });
});
