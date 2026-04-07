// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const {
  getAllPods,
  getPodById,
  createPod,
  updatePod,
  deletePod,
  joinPod,
  leavePod,
} = require('../controllers/pgPodController');

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/', auth, getAllPods);
router.get('/:id', auth, getPodById);
router.post('/', auth, createPod);
router.put('/:id', auth, updatePod);
router.delete('/:id', auth, deletePod);
router.post('/:id/join', auth, joinPod);
router.post('/:id/leave', auth, leavePod);

module.exports = router;
