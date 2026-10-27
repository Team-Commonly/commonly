const express = require('express');
const request = require('supertest');

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../controllers/authController', () => ({
  register: jest.fn(),
  // A stand-in for the real controller: only the password 'right' signs in.
  login: jest.fn((req, res) => (req.body.password === 'right'
    ? res.json({ token: 't' })
    : res.status(400).json({ error: 'Invalid credentials' }))),
  refresh: jest.fn(),
  getCurrentUser: jest.fn(),
  verifyEmail: jest.fn(),
  updateProfile: jest.fn(),
  getProfile: jest.fn(),
  getRegistrationPolicy: jest.fn(),
  requestWaitlist: jest.fn(),
  redeemInvitation: jest.fn(),
  forgotPassword: jest.fn(),
  resendVerification: jest.fn(),
  resetPassword: jest.fn(),
}));
jest.mock('../../../controllers/oauthController', () => ({
  getOAuthProviders: jest.fn(),
  startOAuth: jest.fn(),
  oauthCallback: jest.fn(),
  exchangeOAuthCode: jest.fn(),
}));
jest.mock('../../../services/deviceAuthorizationService', () => ({
  DEVICE_AUTHORIZATION_TTL_MS: 600000,
  DEVICE_POLL_INTERVAL_SECONDS: 5,
  createDeviceAuthorization: jest.fn(),
  pollDeviceAuthorization: jest.fn(),
  decideDeviceAuthorization: jest.fn(),
  listDeviceTokens: jest.fn(),
  revokeDeviceToken: jest.fn(),
}));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));

const { login } = require('../../../controllers/authController');
const router = require('../../../routes/auth');

const app = express();
app.use(express.json());
app.use('/api/auth', router);

// Failed sign-ins are counted per submitted address as well as per IP. Every
// request here comes from a fresh IP, so only the per-address budget can
// refuse one. The limiters stand down under NODE_ENV=test, so these cases run
// with it unset.
describe('POST /api/auth/login per-address budget', () => {
  const nodeEnv = process.env.NODE_ENV;
  let ip = 0;
  const signIn = (email, password = 'wrong') => {
    ip += 1;
    return request(app)
      .post('/api/auth/login')
      .set('cf-connecting-ip', `198.51.${Math.floor(ip / 250)}.${ip % 250}`)
      .send({ email, password });
  };
  const failures = async (email, n) => {
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await signIn(email)).status).toBe(400);
    }
  };

  beforeAll(() => { process.env.NODE_ENV = 'production'; });
  afterAll(() => { process.env.NODE_ENV = nodeEnv; });
  beforeEach(() => { login.mockClear(); });

  it('refuses the 11th failed sign-in for one address in 15 minutes, across IPs', async () => {
    await failures('victim-1@example.com', 10);
    const res = await signIn('victim-1@example.com');

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(login).toHaveBeenCalledTimes(10);
  });

  it('counts an address by its normalised form, and no other address with it', async () => {
    await failures('Victim-2@Example.com ', 10);

    expect((await signIn('victim-2@example.com')).status).toBe(429);
    expect((await signIn('someone-else@example.com')).status).toBe(400);
  });

  it('does not count successful sign-ins', async () => {
    await failures('victim-3@example.com', 9);
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await signIn('victim-3@example.com', 'right')).status).toBe(200);
    }
    await failures('victim-3@example.com', 1);

    expect((await signIn('victim-3@example.com')).status).toBe(429);
  });

  it('leaves a request with no string address to the IP limit and the controller', async () => {
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await signIn({ $ne: null })).status).toBe(400);
    }
    expect(login).toHaveBeenCalledTimes(12);
  });
});
