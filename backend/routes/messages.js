const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getMessages, createMessage, deleteMessage } = require('../controllers/messageController');

// Get messages for a specific pod
router.get('/:podId', auth, getMessages);

// Create a message in a pod
router.post('/:podId', auth, createMessage);

// Delete a message
router.delete('/:id', auth, deleteMessage);

module.exports = router; 