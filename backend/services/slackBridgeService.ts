import SlackApi = require('./slackApi');

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const connectorSecrets = require('./connectorSecrets');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { shouldEscalate } = require('./connectorRelayPolicy');

const RELAY_MAP_CAP = 100;
const OUTBOUND_TEXT_CAP = 2_800;

interface SlackIntegrationDoc {
  _id: unknown;
  installationId?: string;
  podId: unknown;
  scope?: 'pod' | 'user';
  type?: string;
  isActive?: boolean;
  status?: string;
  config?: {
    teamId?: string;
    chatId?: string;
    chatType?: string;
    botTokenRef?: string;
    linkedUserId?: string;
    slackUserId?: string;
    liveRelay?: boolean;
    relayAllAgentMessages?: boolean;
    gates?: Record<string, { enabled?: boolean }>;
    leadAgentUsername?: string;
    relayMutedUntil?: Date | string;
    adminPause?: { reason?: string; at?: Date | string; adminId?: string };
    relayMap?: Array<{
      externalMessageId?: string;
      tgMessageId?: string;
      agentUsername?: string;
      podMessageId?: string | null;
      podId?: string;
    }>;
  };
}

const isRelayableIntegration = (integration: SlackIntegrationDoc, podId: string): boolean => (
  (integration.scope === 'user'
    ? integration.config?.gates?.[String(podId)]?.enabled === true
    : String(integration.podId) === String(podId))
  && integration.type === 'slack'
  && integration.isActive === true
  && integration.status !== 'error'
  && integration.config?.liveRelay === true
  && integration.config?.chatType === 'im'
  && !integration.config?.adminPause
  && Boolean(integration.config?.teamId)
  && Boolean(integration.config?.chatId)
  && Boolean(integration.config?.botTokenRef)
);

const findLiveIntegration = async (podId: string): Promise<SlackIntegrationDoc | null> => (
  Integration.findOne({
    type: 'slack',
    isActive: true,
    status: { $ne: 'error' },
    podId,
    'config.liveRelay': true,
    'config.chatType': 'im',
    'config.teamId': { $exists: true, $ne: null },
    'config.chatId': { $exists: true, $ne: null },
    'config.botTokenRef': { $exists: true, $ne: null },
    'config.adminPause': { $exists: false },
  }).lean()
);

// Outbound is intentionally secret-ref-only: legacy Slack rows remain on the
// legacy provider path and cannot be selected by the installable dispatcher.
export const relayAgentMessageToSlack = async (opts: {
  podId: string;
  agentUsername: string;
  displayName: string;
  content: string;
  podMessageId?: string | null;
  integration?: SlackIntegrationDoc;
}): Promise<void> => {
  const {
    podId, agentUsername, displayName, content, podMessageId,
  } = opts;
  try {
    const integration = opts.integration ?? await findLiveIntegration(podId);
    if (!integration || !isRelayableIntegration(integration, podId)) return;
    const mutedUntil = integration.config?.relayMutedUntil;
    if (mutedUntil && new Date(mutedUntil) > new Date()) return;
    if (!shouldEscalate({ content, agentUsername, integration, podId })) return;

    const [pod, token] = await Promise.all([
      Pod.findById(podId).select('name').lean(),
      connectorSecrets.get(String(integration.config!.botTokenRef)),
    ]);
    const podName = String(pod?.name || 'Commonly');
    const text = `[${podName}] ${displayName || agentUsername}: ${String(content).slice(0, OUTBOUND_TEXT_CAP)}`;
    const result = await new SlackApi(token).postMessage(String(integration.config!.chatId), text);
    if (!result.ok || !result.ts) {
      throw new Error(`chat.postMessage failed: ${String(result.error || 'unknown error')}`);
    }
    await Integration.findByIdAndUpdate(integration._id, {
      $push: {
        'config.relayMap': {
          $each: [{
            externalMessageId: String(result.ts), agentUsername, podMessageId: podMessageId || null, podId,
          }],
          $slice: -RELAY_MAP_CAP,
        },
      },
    });
  } catch (error) {
    const config = opts.integration?.config;
    console.warn(
      `[slack-bridge] outbound relay failed integration=${String(opts.integration?._id || 'lookup')} `
      + `team=${String(config?.teamId || 'unknown')}: ${(error as Error).message}`,
    );
  }
};

// D11: a Slack thread attached to a relayed line is a direct answer to that
// line's agent. Keep the map generic so Telegram can migrate from tgMessageId
// without changing this reader.
export const routeSlackReplyContent = (opts: {
  content: string;
  threadTs?: string | null;
  relayMap?: Array<{
    externalMessageId?: string;
    tgMessageId?: string;
    agentUsername?: string;
  }>;
}): { content: string; routedAgent: string | null } => {
  const { content, threadTs, relayMap } = opts;
  if (!threadTs || !Array.isArray(relayMap)) return { content, routedAgent: null };
  const hit = relayMap.find((entry) => String(entry.externalMessageId || entry.tgMessageId) === String(threadTs));
  if (!hit?.agentUsername) return { content, routedAgent: null };
  const mention = `@${hit.agentUsername}`;
  return content.toLowerCase().includes(mention.toLowerCase())
    ? { content, routedAgent: hit.agentUsername }
    : { content: `${mention} ${content}`, routedAgent: hit.agentUsername };
};

