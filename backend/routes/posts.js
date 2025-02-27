const express = require('express');
const { createPost, getPosts, getPostById } = require('../controllers/postController');
const { authenticate } = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/', authenticate, createPost);
router.get('/', getPosts);
router.get('/:id', getPostById); // New route to get a single post by ID

module.exports = router;
