// Use MongoDB for pod membership checks and PostgreSQL for messages
const Pod = require('../models/Pod');
const PGMessage = require('../models/pg/Message');
const AgentMentionService = require('../services/agentMentionService');

// Get messages for a specific pod
exports.getMessages = async (req, res) => {
  try {
    const { podId } = req.params;
    const { limit = 50, before } = req.query;

    if (!podId) {
      return res.status(400).json({ msg: 'Pod ID is required' });
    }

    // Check if pod exists in MongoDB
    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    // Check if user is a member of the pod
    // Access the user ID safely
    const userId = req.userId || req.user.id;
    if (!userId) {
      return res.status(401).json({ msg: 'User authentication failed' });
    }

    // Check if user is a member using MongoDB Pod model
    const userIdStr = userId.toString();
    const isUserMember = pod.members.some(
      (memberId) => memberId.toString() === userIdStr,
    );
    if (!isUserMember) {
      return res
        .status(401)
        .json({ msg: 'Not authorized to view messages in this pod' });
    }

    // Get messages from PostgreSQL (already ordered DESC - newest first)
    const messages = await PGMessage.findByPodId(
      podId,
      parseInt(limit, 10),
      before,
    );

    res.json(messages);
  } catch (err) {
    console.error('Error in getMessages:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ error: 'Pod not found' });
    }
    return res.status(500).json({ error: 'Server Error' });
  }
};

// Create a message in a pod
exports.createMessage = async (req, res) => {
  try {
    const { podId } = req.params;
    const { content, text, attachments } = req.body;

    if (!podId) {
      return res.status(400).json({ msg: 'Pod ID is required' });
    }

    const messageContent = content || text;

    if (!messageContent && (!attachments || attachments.length === 0)) {
      return res
        .status(400)
        .json({ msg: 'Message text or attachments are required' });
    }

    // Check if pod exists in MongoDB
    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    // Access the user ID safely
    const userId = req.userId || req.user.id;
    if (!userId) {
      return res.status(401).json({ msg: 'User authentication failed' });
    }

    // Check if user is a member using MongoDB Pod model
    const userIdStr = userId.toString();
    const isUserMember = pod.members.some(
      (memberId) => memberId.toString() === userIdStr,
    );
    if (!isUserMember) {
      return res
        .status(401)
        .json({ msg: 'Not authorized to post in this pod' });
    }

    // Create message in PostgreSQL
    const message = await PGMessage.create(
      podId,
      userId,
      messageContent || '',
      'text',
    );

    const username = req.user?.username;
    await AgentMentionService.enqueueMentions({
      podId,
      message,
      userId,
      username,
    });

    res.json(message);
  } catch (err) {
    console.error('Error in createMessage:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ error: 'Pod not found' });
    }
    return res.status(500).json({ error: 'Server Error' });
  }
};

// Delete a message
exports.deleteMessage = async (req, res) => {
  try {
    const message = await PGMessage.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ msg: 'Message not found' });
    }

    // Access the user ID safely
    const userId = req.userId || req.user.id;
    if (!userId) {
      return res.status(401).json({ msg: 'User authentication failed' });
    }

    // Check if user is the creator of the message
    if (message.user_id.toString() !== userId.toString()) {
      // Check if user is the creator of the pod using MongoDB
      const pod = await Pod.findById(message.pod_id);
      if (!pod || pod.createdBy.toString() !== userId.toString()) {
        return res
          .status(401)
          .json({ msg: 'Not authorized to delete this message' });
      }
    }

    await PGMessage.delete(req.params.id);

    res.json({ msg: 'Message deleted' });
  } catch (err) {
    console.error('Error in deleteMessage:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ error: 'Message not found' });
    }
    return res.status(500).json({ error: 'Server Error' });
  }
};
