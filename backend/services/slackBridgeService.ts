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
  podId: unknown;
  type?: string;
  isActive?: boolean;
  config?: {
    teamId?: string;
    chatId?: string;
    chatType?: string;
    botTokenRef?: string;
    liveRelay?: boolean;
    relayAllAgentMessages?: boolean;
    leadAgentUsername?: string;
    relayMutedUntil?: Date | string;
  };
}

const isRelayableIntegration = (integration: SlackIntegrationDoc, podId: string): boolean => (
  String(integration.podId) === String(podId)
  && integration.type === 'slack'
  && integration.isActive === true
  && integration.config?.liveRelay === true
  && integration.config?.chatType === 'im'
  && Boolean(integration.config?.teamId)
  && Boolean(integration.config?.chatId)
  && Boolean(integration.config?.botTokenRef)
);

const findLiveIntegration = async (podId: string): Promise<SlackIntegrationDoc | null> => (
  Integration.findOne({
    type: 'slack',
    isActive: true,
    podId,
    'config.liveRelay': true,
    'config.chatType': 'im',
    'config.teamId': { $exists: true, $ne: null },
    'config.chatId': { $exists: true, $ne: null },
    'config.botTokenRef': { $exists: true, $ne: null },
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
    if (!shouldEscalate({ content, agentUsername, integration })) return;

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

module.exports = { relayAgentMessageToSlack, isRelayableIntegration };
