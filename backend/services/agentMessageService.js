const socketConfig = require('../config/socket');
const Message = require('../models/Message');
const AgentIdentityService = require('./agentIdentityService');

let PGMessage;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (error) {
  PGMessage = null;
}

class AgentMessageService {
  static async postMessage({
    agentName, podId, content, metadata = {}, messageType = 'text', instanceId = 'default', displayName,
  }) {
    if (!agentName || !podId) {
      throw new Error('agentName and podId are required');
    }
    const sanitizedContent = AgentMessageService.sanitizeAgentContent(content);
    if (!sanitizedContent) {
      return { success: true, skipped: true, reason: 'silent_or_empty' };
    }

    const agentUser = await AgentIdentityService.getOrCreateAgentUser(agentName, {
      instanceId,
      displayName,
    });
    const pod = await AgentIdentityService.ensureAgentInPod(agentUser, podId);
    if (!pod) {
      throw new Error('Pod not found');
    }

    let message;

    if (PGMessage && process.env.PG_HOST) {
      try {
        await AgentIdentityService.syncUserToPostgreSQL(agentUser);
        const newMessage = await PGMessage.create(
          podId.toString(),
          agentUser._id.toString(),
          sanitizedContent,
          messageType,
        );

        message = {
          _id: newMessage.id,
          id: newMessage.id,
          content: newMessage.content,
          messageType: newMessage.message_type || messageType,
          userId: {
            _id: agentUser._id,
            username: agentUser.username,
            profilePicture: agentUser.profilePicture,
          },
          username: agentUser.username,
          profile_picture: agentUser.profilePicture,
          createdAt: newMessage.created_at,
          metadata,
        };
      } catch (pgError) {
        console.error('PostgreSQL message creation failed, falling back to MongoDB:', pgError);
      }
    }

    if (!message) {
      const mongoMessage = new Message({
        content: sanitizedContent,
        userId: agentUser._id,
        podId,
        messageType,
        metadata,
      });

      await mongoMessage.save();
      await mongoMessage.populate('userId', 'username profilePicture');
      message = mongoMessage;
    }

    try {
      const io = socketConfig.getIO();
      const formattedMessage = {
        _id: message._id || message.id,
        id: message._id || message.id,
        content: message.content,
        messageType: message.messageType || messageType,
        userId: message.userId || {
          _id: agentUser._id,
          username: agentUser.username,
          profilePicture: agentUser.profilePicture,
        },
        username: message.username || agentUser.username,
        profile_picture: message.profile_picture || agentUser.profilePicture,
        createdAt: message.createdAt,
        metadata: message.metadata || metadata,
      };

      io.to(`pod_${podId}`).emit('newMessage', formattedMessage);
    } catch (socketError) {
      console.error('Failed to emit agent socket message:', socketError);
    }

    return {
      success: true,
      message,
    };
  }

  static sanitizeAgentContent(content) {
    if (content === null || content === undefined) return '';
    const raw = String(content);
    if (!raw.trim()) return '';

    const cleaned = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/\bNO_REPLY\b/g, '').trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    return cleaned;
  }

  static async getRecentMessages(podId, limit = 20) {
    if (!podId) {
      throw new Error('podId is required');
    }

    // Try PostgreSQL first
    if (PGMessage && process.env.PG_HOST) {
      try {
        const messages = await PGMessage.findByPodId(podId.toString(), limit);
        return messages.map((msg) => ({
          _id: msg.id,
          id: msg.id,
          content: msg.content,
          messageType: msg.message_type || 'text',
          userId: {
            _id: msg.user_id,
            username: msg.username || 'Unknown',
            profilePicture: msg.profile_picture,
          },
          username: msg.username || 'Unknown',
          createdAt: msg.created_at,
        }));
      } catch (pgError) {
        console.error('PostgreSQL message fetch failed, falling back to MongoDB:', pgError);
      }
    }

    // Fallback to MongoDB
    const messages = await Message.find({ podId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('userId', 'username profilePicture')
      .lean();

    return messages.reverse().map((msg) => ({
      _id: msg._id,
      id: msg._id,
      content: msg.content,
      messageType: msg.messageType || 'text',
      userId: msg.userId || { username: 'Unknown' },
      username: msg.userId?.username || 'Unknown',
      createdAt: msg.createdAt,
    }));
  }
}

module.exports = AgentMessageService;
