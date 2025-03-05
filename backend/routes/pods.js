const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { 
    getAllPods, 
    getPodsByType, 
    getPodById, 
    createPod, 
    joinPod, 
    leavePod, 
    deletePod 
} = require('../controllers/podController');

// Get all pods or filter by type
router.get('/', auth, getAllPods);

// Get pods by type
router.get('/:type', auth, getPodsByType);

// Get a specific pod
router.get('/:type/:id', auth, getPodById);

// Create a pod
router.post('/', auth, createPod);

// Join a pod
router.post('/:id/join', auth, joinPod);

// Leave a pod
router.post('/:id/leave', auth, leavePod);

// Delete a pod (only creator can delete)
router.delete('/:id', auth, deletePod);

module.exports = router; 