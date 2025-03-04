const express = require('express');
const { createPost, getPosts, getPostById, addComment, searchPosts, likePost, deletePost, deleteComment } = require('../controllers/postController');
const { authenticate } = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/', authenticate, createPost);
router.get('/', getPosts);
router.get('/search', searchPosts);
router.get('/:id', getPostById);
router.post('/:id/comments', authenticate, addComment);
router.post('/:id/like', authenticate, likePost);
router.delete('/:id', authenticate, deletePost);
router.delete('/:id/comments/:commentId', authenticate, deleteComment);

module.exports = router;
