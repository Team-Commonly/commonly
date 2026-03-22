// Use MongoDB for pod membership checks and PostgreSQL for messages (MongoDB fallback)
const Pod = require('../models/Pod');
const MongoMessage = require('../models/Message');
const PGMessage = require('../models/pg/Message');
const AgentMentionService = require('../services/agentMentionService');

const pgAvailable = () => {
  try {
    const { pool } = require('../config/db-pg');
    return !!pool;
  } catch {
    return false;
  }
};

// Normalize a MongoDB message to match PG message shape
const normalizeMongo = (m) => ({
  id: m._id.toString(),
  pod_id: m.podId.toString(),
  user_id: m.userId.toString(),
  content: m.content,
  message_type: m.messageType || 'text',
  created_at: m.createdAt,
  updated_at: m.updatedAt,
  user: m.userId?.username ? { username: m.userId.username, profile_picture: m.userId.profilePicture } : undefined,
});

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

    const userId = req.userId || req.user.id;
    if (!userId) {
      return res.status(401).json({ msg: 'User authentication failed' });
    }

    // Check membership
    const userIdStr = userId.toString();
    const isUserMember = pod.members.some(
      (memberId) => memberId.toString() === userIdStr,
    );
    if (!isUserMember) {
      return res.status(401).json({ msg: 'Not authorized to view messages in this pod' });
    }

    // Try PostgreSQL first, fall back to MongoDB
    try {
      const messages = await PGMessage.findByPodId(podId, parseInt(limit, 10), before);
      return res.json(messages);
    } catch (pgErr) {
      console.warn('PG unavailable for getMessages, falling back to MongoDB:', pgErr.message);
    }

    const query = { podId };
    if (before) query.createdAt = { $lt: new Date(before) };
    const messages = await MongoMessage.find(query)
      .populate('userId', 'username profilePicture')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit, 10));
    return res.json(messages.map(normalizeMongo));
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
    const { content, text, attachments, replyToMessageId } = req.body;

    if (!podId) {
      return res.status(400).json({ msg: 'Pod ID is required' });
    }

    const messageContent = content || text;

    if (!messageContent && (!attachments || attachments.length === 0)) {
      return res.status(400).json({ msg: 'Message text or attachments are required' });
    }

    // Check if pod exists in MongoDB
    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    const userId = req.userId || req.user.id;
    if (!userId) {
      return res.status(401).json({ msg: 'User authentication failed' });
    }

    // Check membership
    const userIdStr = userId.toString();
    const isUserMember = pod.members.some(
      (memberId) => memberId.toString() === userIdStr,
    );
    if (!isUserMember) {
      return res.status(401).json({ msg: 'Not authorized to post in this pod' });
    }

    let message;

    // Try PostgreSQL first, fall back to MongoDB
    try {
      message = await PGMessage.create(
        podId,
        userId,
        messageContent || '',
        'text',
        replyToMessageId || null,
      );
    } catch (pgErr) {
      console.warn('PG unavailable for createMessage, falling back to MongoDB:', pgErr.message);
      const mongoMsg = await MongoMessage.create({
        podId,
        userId,
        content: messageContent || '',
        messageType: 'text',
      });
      message = normalizeMongo(mongoMsg);
    }

    const username = req.user?.username;
    if (pod.type === 'agent-admin') {
      await AgentMentionService.enqueueDmEvent({ podId, message, userId, username });
    } else {
      await AgentMentionService.enqueueMentions({ podId, message, userId, username });
    }

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
    let message;
    try {
      message = await PGMessage.findById(req.params.id);
    } catch {
      message = await MongoMessage.findById(req.params.id);
      if (message) message = normalizeMongo(message);
    }

    if (!message) {
      return res.status(404).json({ msg: 'Message not found' });
    }

    const userId = req.userId || req.user.id;
    if (!userId) {
      return res.status(401).json({ msg: 'User authentication failed' });
    }

    if (message.user_id.toString() !== userId.toString()) {
      const pod = await Pod.findById(message.pod_id);
      if (!pod || pod.createdBy.toString() !== userId.toString()) {
        return res.status(401).json({ msg: 'Not authorized to delete this message' });
      }
    }

    try {
      await PGMessage.delete(req.params.id);
    } catch {
      await MongoMessage.findByIdAndDelete(req.params.id);
    }

    res.json({ msg: 'Message deleted' });
  } catch (err) {
    console.error('Error in deleteMessage:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ error: 'Message not found' });
    }
    return res.status(500).json({ error: 'Server Error' });
  }
};
