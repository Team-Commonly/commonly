const express = require('express');
const { createPost, getPosts, getPostById, addComment, searchPosts, likePost, deletePost, deleteComment } = require('../controllers/postController');
const { authenticate } = require('../middleware/authMiddleware');
const router = express.Router();
const auth = require('../middleware/auth');
const Post = require('../models/Post');
const User = require('../models/User');

// @route   POST api/posts
// @desc    Create a post
// @access  Private
router.post('/', auth, createPost);

// @route   GET api/posts
// @desc    Get all posts
// @access  Public
router.get('/', getPosts);

// @route   GET api/posts/search
// @desc    Search posts
// @access  Public
router.get('/search', searchPosts);

// @route   GET api/posts/:id
// @desc    Get post by ID
// @access  Public
router.get('/:id', getPostById);

// @route   POST api/posts/:id/comments
// @desc    Add comment to post
// @access  Private
router.post('/:id/comments', auth, addComment);

// @route   POST api/posts/:id/like
// @desc    Like a post
// @access  Private
router.post('/:id/like', auth, likePost);

// @route   DELETE api/posts/:id
// @desc    Delete a post
// @access  Private
router.delete('/:id', auth, deletePost);

// @route   DELETE api/posts/:id/comments/:commentId
// @desc    Delete comment from post
// @access  Private
router.delete('/:id/comments/:commentId', auth, deleteComment);

module.exports = router;
