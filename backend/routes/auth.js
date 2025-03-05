const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { register, login, getCurrentUser, verifyEmail, updateProfile, getProfile } = require('../controllers/authController');

// @route   POST api/auth/register
// @desc    Register user
// @access  Public
router.post('/register', register);

// @route   POST api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', login);

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

module.exports = router;
