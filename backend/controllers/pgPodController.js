const PGPod = require('../models/pg/Pod');
const PGMessage = require('../models/pg/Message');

// Get all pods or filter by type
exports.getAllPods = async (req, res) => {
    try {
        const { type } = req.query;
        const pods = await PGPod.findAll(type);
        
        res.json(pods);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get a specific pod
exports.getPodById = async (req, res) => {
    try {
        const pod = await PGPod.findById(req.params.id);
        
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        res.json(pod);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Create a new pod
exports.createPod = async (req, res) => {
    try {
        const { name, description, type } = req.body;
        
        const newPod = await PGPod.create(
            name,
            description,
            type,
            req.user.id
        );
        
        res.json(newPod);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Update a pod
exports.updatePod = async (req, res) => {
    try {
        const { name, description } = req.body;
        
        // Check if pod exists
        const pod = await PGPod.findById(req.params.id);
        
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        // Check if user is the creator of the pod
        if (pod.created_by !== req.user.id) {
            return res.status(401).json({ msg: 'Not authorized to update this pod' });
        }
        
        const updatedPod = await PGPod.update(
            req.params.id,
            name,
            description
        );
        
        res.json(updatedPod);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Delete a pod
exports.deletePod = async (req, res) => {
    try {
        // Check if pod exists
        const pod = await PGPod.findById(req.params.id);
        
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        // Check if user is the creator of the pod
        if (pod.created_by !== req.user.id) {
            return res.status(401).json({ msg: 'Not authorized to delete this pod' });
        }
        
        // Delete all messages in the pod
        await PGMessage.deleteByPodId(req.params.id);
        
        // Delete the pod
        await PGPod.delete(req.params.id);
        
        res.json({ msg: 'Pod deleted' });
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Join a pod
exports.joinPod = async (req, res) => {
    try {
        // Check if pod exists
        const pod = await PGPod.findById(req.params.id);
        
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        // Add user to pod members
        await PGPod.addMember(req.params.id, req.user.id);
        
        // Get updated pod
        const updatedPod = await PGPod.findById(req.params.id);
        
        res.json(updatedPod);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Leave a pod
exports.leavePod = async (req, res) => {
    try {
        // Check if pod exists
        const pod = await PGPod.findById(req.params.id);
        
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        // Check if user is the creator of the pod
        if (pod.created_by === req.user.id) {
            return res.status(400).json({ msg: 'Pod creator cannot leave the pod' });
        }
        
        // Remove user from pod members
        await PGPod.removeMember(req.params.id, req.user.id);
        
        res.json({ msg: 'Left pod successfully' });
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        res.status(500).send('Server Error');
    }
}; 