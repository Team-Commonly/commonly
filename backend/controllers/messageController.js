const Pod = require('../models/Pod');
const Message = require('../models/Message');

// Get messages for a specific pod
exports.getMessages = async (req, res) => {
    try {
        const { podId } = req.params;
        const { limit = 50, before } = req.query;
        
        // Check if pod exists
        const pod = await Pod.findById(podId);
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        // Check if user is a member of the pod
        if (!pod.members.includes(req.user.id)) {
            return res.status(401).json({ msg: 'Not authorized to view messages in this pod' });
        }
        
        // Build query
        const query = { podId };
        if (before) {
            query.createdAt = { $lt: new Date(before) };
        }
        
        const messages = await Message.find(query)
            .populate('userId', 'username profilePicture')
            .sort({ createdAt: -1 })
            .limit(parseInt(limit));
        
        res.json(messages.reverse()); // Reverse to get oldest first
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Create a message in a pod
exports.createMessage = async (req, res) => {
    try {
        const { podId } = req.params;
        const { text, attachments } = req.body;
        
        if (!text && (!attachments || attachments.length === 0)) {
            return res.status(400).json({ msg: 'Message text or attachments are required' });
        }
        
        // Check if pod exists
        const pod = await Pod.findById(podId);
        if (!pod) {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        
        // Check if user is a member of the pod
        if (!pod.members.includes(req.user.id)) {
            return res.status(401).json({ msg: 'Not authorized to post in this pod' });
        }
        
        const newMessage = new Message({
            text: text || '',
            podId,
            userId: req.user.id,
            attachments: attachments || []
        });
        
        const message = await newMessage.save();
        
        // Update pod's updatedAt
        pod.updatedAt = Date.now();
        await pod.save();
        
        // Populate the user data
        await message.populate('userId', 'username profilePicture');
        
        res.json(message);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Pod not found' });
        }
        res.status(500).send('Server Error');
    }
};

// Delete a message
exports.deleteMessage = async (req, res) => {
    try {
        const message = await Message.findById(req.params.id);
        
        if (!message) {
            return res.status(404).json({ msg: 'Message not found' });
        }
        
        // Check if user is the creator of the message
        if (message.userId.toString() !== req.user.id) {
            // Check if user is the creator of the pod
            const pod = await Pod.findById(message.podId);
            if (!pod || pod.createdBy.toString() !== req.user.id) {
                return res.status(401).json({ msg: 'Not authorized to delete this message' });
            }
        }
        
        await Message.deleteOne({ _id: req.params.id });
        
        res.json({ msg: 'Message deleted' });
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Message not found' });
        }
        res.status(500).send('Server Error');
    }
}; 