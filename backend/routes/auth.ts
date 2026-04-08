// eslint-disable-next-line global-require
const express = require('express');
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

const router: ReturnType<typeof express.Router> = express.Router();

router.post('/register', register);
router.get('/registration-policy', getRegistrationPolicy);
router.post('/waitlist', requestWaitlist);
router.post('/login', login);
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
