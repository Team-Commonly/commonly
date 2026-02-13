const socketConfig = require('../config/socket');
const Message = require('../models/Message');
const Summary = require('../models/Summary');
const AgentIdentityService = require('./agentIdentityService');
const PodAssetService = require('./podAssetService');
const AgentEventService = require('./agentEventService');
const DMService = require('./dmService');

let PGMessage;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (error) {
  PGMessage = null;
}

class AgentMessageService {
  static normalizeInstallationConfig(config) {
    if (!config) return {};
    if (config instanceof Map) {
      return Object.fromEntries(config.entries());
    }
    if (typeof config === 'object') {
      return config;
    }
    return {};
  }

  static shouldRouteErrorsToOwnerDM(installationConfig) {
    const normalizedConfig = AgentMessageService.normalizeInstallationConfig(installationConfig);
    const errorRouting = normalizedConfig?.errorRouting;
    if (!errorRouting || typeof errorRouting !== 'object') return false;
    return errorRouting.ownerDm === true;
  }

  static isErrorContent(content) {
    const text = String(content || '');
    if (!text.trim()) return false;

    const patterns = [
      /\berror\b.*\b(reading|fetching|loading|accessing)\b/i,
      /\bcannot\b.*\b(read|access|fetch|load|connect)\b/i,
      /\bfailed to\b.*\b(read|fetch|load|access|connect|generate)\b/i,
      /\bmessage:\s*send\b.*\bfailed\b/i,
      /\bunknown target\b/i,
      /\bcontext (overflow|window|length|limit)\b/i,
      /\btoo many tokens\b/i,
      /\bprompt too (large|long)\b/i,
      /\brate limit\b/i,
      /\b(401|403|404|429|500|502|503)\b.*\b(error|status|response)\b/i,
      /\bAPI (key|token)\b.*\b(invalid|expired|missing)\b/i,
      /\bauthentication\b.*\b(failed|error|invalid)\b/i,
      /\bcommonly pod service is (?:not running|still not running)\b/i,
      /\bunable to (?:get|read|fetch) (?:the )?pod activity\b/i,
      /\brequired commonly tools are not available\b/i,
      /\bcannot perform (?:the )?required pod activity check\b/i,
      /\bmissing(?: [a-z]+)? tokens?\b/i,
      /\bstack trace\b/i,
      /\bERROR[:]/i,
      /\bTraceback\b/i,
      /\bException\b/i,
    ];
    return patterns.some((pattern) => pattern.test(text));
  }

  static isHeartbeatEvent(metadata = {}) {
    const sourceEventType = String(
      metadata?.sourceEventType || metadata?.eventType || '',
    ).trim().toLowerCase();
    return sourceEventType === 'heartbeat';
  }

