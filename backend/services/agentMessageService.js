const socketConfig = require('../config/socket');
const Message = require('../models/Message');
const Summary = require('../models/Summary');
const AgentIdentityService = require('./agentIdentityService');
const PodAssetService = require('./podAssetService');

let PGMessage;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (error) {
  PGMessage = null;
}

class AgentMessageService {
  static extractStructuredSummary(content, metadata = {}) {
    const result = {
      summaryType: metadata?.summaryType || null,
      title: metadata?.title || metadata?.summary?.title || null,
      body: metadata?.summary?.content || metadata?.summaryContent || null,
      timeRange: metadata?.summary?.timeRange || metadata?.timeRange || null,
      messageCount: metadata?.summary?.messageCount
        || metadata?.messageCount
        || metadata?.summary?.totalItems
        || metadata?.totalItems
        || 0,
      source: metadata?.source || null,
      eventId: metadata?.eventId || null,
    };

    if (result.body) {
      return result;
    }

    const raw = String(content || '').trim();
    if (!raw.startsWith('[BOT_MESSAGE]')) {
      return null;
    }

    const payloadRaw = raw.replace(/^\[BOT_MESSAGE\]/, '');
    try {
      const parsed = JSON.parse(payloadRaw);
      return {
        summaryType: result.summaryType || parsed.summaryType || parsed.type || 'chats',
        title: result.title || parsed.title || null,
        body: parsed.summary || parsed.content || null,
        timeRange: result.timeRange || parsed.timeRange || null,
        messageCount: result.messageCount || parsed.messageCount || 0,
        source: result.source || parsed.source || parsed.sourceLabel || 'agent',
        eventId: result.eventId || parsed.eventId || null,
      };
    } catch (error) {
      return null;
    }
  }

  static mapSummaryType(summaryType) {
    const normalized = String(summaryType || 'chats').toLowerCase();
    if (normalized.includes('daily')) return 'daily-digest';
    if (normalized.includes('post')) return 'posts';
    return 'chats';
  }

  static async persistSummaryFromAgentMessage({
    agentName,
    podId,
    content,
    metadata,
  }) {
    const structured = AgentMessageService.extractStructuredSummary(content, metadata);
    if (!structured?.body) return null;

    const summaryType = AgentMessageService.mapSummaryType(structured.summaryType);
    const now = new Date();
    const defaultStart = new Date(now.getTime() - (60 * 60 * 1000));
    const start = structured.timeRange?.start ? new Date(structured.timeRange.start) : defaultStart;
    const end = structured.timeRange?.end ? new Date(structured.timeRange.end) : now;

    if (structured.eventId) {
      const existing = await Summary.findOne({
        podId,
        type: summaryType,
        'metadata.eventId': structured.eventId,
      });
      if (existing) return existing;
    }

    const summary = await Summary.create({
      type: summaryType,
      podId: summaryType === 'daily-digest' ? undefined : podId,
      title: structured.title || `${agentName} Summary`,
      content: structured.body,
      timeRange: { start, end },
      metadata: {
        totalItems: Number.isFinite(structured.messageCount) ? structured.messageCount : 0,
        podName: metadata?.podName || undefined,
        source: structured.source || 'agent',
        sources: structured.source ? [structured.source] : [],
        eventId: structured.eventId || undefined,
      },
    });

    if (summaryType !== 'daily-digest') {
      try {
        await PodAssetService.createChatSummaryAsset({ podId, summary });
      } catch (assetError) {
        console.warn('Failed to persist summary pod asset from agent message:', assetError.message);
      }
    }

    return summary;
  }

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
    const senderDisplayName = agentUser.botMetadata?.displayName || displayName || agentUser.username;
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
            username: senderDisplayName,
            profilePicture: agentUser.profilePicture,
          },
          username: senderDisplayName,
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

    let persistedSummary = null;
    try {
      persistedSummary = await AgentMessageService.persistSummaryFromAgentMessage({
        agentName,
        podId,
        content: sanitizedContent,
        metadata,
      });
    } catch (summaryError) {
      console.warn('Failed to persist summary from agent message:', summaryError.message);
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
          username: senderDisplayName,
          profilePicture: agentUser.profilePicture,
        },
        username: message.username || senderDisplayName,
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
      summary: persistedSummary
        ? {
          id: persistedSummary._id?.toString?.() || persistedSummary._id,
          type: persistedSummary.type,
        }
        : null,
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
