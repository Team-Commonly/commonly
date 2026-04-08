// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const {
  getCurrentProfile,
  updateProfile,
  getUserById,
  getUserPublicActivity,
  followUser,
  unfollowUser,
} = require('../controllers/userController');

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/profile', auth, getCurrentProfile);
router.put('/profile', auth, updateProfile);
router.get('/:id/public-activity', auth, getUserPublicActivity);
router.get('/:id', auth, getUserById);
router.post('/:id/follow', auth, followUser);
router.delete('/:id/follow', auth, unfollowUser);

module.exports = router;

export {};
