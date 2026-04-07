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
router.get('/', getPosts);
router.get('/search', searchPosts);
router.get('/following/threads', auth, getFollowedThreads);
router.get('/:id', getPostById);
router.post('/:id/comments', auth, addComment);
router.post('/:id/follow', auth, followThread);
router.delete('/:id/follow', auth, unfollowThread);
router.post('/:id/like', auth, likePost);
router.delete('/:id', auth, deletePost);
router.delete('/:id/comments/:commentId', auth, deleteComment);
router.patch('/:id/agent-comments', auth, toggleAgentComments);

module.exports = router;
