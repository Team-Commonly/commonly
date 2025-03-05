const PGPod = require('../models/pg/Pod');
const PGMessage = require('../models/pg/Message');

// Get messages for a specific pod
exports.getMessages = async (req, res) => {
    try {
        const { podId } = req.params;
        const { limit = 50, before } = req.query;
        
        // Check if pod exists
        const pod = await PGPod.findById(podId);
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        // Check if user is a member of the pod
        const isMember = await PGPod.isMember(podId, req.user.id);
        if (!isMember) {
            return res.status(401).json({ msg: 'Not authorized to view messages in this pod' });
        }
        
        const messages = await PGMessage.findByPodId(podId, limit, before);
        
        res.json(messages);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Create a new message
exports.createMessage = async (req, res) => {
    try {
        const { podId } = req.params;
        const { content } = req.body;
        
        // Check if pod exists
        const pod = await PGPod.findById(podId);
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        // Check if user is a member of the pod
        const isMember = await PGPod.isMember(podId, req.user.id);
        if (!isMember) {
            return res.status(401).json({ msg: 'Not authorized to post in this pod' });
        }
        
        const newMessage = await PGMessage.create(
            podId,
            req.user.id,
            content
        );
        
        // Get the message with user details
        const message = await PGMessage.findById(newMessage.id);
        
        res.json(message);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Update a message
exports.updateMessage = async (req, res) => {
    try {
        const { content } = req.body;
        
        // Check if message exists
        const message = await PGMessage.findById(req.params.id);
        
        if (!message) {
            return res.status(404).json({ msg: 'Message not found' });
        }
        
        // Check if user is the creator of the message
        if (message.user_id !== req.user.id) {
            return res.status(401).json({ msg: 'Not authorized to update this message' });
        }
        
        const updatedMessage = await PGMessage.update(
            req.params.id,
            content
        );
        
        res.json(updatedMessage);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Message not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Delete a message
exports.deleteMessage = async (req, res) => {
    try {
        const message = await PGMessage.findById(req.params.id);
        
        if (!message) {
            return res.status(404).json({ msg: 'Message not found' });
        }
        
        // Check if user is the creator of the message
        if (message.user_id !== req.user.id) {
            // Check if user is the creator of the pod
            const pod = await PGPod.findById(message.pod_id);
            if (!pod || pod.created_by !== req.user.id) {
                return res.status(401).json({ msg: 'Not authorized to delete this message' });
            }
        }
        
        await PGMessage.delete(req.params.id);
        
        res.json({ msg: 'Message deleted' });
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Message not found' });
        }
        res.status(500).send('Server Error');
    }
}; 