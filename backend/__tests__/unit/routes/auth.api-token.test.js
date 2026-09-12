const express = require('express');
const request = require('supertest');

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.authType = 'jwt';
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../controllers/authController', () => ({
  register: jest.fn(),
  login: jest.fn(),
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

const User = require('../../../models/User');
const router = require('../../../routes/auth');

const app = express();
app.use(express.json());
app.use('/api/auth', router);

describe('GET /api/auth/api-token', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns status metadata and never re-serves the raw bearer', async () => {
    const rawToken = 'cm_user_secret_should_not_leave_the_store';
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        apiToken: rawToken,
        apiTokenCreatedAt: new Date('2026-09-04T19:00:00.000Z'),
        apiTokenScopes: ['agent:context:read'],
      }),
    });

    const response = await request(app)
      .get('/api/auth/api-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      hasToken: true,
      createdAt: '2026-09-04T19:00:00.000Z',
      scopes: ['agent:context:read'],
      last4: rawToken.slice(-4),
    });
    expect(response.body.token).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(rawToken);
    expect(User.findById).toHaveBeenCalledWith('user-1');
  });
});
