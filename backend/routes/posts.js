const express = require('express');
const { createPost, getPosts, getPostById, addComment, searchPosts } = require('../controllers/postController');
const { authenticate } = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/', authenticate, createPost);
router.get('/', getPosts);
router.get('/search', searchPosts);
router.get('/:id', getPostById);
router.post('/:id/comments', authenticate, addComment);

module.exports = router;
