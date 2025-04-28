const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const { checkStatus, syncUser } = require('../controllers/pgStatusController');

// Check if PostgreSQL is available for chat functionality
router.get('/', checkStatus);

// Sync a user from MongoDB to PostgreSQL for chat functionality
router.post('/sync-user', auth, syncUser);

module.exports = router;
