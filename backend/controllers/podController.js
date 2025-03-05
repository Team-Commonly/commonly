const Pod = require('../models/Pod');
const Message = require('../models/Message');
const User = require('../models/User');

// Get all pods or filter by type
exports.getAllPods = async (req, res) => {
    try {
        const { type } = req.query;
        const query = type ? { type } : {};
        
        const pods = await Pod.find(query)
            .populate('createdBy', 'username profilePicture')
            .populate('members', 'username profilePicture')
            .sort({ updatedAt: -1 });
        
        res.json(pods);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get pods by type
exports.getPodsByType = async (req, res) => {
    try {
        const { type } = req.params;
        
        if (!['chat', 'study', 'games'].includes(type)) {
            return res.status(400).json({ msg: 'Invalid pod type' });
        }
        
        const pods = await Pod.find({ type })
            .populate('createdBy', 'username profilePicture')
            .populate('members', 'username profilePicture')
            .sort({ updatedAt: -1 });
        
        res.json(pods);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Get a specific pod
exports.getPodById = async (req, res) => {
    try {
        const pod = await Pod.findById(req.params.id)
            .populate('createdBy', 'username profilePicture')
            .populate('members', 'username profilePicture');
        
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

// Create a pod
exports.createPod = async (req, res) => {
    try {
        const { name, description, type } = req.body;
        
        if (!name || !type) {
            return res.status(400).json({ msg: 'Name and type are required' });
        }
        
        if (!['chat', 'study', 'games'].includes(type)) {
            return res.status(400).json({ msg: 'Invalid pod type' });
        }
        
        const newPod = new Pod({
            name,
            description,
            type,
            createdBy: req.userId,
            members: [req.userId]
        });
        
        const pod = await newPod.save();
        
        // Populate the user data
        await pod.populate('createdBy', 'username profilePicture');
        await pod.populate('members', 'username profilePicture');
        
        res.json(pod);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Join a pod
exports.joinPod = async (req, res) => {
    try {
        const pod = await Pod.findById(req.params.id);
        
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        // Check if user is already a member
        if (pod.members.includes(req.userId)) {
            return res.status(400).json({ msg: 'Already a member of this pod' });
        }
        
        pod.members.push(req.userId);
        pod.updatedAt = Date.now();
        
        await pod.save();
        
        // Populate the user data
        await pod.populate('createdBy', 'username profilePicture');
        await pod.populate('members', 'username profilePicture');
        
        res.json(pod);
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
        const pod = await Pod.findById(req.params.id);
        
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        // Check if user is a member
        if (!pod.members.includes(req.userId)) {
            return res.status(400).json({ msg: 'Not a member of this pod' });
        }
        
        // Remove user from members
        pod.members = pod.members.filter(member => member.toString() !== req.userId);
        pod.updatedAt = Date.now();
        
        await pod.save();
        
        // Populate the user data
        await pod.populate('createdBy', 'username profilePicture');
        await pod.populate('members', 'username profilePicture');
        
        res.json(pod);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Delete a pod (only creator can delete)
exports.deletePod = async (req, res) => {
    try {
        const pod = await Pod.findById(req.params.id);
        
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        // Check if user is the creator
        if (pod.createdBy.toString() !== req.userId) {
            return res.status(401).json({ msg: 'Not authorized to delete this pod' });
        }
        
        // Delete all messages in the pod
        await Message.deleteMany({ podId: req.params.id });
        
        // Delete the pod
        await Pod.deleteOne({ _id: req.params.id });
        
        res.json({ msg: 'Pod deleted' });
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        res.status(500).send('Server Error');
    }
}; 