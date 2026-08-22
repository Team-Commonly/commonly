// eslint-disable-next-line global-require
const AgentMentionService = require('./agentMentionService');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');

export interface MessageForAgentDelivery {
  userId?: { username?: string } | string;
  username?: string;
  user?: { username?: string };
}

interface DeliveryOptions<T extends MessageForAgentDelivery> {
  podId: string;
  podType: unknown;
  message: T;
  userId: string;
  requestUser?: { username?: string };
  // Undefined means this endpoint has no reply-edge field (the legacy PG
  // route). Null is meaningful: the primary route explicitly sends it for a
  // root post, preserving the existing enqueueMentions call shape.
  replyToMessageId?: string | null;
}

interface AgentDelivery {
  enqueued: number;
  implicit: string[];
  agentsInPod: number;
  woken: number;
}

type DeliveredMessage<T> = T | (T & { agentDelivery: AgentDelivery });

// The persisted message is the authoritative sender frame. Request auth can
// have only an id (JWT) while either PG or Mongo may have joined the author.
// Keep the historical precedence stable across both create routes.
export const authorUsername = (
  message: MessageForAgentDelivery | null | undefined,
  requestUser?: { username?: string },
): string | undefined => {
  const joinedAuthor = message?.userId;
  return requestUser?.username
    || (joinedAuthor && typeof joinedAuthor === 'object' ? joinedAuthor.username : undefined)
    || message?.username
    || message?.user?.username;
};

// Both user-message controllers persist first, then deliver the same message
// to either the automatic DM route or the explicit-mention route. Centralizing
// this seam keeps the response metadata and sender identity in lockstep while
// leaving route-specific write semantics (including reply edges) at the edge.
export const deliverMessageToAgents = async <T extends MessageForAgentDelivery>({
  podId,
  podType,
  message,
  userId,
  requestUser,
  replyToMessageId,
}: DeliveryOptions<T>): Promise<DeliveredMessage<T>> => {
  const username = authorUsername(message, requestUser);

  if (AgentMentionService.isAutoRoutedDmPod(podType)) {
    await AgentMentionService.enqueueDmEvent({ podId, message, userId, username });
    return message;
  }

  const mentionOptions = {
    podId,
    message,
    userId,
    username,
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
  };
  const mentionResult = await AgentMentionService.enqueueMentions(mentionOptions);
  let agentsInPod = 0;
  try {
    agentsInPod = await AgentInstallation.countDocuments({ podId, status: 'active' });
  } catch (countErr) {
    // Delivery metadata is advisory UI feedback. A count failure must never
    // turn an already-persisted message into a failed send.
    console.warn('[messageAgentDelivery] active-agent delivery count failed:', (countErr as Error).message);
  }

  return {
    ...message,
    agentDelivery: {
      enqueued: mentionResult.enqueued.length,
      implicit: mentionResult.implicit || [],
      agentsInPod,
      woken: mentionResult.woken?.length ?? 0,
    },
  };
};
