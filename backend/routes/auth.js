const express = require('express');
const { register, login, verifyEmail, getProfile, getCurrentUser, updateProfile } = require('../controllers/authController');
const { authenticate } = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/verify-email', verifyEmail);
router.get('/profile', authenticate, getProfile);
router.get('/me', authenticate, getCurrentUser);
router.put('/profile', authenticate, updateProfile);

module.exports = router;
