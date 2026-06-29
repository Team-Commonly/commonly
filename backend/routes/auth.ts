// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const rateLimit = require('express-rate-limit');
// `ipKeyGenerator` normalises IPv6 addresses into a stable /64 bucket so a
// single client can't dodge the limiter by rotating low-order v6 bits. Same
// helper the uploads mint limiter uses (routes/uploads.ts).
const { ipKeyGenerator } = rateLimit;
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
} = require('../controllers/authController');

interface AuthReq {
  user?: { id: string };
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

// Abuse rate-limiters for the unauthenticated public auth surface — added as a
// pre-flight gate before open registration. IP-keyed (NAT'd users share a
// bucket; acceptable for these low ceilings) and applied as the FIRST
// middleware on each route so CodeQL's `js/missing-rate-limiting` query
// recognises the guard. Skipped under NODE_ENV=test so the suites that hammer
// these endpoints in tight loops don't get throttled. Mirrors the
// install/uploads limiter shape (skip + ipKeyGenerator key + 429 handler).
const ipKey = (req: { ip?: string }) => (req.ip ? ipKeyGenerator(req.ip) : 'anon');
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
  keyGenerator: ipKey,
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
  keyGenerator: ipKey,
  handler: rateLimitHandler('rate limit exceeded: 20 login attempts per 15 minutes'),
});

// Waitlist is a one-shot action per person — 5/hour/IP.
const waitlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: ipKey,
  handler: rateLimitHandler('rate limit exceeded: 5 waitlist requests per hour'),
});

const router: ReturnType<typeof express.Router> = express.Router();

router.post('/register', registerLimiter, register);
router.get('/registration-policy', getRegistrationPolicy);
router.post('/waitlist', waitlistLimiter, requestWaitlist);
router.post('/login', loginLimiter, login);
router.post('/refresh', auth, refresh);
router.get('/user', auth, getCurrentUser);
router.get('/verify-email', verifyEmail);
router.get('/profile', auth, getProfile);
router.put('/profile', auth, updateProfile);

router.get('/admin/check', auth, adminAuth, (_req: unknown, res: Res) => {
  res.json({ isAdmin: true, message: 'Admin access confirmed' });
});

router.post('/api-token/generate', auth, async (req: AuthReq, res: Res) => {
  try {
    // eslint-disable-next-line global-require
    const User = require('../models/User');
    const user = await User.findById(req.user?.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const token = user.generateApiToken();
    await user.save();
    return res.json({ apiToken: token, createdAt: user.apiTokenCreatedAt, message: 'API token generated successfully' });
  } catch (error) {
    console.error('Error generating API token:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/api-token', auth, async (req: AuthReq, res: Res) => {
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
