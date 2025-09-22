const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const {
  getCurrentProfile,
  updateProfile,
  getUserById,
} = require('../controllers/userController');

// @route   GET api/users/profile
// @desc    Get current user profile
// @access  Private
router.get('/profile', auth, getCurrentProfile);

// @route   PUT api/users/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', auth, updateProfile);

// @route   GET api/users/:id
// @desc    Get user by ID
// @access  Private
router.get('/:id', auth, getUserById);

module.exports = router;
