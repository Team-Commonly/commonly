// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const rateLimit = require('express-rate-limit');
const { cloudflareIpRateLimitKeyGenerator } = require('../middleware/ipRateLimit');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const adminAuth = require('../middleware/adminAuth');
// eslint-disable-next-line global-require
const {
  register,
  login,
  refresh,
  getCurrentUser,
  verifyEmail,
  updateProfile,
  getProfile,
  getRegistrationPolicy,
  requestWaitlist,
  redeemInvitation,
  forgotPassword,
  resendVerification,
  resetPassword,
} = require('../controllers/authController');
// eslint-disable-next-line global-require
const {
  DEVICE_AUTHORIZATION_TTL_MS,
  DEVICE_POLL_INTERVAL_SECONDS,
  createDeviceAuthorization,
  pollDeviceAuthorization,
  decideDeviceAuthorization,
  listDeviceTokens,
  revokeDeviceToken,
} = require('../services/deviceAuthorizationService');
// eslint-disable-next-line global-require
const {
  getOAuthProviders,
  startOAuth,
  oauthCallback,
  exchangeOAuthCode,
} = require('../controllers/oauthController');

interface AuthReq {
  user?: { id: string };
  userId?: string;
  authType?: 'jwt' | 'apiToken' | 'deviceToken';
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

// Device bearers authenticate ordinary user API calls, but they must not gain
// control of the account's credential set. In particular, `/refresh` mints a
// browser JWT; allowing a device token through it would let a stolen device
// turn itself into a browser session and then create or revoke other devices.
// Device login deliberately has an expiry contract rather than a refresh path.
function requireBrowserJwt(req: AuthReq, res: Res): boolean {
  if (req.authType === 'jwt') return true;
  res.status(403).json({ error: 'This action requires a signed-in browser session' });
  return false;
}

// Abuse rate-limiters for the unauthenticated public auth surface — added as a
// pre-flight gate before open registration. Cloudflare sets
// `CF-Connecting-IP` at the edge, so this avoids trusting a client-supplied
// `X-Forwarded-For` once `app.set('trust proxy', true)` is enabled. Skipped
// under NODE_ENV=test so the suites that hammer these endpoints in tight loops
// don't get throttled.
const rateLimitHandler = (message: string) => (_req: unknown, res: Res) =>
  res.status(429).json({ message, code: 'rate_limited' });

// Account creation is rare — 10/hour/IP blocks signup-spam while leaving room
// for shared-IP households and the odd retry.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: rateLimitHandler('rate limit exceeded: 10 registrations per hour'),
});

// Credential-stuffing protection — 20/15min/IP is loose enough that a legit
// user fat-fingering their password a few times isn't locked out.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: rateLimitHandler('rate limit exceeded: 20 login attempts per 15 minutes'),
});

// Device start mints a server-side authorization request; poll needs room for
// the documented 5s cadence over a ten-minute lifetime. These are separate
// buckets so an interrupted CLI cannot starve a fresh login attempt.
const deviceStartLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: rateLimitHandler('rate limit exceeded: 20 device authorization starts per hour'),
});

const devicePollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: rateLimitHandler('rate limit exceeded: too many device authorization polls'),
});

// The browser approval and device-management endpoints all authenticate, but
// authentication itself reads User (and approval writes both collections).
// Keep their bound separate from the public start/poll buckets: a terminal
// polling normally must never consume the browser approval budget.
const deviceManageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: rateLimitHandler('rate limit exceeded: too many device authorization requests'),
});

// Waitlist is a one-shot action per person — 5/hour/IP.
const waitlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: rateLimitHandler('rate limit exceeded: 5 waitlist requests per hour'),
});

// Forgot-password sends outbound mail on every plausible hit — keep it as
// tight as the waitlist (its own bucket so the two don't starve each other).
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: rateLimitHandler('rate limit exceeded: 5 password-reset requests per hour'),
});

// Like password reset, a resend can amplify outbound mail. It has a separate
// bucket so asking for a verification link never starves password recovery.
const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: rateLimitHandler('rate limit exceeded: 5 verification emails per hour'),
});

// Social login shares the credential-stuffing posture of /login: each attempt
// is one provider round-trip, so 30/15min/IP leaves room for retries without
// letting a bot farm state rows.
const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: rateLimitHandler('rate limit exceeded: 30 OAuth attempts per 15 minutes'),
});

const router: ReturnType<typeof express.Router> = express.Router();

router.post('/register', registerLimiter, register);
router.get('/oauth/providers', getOAuthProviders);
router.get('/oauth/:provider/start', oauthLimiter, startOAuth);
router.get('/oauth/:provider/callback', oauthLimiter, oauthCallback);
router.post('/oauth/exchange', oauthLimiter, exchangeOAuthCode);
router.get('/registration-policy', getRegistrationPolicy);
router.post('/waitlist', waitlistLimiter, requestWaitlist);
router.post('/login', loginLimiter, login);
router.post('/device/start', deviceStartLimiter, async (req: any, res: Res) => {
  try {
    const { deviceCode, userCode } = await createDeviceAuthorization(req.body || {});
    const origin = String(process.env.FRONTEND_URL || 'https://commonly.me').replace(/\/$/, '');
    return res.status(201).json({
      deviceCode,
      userCode,
      verifyUrl: `${origin}/cli/authorize`,
      expiresIn: Math.floor(DEVICE_AUTHORIZATION_TTL_MS / 1000),
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    });
  } catch (error: any) {
    if (error?.message === 'clientName and hostname are required') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Unable to start device authorization:', error?.message);
    return res.status(500).json({ error: 'Unable to start device authorization' });
  }
});

