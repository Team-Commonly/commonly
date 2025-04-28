const express = require('express');

const router = express.Router();
const auth = require('../middleware/auth');
const {
  getAllPods,
  getPodById,
  createPod,
  updatePod,
  deletePod,
  joinPod,
  leavePod,
} = require('../controllers/pgPodController');

// Get all pods or filter by type
router.get('/', auth, getAllPods);

// Get a specific pod
router.get('/:id', auth, getPodById);

// Create a new pod
router.post('/', auth, createPod);

// Update a pod
router.put('/:id', auth, updatePod);

// Delete a pod
router.delete('/:id', auth, deletePod);

// Join a pod
router.post('/:id/join', auth, joinPod);

// Leave a pod
router.post('/:id/leave', auth, leavePod);

module.exports = router;