// Inbound Slack DM → Commonly pod. The event route has already proven the
// Slack signature and selected the team/channel row; this function repeats
// the ownership-shaped checks because a bridge is never allowed to rely on a
// caller's selection alone.
export const relaySlackMessageToPod = async (opts: {
  integration: SlackIntegrationDoc;
  event: {
    text?: string;
    user?: string;
    ts?: string;
    thread_ts?: string;
    user_profile?: { real_name?: string; display_name?: string };
  };
}): Promise<{ relayed: boolean; routedAgent?: string | null }> => {
  const { integration, event } = opts;
  const rawText = String(event.text || '').trim();
  if (!rawText || rawText.startsWith('/')) return { relayed: false };
  if (!integration.podId) {
    // A user-scoped connector may have gates without an active inbound
    // destination. Fail closed rather than querying/authoring under
    // `String(undefined)`.
    console.warn('[slack-bridge] inbound dropped — connector has no active pod');
    return { relayed: false };
  }
  const config = integration.config || {};
  if (
    !isRelayableIntegration(integration, String(integration.podId))
    || !config.linkedUserId
    || !config.slackUserId
    || event.user !== config.slackUserId
  ) {
    console.warn(
      `[slack-bridge] inbound dropped integration=${String(integration._id)}: `
      + 'unbound or mismatched DM sender',
    );
    return { relayed: false };
  }
  const { content: routedText, routedAgent } = routeSlackReplyContent({
    content: rawText,
    threadTs: event.thread_ts,
    relayMap: config.relayMap,
  });
  const podId = String(integration.podId);
  const linkedUserId = String(config.linkedUserId);
  const senderName = event.user_profile?.display_name || event.user_profile?.real_name;
  const content = senderName
    ? `💬 ${senderName} (via Slack): ${routedText}`
    : `💬 (via Slack): ${routedText}`;

  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const User = require('../models/User');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const PodModel = require('../models/Pod');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const PGMessage = require('../models/pg/Message');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { deliverMessageToAgents } = require('./messageAgentDeliveryService');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const socketConfig = require('../config/socket');

  const [linkedUser, pod] = await Promise.all([
    User.findById(linkedUserId).select('username profilePicture').lean(),
    PodModel.findById(podId).select('type').lean(),
  ]);
  if (!linkedUser || !pod) {
    console.warn('[slack-bridge] inbound dropped — linked user or pod missing');
    return { relayed: false };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const PGPod = require('../models/pg/Pod');
    if (!await PGPod.findById(podId)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const { syncPodFromMongo } = require('./pgPodSyncService');
      await syncPodFromMongo(podId, linkedUserId);
    }
  } catch (error) {
    console.warn('[slack-bridge] PG pod backfill skipped:', (error as Error).message);
  }
  const created = await PGMessage.create(podId, linkedUserId, content, 'text', null, null, null);
  let message: Record<string, unknown> = created;
  try {
    const populated = created?.id ? await PGMessage.findById(created.id) : null;
    if (populated) message = populated;
  } catch (error) {
    console.warn('[slack-bridge] post-write read failed:', (error as Error).message);
  }
  // A post is durable. As in the Telegram bridge, do not turn a later wake or
  // socket failure into a Slack retry that writes the same human message again.
  try {
    await deliverMessageToAgents({
      podId,
      podType: pod.type,
      message,
      userId: linkedUserId,
      requestUser: { username: linkedUser.username },
      replyToMessageId: null,
    });
  } catch (error) {
    console.error('[slack-bridge] agent delivery failed after pod write:', (error as Error).message);
  }
  try {
    const io = socketConfig.getIO();
    if (io) {
      io.to(`pod_${podId}`).emit('newMessage', {
        _id: (message as { id?: unknown }).id,
        id: (message as { id?: unknown }).id,
        pod_id: podId,
        podId,
        content: (message as { content?: unknown }).content || content,
        messageType: 'text',
        userId: { _id: linkedUserId, username: linkedUser.username, profilePicture: linkedUser.profilePicture },
        username: linkedUser.username,
        profile_picture: linkedUser.profilePicture,
        createdAt: (message as { created_at?: unknown }).created_at || new Date(),
        replyTo: null,
        thread_root_id: null,
        payload: null,
      });
    }
  } catch (error) {
    console.warn('[slack-bridge] socket emit failed:', (error as Error).message);
  }
  return { relayed: true, routedAgent };
};

module.exports = {
  relayAgentMessageToSlack,
  relaySlackMessageToPod,
  routeSlackReplyContent,
  isRelayableIntegration,
};