router.post('/device/poll', devicePollLimiter, async (req: any, res: Res) => {
  try {
    const result = await pollDeviceAuthorization(req.body?.deviceCode);
    return res.json(result);
  } catch (error: any) {
    console.error('Unable to poll device authorization:', error?.message);
    return res.status(500).json({ error: 'Unable to poll device authorization' });
  }
});

router.post('/device/authorize', deviceManageLimiter, auth, async (req: AuthReq & { body?: any }, res: Res) => {
  // Only an interactive browser session can grant another device bearer.
  // A device token is intentionally sufficient for ordinary user routes, but
  // accepting it here would let a revoked device pre-mint a successor.
  if (!requireBrowserJwt(req, res)) return;
  try {
    const result = await decideDeviceAuthorization({
      userCode: req.body?.userCode,
      decision: req.body?.decision,
      userId: req.userId || req.user?.id || '',
    });
    if (result.status === 'invalid_decision') return res.status(400).json(result);
    if (result.status === 'expired') return res.status(410).json(result);
    return res.json(result);
  } catch (error: any) {
    console.error('Unable to decide device authorization:', error?.message);
    return res.status(500).json({ error: 'Unable to decide device authorization' });
  }
});

router.get('/devices', deviceManageLimiter, auth, async (req: AuthReq, res: Res) => {
  if (!requireBrowserJwt(req, res)) return;
  try {
    return res.json({ devices: await listDeviceTokens(req.userId || req.user?.id || '') });
  } catch (error: any) {
    console.error('Unable to list device tokens:', error?.message);
    return res.status(500).json({ error: 'Unable to list device tokens' });
  }
});

router.delete('/devices/:deviceId', deviceManageLimiter, auth, async (req: AuthReq & { params?: any }, res: Res) => {
  if (!requireBrowserJwt(req, res)) return;
  try {
    const revoked = await revokeDeviceToken(req.userId || req.user?.id || '', String(req.params?.deviceId || ''));
    if (!revoked) return res.status(404).json({ error: 'Device not found or already revoked' });
    return res.json({ message: 'Device revoked' });
  } catch (error: any) {
    console.error('Unable to revoke device token:', error?.message);
    return res.status(500).json({ error: 'Unable to revoke device token' });
  }
});
// Invitation redemption is authed and rare — the login limiter's
// credential-stuffing posture (20/15min/IP) also bounds code-guessing here.
router.post('/redeem-invitation', loginLimiter, auth, redeemInvitation);
// Password reset: forgot is deliberately tight (5/hour/IP — it sends email
// and always 200s, so it's an outbound-mail amplifier); reset consumes a
// signed token so the login limiter's posture suffices.
router.post('/forgot-password', forgotLimiter, forgotPassword);
router.post('/resend-verification', resendVerificationLimiter, resendVerification);
router.post('/reset-password', loginLimiter, resetPassword);
router.post('/refresh', auth, (req: AuthReq, res: Res) => {
  if (!requireBrowserJwt(req, res)) return;
  return refresh(req, res);
});
router.get('/user', auth, getCurrentUser);
router.get('/verify-email', verifyEmail);
router.get('/profile', auth, getProfile);
router.put('/profile', auth, updateProfile);

router.get('/admin/check', auth, adminAuth, (_req: unknown, res: Res) => {
  res.json({ isAdmin: true, message: 'Admin access confirmed' });
});

router.post('/api-token/generate', auth, async (req: AuthReq, res: Res) => {
  if (!requireBrowserJwt(req, res)) return;
  try {
    // eslint-disable-next-line global-require
    const User = require('../models/User');
    const user = await User.findById(req.user?.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const token = user.generateApiToken();
    await user.save();
    return res.json({
      apiToken: token,
      createdAt: user.apiTokenCreatedAt,
      message: 'API token generated successfully',
    });
  } catch (error) {
    console.error('Error generating API token:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/api-token', auth, async (req: AuthReq, res: Res) => {
  if (!requireBrowserJwt(req, res)) return;
  try {
    // eslint-disable-next-line global-require
    const User = require('../models/User');
    const user = await User.findById(req.user?.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.revokeApiToken();
    await user.save();
    return res.json({ message: 'API token revoked successfully' });
  } catch (error) {
    console.error('Error revoking API token:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/api-token', auth, async (req: AuthReq, res: Res) => {
  if (!requireBrowserJwt(req, res)) return;
  try {
    // eslint-disable-next-line global-require
    const User = require('../models/User');
    const user = await User.findById(req.user?.id).select('apiToken apiTokenCreatedAt');
    if (!user) return res.status(404).json({ message: 'User not found' });

    return res.json({ hasToken: !!user.apiToken, createdAt: user.apiTokenCreatedAt, token: user.apiToken });
  } catch (error) {
    console.error('Error fetching API token:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

export {};