  static isHeartbeatHousekeepingContent(content) {
    const text = String(content || '').trim();
    if (!text) return false;

    const patterns = [
      /\bno meaningful new signals detected\b/i,
      /\bno meaningful new signal to report\b/i,
      /\bheartbeat check complete with no new activity to report\b/i,
      /\bno new activity to report\b/i,
      /\bi(?:'|’)ll check the pod activity\b/i,
      /\bi(?:'|’)ll check the current pod activity\b/i,
      /\bi(?:'|’)ll check the current activity\b/i,
      /\bi need to check the actual pod activity\b/i,
      /\breport back only if there(?:'|’)s meaningful new signal\b/i,
      /\bi(?:'|’)ve triggered the heartbeat check\b/i,
      /\blet me try (?:fetching|checking)\b/i,
      /\blet me (?:use|try) (?:the )?(?:proper )?runtime api\b/i,
      /\blet me try (?:a )?(?:more )?direct approach\b/i,
      /\blet me try (?:a )?different approach\b/i,
      /\blet me try (?:the )?direct http endpoint approach\b/i,
      /\blet me try (?:a )?simpler approach\b/i,
      /\blocalhost:3000\/api\/agents\/runtime\/pods\b/i,
      /\bmessages_failed\b/i,
      /\bcould you please specify which tool\b/i,
      /\bpayload\.activityHint\b.*\bcurrent pod activity\b.*\bHEARTBEAT_OK\b/i,
      /\bi(?:'|’)ll check if there(?:'|’)s been recent activity before deciding whether to post\b/i,
    ];
    return patterns.some((pattern) => pattern.test(text));
  }

  static isHeartbeatDiagnosticContent(content) {
    const text = String(content || '').trim();
    if (!text) return false;

    const patterns = [
      /\bcommonly pod service is (?:not running|still not running)\b/i,
      /\bunable to (?:get|read|fetch) (?:the )?pod activity\b/i,
      /\bunable to retrieve any meaningful new signals?\b/i,
      /\bunable to access (?:the )?pod(?:'s)? activity data\b/i,
      /\brequired commonly tools are not available\b/i,
      /\bcannot perform (?:the )?required pod activity check\b/i,
      /\bapi calls? .* consistently failing\b/i,
      /\bpersistent issue with accessing (?:the )?pod(?:'s)? data\b/i,
      /\brequests? (?:are|were) returning errors?\b/i,
      /\bcommonly channel configuration (?:doesn(?:'|’)t|does not) support\b/i,
      /\boperations? i need to check recent activity\b/i,
      /\bauthentication issue\b/i,
      /\bnetwork problem\b/i,
      /\bendpoints? (?:are|were|is)n(?:'|’)t accessible\b/i,
      /\bcan(?:'|’)t retrieve (?:the )?pod(?:'s)? current activity\b/i,
      /\bcannot retrieve (?:the )?pod(?:'s)? current activity\b/i,
      /\bpod .* (?:doesn(?:'|’)t exist|isn(?:'|’)t accessible)\b/i,
      /\bpod appears to be unavailable\b/i,
      /\bpod .* id is incorrect\b/i,
      /\bno activity hint in the payload\b/i,
      /\bno activity hint in the payload to check for recent activity\b/i,
      /\bconnectivity or authentication problem\b/i,
      /\bmissing tokens?\b/i,
      /\bpermission denied\b/i,
      /\bforbidden\b/i,
    ];
    return patterns.some((pattern) => pattern.test(text));
  }

  static logMessageLifecycle(action, details = {}) {
    const parts = [
      `[agent-message] ${action}`,
      `agent=${details.agentName || 'unknown'}`,
      `instance=${details.instanceId || 'default'}`,
      `pod=${details.podId || 'n/a'}`,
      `sourceEventType=${details.sourceEventType || 'n/a'}`,
      `sourceEventId=${details.sourceEventId || 'n/a'}`,
    ];
    if (details.messageId) parts.push(`messageId=${details.messageId}`);
    if (details.reason) parts.push(`reason=${details.reason}`);
    if (details.dedupeWindowMinutes) parts.push(`dedupeWindowMinutes=${details.dedupeWindowMinutes}`);
    console.log(parts.join(' '));
  }

  static normalizeForDedupe(content) {
    return String(content || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static resolveDedupeWindowMinutes(metadata = {}) {
    const sourceEventType = String(
      metadata?.sourceEventType || metadata?.eventType || '',
    ).toLowerCase();
    if (sourceEventType === 'heartbeat') {
      const parsed = Number.parseInt(process.env.AGENT_HEARTBEAT_MESSAGE_DEDUPE_MINUTES, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
      return 180;
    }
    const parsed = Number.parseInt(process.env.AGENT_MESSAGE_DEDUPE_WINDOW_MINUTES, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return 30;
  }

  static async findRecentDuplicate({
    podId,
    userId,
    content,
    metadata = {},
  }) {
    const dedupeWindowMinutes = AgentMessageService.resolveDedupeWindowMinutes(metadata);
    if (!dedupeWindowMinutes || dedupeWindowMinutes <= 0) return null;

    const target = AgentMessageService.normalizeForDedupe(content);
    if (!target) return null;

    const recent = await AgentMessageService.getRecentMessages(podId, 60);
    const cutoff = Date.now() - (dedupeWindowMinutes * 60 * 1000);
    const userIdString = String(userId || '');

    const hit = recent
      .slice()
      .reverse()
      .find((message) => {
        const messageUserId = String(message?.userId?._id || message?.user_id || '');
        if (!messageUserId || messageUserId !== userIdString) return false;
        const createdAt = new Date(message?.createdAt || 0).valueOf();
        if (!Number.isFinite(createdAt) || createdAt < cutoff) return false;
        return AgentMessageService.normalizeForDedupe(message?.content || '') === target;
      });

    if (!hit) return null;
    return {
      id: hit.id || hit._id || null,
      createdAt: hit.createdAt || null,
      dedupeWindowMinutes,
    };
  }

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
    agentName,
    podId,
    content,
    metadata = {},
    messageType = 'text',
    instanceId = 'default',
    displayName,
    installationConfig = null,
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

    const isHeartbeatEvent = AgentMessageService.isHeartbeatEvent(metadata);
    const isHeartbeatHousekeeping = AgentMessageService.isHeartbeatHousekeepingContent(
      sanitizedContent,
    );
    const isHeartbeatDiagnostic = AgentMessageService.isHeartbeatDiagnosticContent(
      sanitizedContent,
    );
    const normalizedAgentName = String(agentName || '').trim().toLowerCase();
    const shouldTreatAsHeartbeatGuardrail = isHeartbeatEvent
      || (
        normalizedAgentName === 'openclaw'
        && (isHeartbeatHousekeeping || isHeartbeatDiagnostic)
      );

    if (shouldTreatAsHeartbeatGuardrail && isHeartbeatHousekeeping) {
      AgentMessageService.logMessageLifecycle('skipped', {
        agentName,
        instanceId,
        podId: String(podId),
        sourceEventType: metadata?.sourceEventType || metadata?.eventType,
        sourceEventId: metadata?.sourceEventId || metadata?.eventId,
        reason: 'heartbeat_housekeeping',
      });
      return { success: true, skipped: true, reason: 'heartbeat_housekeeping' };
    }

    if (
      shouldTreatAsHeartbeatGuardrail
      && (
        isHeartbeatDiagnostic
        || AgentMessageService.isErrorContent(sanitizedContent)
      )
    ) {
      if (AgentMessageService.shouldRouteErrorsToOwnerDM(installationConfig)) {
        try {
          const routed = await AgentMessageService.routeErrorToDM({
            agentName,
            instanceId,
            podId,
            content: sanitizedContent,
            agentUser,
            displayName,
            messageType,
            metadata,
            postSourceNotice: false,
          });
          if (routed) {
            return { success: true, routedToDM: true, dmPodId: routed.dmPodId };
          }
        } catch (routeError) {
          console.warn('Heartbeat DM routing failed, suppressing pod error post:', routeError.message);
        }
      }

      AgentMessageService.logMessageLifecycle('skipped', {
        agentName,
        instanceId,
        podId: String(podId),
        sourceEventType: metadata?.sourceEventType || metadata?.eventType,
        sourceEventId: metadata?.sourceEventId || metadata?.eventId,
        reason: 'heartbeat_diagnostic_suppressed',
      });
      return { success: true, skipped: true, reason: 'heartbeat_diagnostic_suppressed' };
    }

    // Route likely error/debug content to agent-admin DM (agent <-> installer),
    // then leave a short system notice in the original pod.
    if (
      AgentMessageService.shouldRouteErrorsToOwnerDM(installationConfig)
      && AgentMessageService.isErrorContent(sanitizedContent)
    ) {
      try {
        const shouldPostSourceNotice = normalizedAgentName !== 'openclaw';
        const routed = await AgentMessageService.routeErrorToDM({
          agentName,
          instanceId,
          podId,
          content: sanitizedContent,
          agentUser,
          displayName,
          messageType,
          metadata,
          postSourceNotice: shouldPostSourceNotice,
        });
        if (routed) {
          return { success: true, routedToDM: true, dmPodId: routed.dmPodId };
        }
      } catch (routeError) {
        console.warn('DM routing failed, posting error in original pod:', routeError.message);
      }
    }

    const duplicate = await AgentMessageService.findRecentDuplicate({
      podId,
      userId: agentUser._id,
      content: sanitizedContent,
      metadata,
    });
    if (duplicate) {
      AgentMessageService.logMessageLifecycle('skipped', {
        agentName,
        instanceId,
        podId: String(podId),
        sourceEventType: metadata?.sourceEventType || metadata?.eventType,
        sourceEventId: metadata?.sourceEventId || metadata?.eventId,
        reason: 'duplicate_recent',
        dedupeWindowMinutes: duplicate.dedupeWindowMinutes,
      });
      return {
        success: true,
        skipped: true,
        reason: 'duplicate_recent',
        duplicate,
      };
    }

    const posted = await AgentMessageService._postToTarget({
      agentName,
      instanceId,
      podId,
      content: sanitizedContent,
      messageType,
      metadata,
      agentUser,
      displayName,
    });

    return {
      success: true,
      message: posted.message,
      summary: posted.summary
        ? {
          id: posted.summary._id?.toString?.() || posted.summary._id,
          type: posted.summary.type,
        }
        : null,
    };
  }

  static async routeErrorToDM({
    agentName,
    instanceId = 'default',
    podId,
    content,
    agentUser,
    displayName,
    messageType = 'text',
    metadata = {},
    postSourceNotice = true,
  }) {
    const ownerId = await DMService.resolveAgentOwner(agentName, podId, instanceId);
    if (!ownerId) return null;

    const ownerIdString = String(ownerId);
    const agentIdString = String(agentUser?._id || '');
    if (!ownerIdString || ownerIdString === agentIdString) return null;

    const dmPod = await DMService.getOrCreateAgentDM(agentUser._id, ownerId, {
      agentName,
      instanceId,
    });

    const dmPrefix = `[Error in pod ${podId}]`;
    await AgentMessageService._postToTarget({
      agentName,
      instanceId,
      podId: dmPod._id,
      content: `${dmPrefix}\n\n${content}`,
      messageType,
      metadata,
      agentUser,
      displayName,
    });

    if (postSourceNotice) {
      await AgentMessageService._postToTarget({
        agentName,
        instanceId,
        podId,
        content: '[Encountered an issue - details sent to debug DM]',
        messageType: 'system',
        metadata,
        agentUser,
        displayName,
        skipDeliveryUpdate: true,
        skipSummaryPersistence: true,
      });
    }

    return { routedToDM: true, dmPodId: dmPod._id };
  }

  static async _postToTarget({
    agentName,
    instanceId = 'default',
    podId,
    content,
    messageType = 'text',
    metadata = {},
    agentUser,
    displayName,
    skipDeliveryUpdate = false,
    skipSummaryPersistence = false,
  }) {
    const senderDisplayName = agentUser?.botMetadata?.displayName || displayName || agentUser?.username;
    let message;

    if (PGMessage && process.env.PG_HOST) {
      try {
        await AgentIdentityService.syncUserToPostgreSQL(agentUser);
        const newMessage = await PGMessage.create(
          podId.toString(),
          agentUser._id.toString(),
          content,
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
        content,
        userId: agentUser._id,
        podId,
        messageType,
        metadata,
      });

      await mongoMessage.save();
      await mongoMessage.populate('userId', 'username profilePicture');
      message = mongoMessage;
    }

    AgentMessageService.logMessageLifecycle('posted', {
      agentName,
      instanceId,
      podId: String(podId),
      sourceEventType: metadata?.sourceEventType || metadata?.eventType,
      sourceEventId: metadata?.sourceEventId || metadata?.eventId,
      messageId: message?._id || message?.id || null,
    });

    if (!skipDeliveryUpdate) {
      try {
        const sourceEventId = metadata?.sourceEventId || metadata?.eventId;
        if (sourceEventId) {
          await AgentEventService.markPosted(sourceEventId, agentName, instanceId, {
            messageId: message?._id || message?.id || null,
          });
        }
      } catch (eventError) {
        console.warn('Failed to update agent event delivery outcome:', eventError.message);
      }
    }

    let persistedSummary = null;
    if (!skipSummaryPersistence) {
      try {
        persistedSummary = await AgentMessageService.persistSummaryFromAgentMessage({
          agentName,
          podId,
          content,
          metadata,
        });
      } catch (summaryError) {
        console.warn('Failed to persist summary from agent message:', summaryError.message);
      }
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

    return { message, summary: persistedSummary };
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
