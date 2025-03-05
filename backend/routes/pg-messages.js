const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { 
    getMessages, 
    createMessage, 
    updateMessage, 
    deleteMessage 
} = require('../controllers/pgMessageController');

// Get messages for a specific pod
router.get('/:podId', auth, getMessages);

// Create a new message
router.post('/:podId', auth, createMessage);

// Update a message
router.put('/:id', auth, updateMessage);

// Delete a message
router.delete('/:id', auth, deleteMessage);

module.exports = router; 