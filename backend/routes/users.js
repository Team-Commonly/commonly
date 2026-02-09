const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const {
  getCurrentProfile,
  updateProfile,
  getUserById,
  getUserPublicActivity,
  followUser,
  unfollowUser,
} = require('../controllers/userController');

// @route   GET api/users/profile
// @desc    Get current user profile
// @access  Private
router.get('/profile', auth, getCurrentProfile);

// @route   PUT api/users/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', auth, updateProfile);

// @route   GET api/users/:id/public-activity
// @desc    Get user public activity summary (recent public posts + joined pods)
// @access  Private
router.get('/:id/public-activity', auth, getUserPublicActivity);

// @route   GET api/users/:id
// @desc    Get user by ID
// @access  Private
router.get('/:id', auth, getUserById);

// @route   POST api/users/:id/follow
// @desc    Follow user by ID
// @access  Private
router.post('/:id/follow', auth, followUser);

// @route   DELETE api/users/:id/follow
// @desc    Unfollow user by ID
// @access  Private
router.delete('/:id/follow', auth, unfollowUser);

module.exports = router;
