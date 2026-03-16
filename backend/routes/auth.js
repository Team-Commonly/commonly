const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
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

// @route   POST api/auth/register
// @desc    Register user
// @access  Public
router.post('/register', register);

// @route   GET api/auth/registration-policy
// @desc    Public registration policy (invite-only/open)
// @access  Public
router.get('/registration-policy', getRegistrationPolicy);

// @route   POST api/auth/waitlist
// @desc    Submit waitlist request for invite-only registration
// @access  Public
router.post('/waitlist', requestWaitlist);

// @route   POST api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', login);

// @route   POST api/auth/refresh
// @desc    Silently refresh a valid token (returns new 1h token)
// @access  Private
router.post('/refresh', auth, refresh);

// @route   GET api/auth/user
// @desc    Get user data
// @access  Private
router.get('/user', auth, getCurrentUser);

// @route   GET api/auth/verify-email
// @desc    Verify user email
// @access  Public
router.get('/verify-email', verifyEmail);

// @route   GET api/auth/profile
// @desc    Get user profile
// @access  Private
router.get('/profile', auth, getProfile);

// @route   PUT api/auth/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', auth, updateProfile);

// @route   GET api/auth/admin/check
// @desc    Check if user is admin
// @access  Private (Admin only)
router.get('/admin/check', auth, adminAuth, (req, res) => {
  res.json({ isAdmin: true, message: 'Admin access confirmed' });
});

// @route   POST api/auth/api-token/generate
// @desc    Generate API token for user
// @access  Private
router.post('/api-token/generate', auth, async (req, res) => {
  try {
    // eslint-disable-next-line global-require
    const User = require('../models/User');
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const token = user.generateApiToken();
    await user.save();

    res.json({
      apiToken: token,
      createdAt: user.apiTokenCreatedAt,
      message: 'API token generated successfully',
    });
  } catch (error) {
    console.error('Error generating API token:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE api/auth/api-token
// @desc    Revoke API token for user
// @access  Private
router.delete('/api-token', auth, async (req, res) => {
  try {
    // eslint-disable-next-line global-require
    const User = require('../models/User');
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.revokeApiToken();
    await user.save();

    res.json({ message: 'API token revoked successfully' });
  } catch (error) {
    console.error('Error revoking API token:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET api/auth/api-token
// @desc    Get current API token info
// @access  Private
router.get('/api-token', auth, async (req, res) => {
  try {
    // eslint-disable-next-line global-require
    const User = require('../models/User');
    const user = await User.findById(req.user.id).select(
      'apiToken apiTokenCreatedAt',
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      hasToken: !!user.apiToken,
      createdAt: user.apiTokenCreatedAt,
      token: user.apiToken, // Only return if user has one
    });
  } catch (error) {
    console.error('Error fetching API token:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
