const express = require('express');
const { createPost, getPosts } = require('../controllers/postController');
const { authenticate } = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/', authenticate, createPost);
router.get('/', getPosts);

module.exports = router;
