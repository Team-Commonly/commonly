const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const authRoutes = require('../../routes/auth');
const adminRoutes = require('../../routes/admin/users');
const authMiddleware = require('../../middleware/auth');
const { refresh } = require('../../controllers/authController');
const { socketAuthMiddleware, installSocketSessionGuard } = require('../../middleware/socketAuth');
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
    jest.restoreAllMocks();
    await clearMongoDb();
    delete process.env.SESSION_ABSOLUTE_LIFETIME_DAYS;
  });
  beforeEach(async () => {
    user = await User.create({ username: 'session-user', email: 'session@example.com', password: 'Password123!', verified: true });
  });

  const getUser = (token) => request(app).get('/api/auth/user').set('Authorization', `Bearer ${token}`);
  const login = () => request(app).post('/api/auth/login').send({ email: 'session@example.com', password: 'Password123!' });

  it('accepts a pre-change token at version zero, then refuses it on the next request after sign out everywhere', async () => {
    const disconnectSockets = jest.fn();
    const room = jest.fn(() => ({ disconnectSockets }));
    jest.spyOn(require('../../config/socket'), 'getIO').mockReturnValue({ in: room });
    const legacy = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '7d' });
    await getUser(legacy).expect(200);
    const connectedSocket = { handshake: { auth: { token: legacy } }, use: jest.fn(), disconnect: jest.fn() };
    const socketAccepted = jest.fn();
    await socketAuthMiddleware(connectedSocket, socketAccepted);
    expect(socketAccepted).toHaveBeenCalledWith();
    installSocketSessionGuard(connectedSocket);
    await request(app).post('/api/auth/sessions/revoke').set('Authorization', `Bearer ${legacy}`).expect(200);
    expect(room).toHaveBeenCalledWith(`session_user_${user._id}`);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    await getUser(legacy).expect(401);
    await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${legacy}`).expect(401);
    const socketNext = jest.fn();
    await socketAuthMiddleware({ handshake: { auth: { token: legacy } } }, socketNext);
    expect(socketNext).toHaveBeenCalledWith(expect.any(Error));
    const packetNext = jest.fn();
    await new Promise((resolve) => connectedSocket.use.mock.calls[0][0](['sendMessage'], (error) => {
      packetNext(error);
      resolve();
    }));
    expect(packetNext).toHaveBeenCalledWith(expect.any(Error));
    expect(connectedSocket.disconnect).toHaveBeenCalledWith(true);
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

  it('cannot mint the new version when revocation lands after middleware authentication', async () => {
    const versionZero = (await login().expect(200)).body.token;
    const req = { header: (name) => (name === 'Authorization' ? `Bearer ${versionZero}` : undefined) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledWith();
    await User.updateOne({ _id: req.userId }, { $inc: { tokenVersion: 1 } });
    await refresh(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Session has been revoked' });
    await getUser(versionZero).expect(401);
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
