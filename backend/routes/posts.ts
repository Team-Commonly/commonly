// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const {
  createPost,
  getPosts,
  getPostById,
  addComment,
  searchPosts,
  likePost,
  deletePost,
  deleteComment,
  followThread,
  unfollowThread,
  getFollowedThreads,
  toggleAgentComments,
} = require('../controllers/postController');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');

const router: ReturnType<typeof express.Router> = express.Router();

router.post('/', auth, createPost);
// Posts read paths require auth so pod-scoped queries can resolve the
// caller's identity for the canViewPod gate in getPosts / getPostById.
// Landing / marketing pages don't fetch posts, so this is a safe upgrade.
router.get('/', auth, getPosts);
router.get('/search', auth, searchPosts);
router.get('/following/threads', auth, getFollowedThreads);
router.get('/:id', auth, getPostById);
router.post('/:id/comments', auth, addComment);
router.post('/:id/follow', auth, followThread);
router.delete('/:id/follow', auth, unfollowThread);
router.post('/:id/like', auth, likePost);
router.delete('/:id', auth, deletePost);
router.delete('/:id/comments/:commentId', auth, deleteComment);
router.patch('/:id/agent-comments', auth, toggleAgentComments);

module.exports = router;

export {};
