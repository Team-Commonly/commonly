// Discord live relay, inbound (D249, F131): a bound guild channel's messages
// reach its pod as real pod messages, through the shared chat-relay core.
//
// A guild channel is a SHARED surface: anyone in the guild can post there. So
// this follows Slack's model, not Telegram's private-chat one. A line is relayed
// live, authored as the row's `linkedUserId`, only when its Discord author is
// the person who added the bot, proven by the OAuth callback's `users/@me` read
// and stored server-side as `config.discordUserId`. Everyone else's lines keep
// the gateway's buffer-for-summary path, which this module does not touch.
//
// Outbound is not here: Discord is not in the outbound relay registry, and an
// agent's pod message does not reach the channel through this bridge.

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../models/Integration');
import {
  claimInboundMessage,
  loadInboundAuthor,
  proveInboundSender,
  writeInboundAsLinkedUser,
} from './chatRelay/chatRelayCore';
import type { InboundRelayAdapter, LiveRelayRow } from './chatRelay/chatRelayCore';

const LOG = '[discord-bridge]';

// discord.js MessageType: Default and Reply are what a person types. Everything
// else (joins, pins, boosts, thread starters, …) is the system talking.
const PERSON_MESSAGE_TYPES = new Set([0, 19]);

export interface DiscordIntegrationDoc {
  _id: unknown;
  podId?: unknown;
  type?: string;
  isActive?: boolean;
  status?: string;
  createdBy?: unknown;
  config?: {
    serverId?: string;
    channelId?: string;
    liveRelay?: boolean;
    linkedUserId?: string;
    discordUserId?: string;
    adminPause?: unknown;
  };
}

export interface DiscordInboundMessage {
  id?: string;
  type?: number;
  system?: boolean;
  webhookId?: string | null;
  guild?: { id?: string } | null;
  channel?: { id?: string } | null;
  author?: { id?: string; username?: string; globalName?: string | null; bot?: boolean } | null;
  member?: { displayName?: string } | null;
  content?: string;
  attachments?: Map<string, { url?: string }> | { values: () => Iterable<{ url?: string }> };
}

const idOf = (value: unknown): string => {
  if (!value) return '';
  const nested = (value as { _id?: unknown })._id;
  return String(nested ?? value);
};

/**
 * Lines that are never a person speaking: any bot (our own channel webhook's
 * echo of an outbound line included, so nothing loops), any webhook, and any
 * system message.
 */
export const isIgnoredDiscordMessage = (message: DiscordInboundMessage | null | undefined): boolean => (
  !message
  || !message.id
  || message.author?.bot === true
  || Boolean(message.webhookId)
  || message.system === true
  || (message.type !== undefined && !PERSON_MESSAGE_TYPES.has(Number(message.type)))
);

// The row is live for inbound, and the message came from the channel it binds.
// The gateway's channel cache already matched guild and channel, but it is up to
// a minute stale, so the row read here is the authority.
const isInboundRelayableIntegration = (
  integration: DiscordIntegrationDoc,
  message: DiscordInboundMessage,
): boolean => (
  integration.type === 'discord'
  && integration.isActive === true
  && integration.status !== 'error'
  && integration.config?.liveRelay === true
  && !integration.config?.adminPause
  && Boolean(integration.podId)
  && Boolean(integration.config?.serverId)
  && Boolean(integration.config?.channelId)
  && String(integration.config?.serverId) === String(message.guild?.id || '')
  && String(integration.config?.channelId) === String(message.channel?.id || '')
);

const LIVE_RELAY_NEEDS_PROOF = 'Live relay on a Discord channel needs the Discord account of the person who '
  + 'added the bot, which the install proves. Add the bot again from Commonly to link it.';
const LIVE_RELAY_INSTALLER_ONLY = 'Only the person who added the bot can turn on live relay for this channel: '
  + 'it posts their own Discord messages into the pod as them.';

export const discordInboundAdapter: InboundRelayAdapter<DiscordIntegrationDoc, DiscordInboundMessage> = {
  provider: 'discord',
  // The author is the Discord account the install proved, and the Commonly user
  // the line is authored as is the one that account was proven for: the row's
  // creator, whose install proof carried the id. A guild channel guarantees
  // nothing else about who is speaking.
  senderIsLinkedUser: (integration, message) => {
    const discordUserId = integration.config?.discordUserId;
    const linkedUserId = integration.config?.linkedUserId;
    return Boolean(discordUserId)
      && message?.author?.bot !== true
      && String(message?.author?.id || '') === String(discordUserId)
      && Boolean(linkedUserId)
      && String(linkedUserId) === idOf(integration.createdBy);
  },
  // `linkedUserId` is stamped from whoever turns live relay on, so that person
  // must be the one whose Discord id the row holds.
  liveRelayRefusal: (row: LiveRelayRow, requesterId: string) => {
    if (!row.config?.discordUserId) return LIVE_RELAY_NEEDS_PROOF;
    if (!requesterId || idOf(row.createdBy) !== String(requesterId)) return LIVE_RELAY_INSTALLER_ONLY;
    return null;
  },
};

const attachmentUrls = (message: DiscordInboundMessage): string[] => {
  const attachments = message.attachments;
  if (!attachments || typeof (attachments as { values?: unknown }).values !== 'function') return [];
  return Array.from((attachments as { values: () => Iterable<{ url?: string }> }).values())
    .map((attachment) => String(attachment?.url || ''))
    .filter(Boolean);
};

/** The pod line: the text as typed (mentions stay text), then each attachment as a link. */
export const renderDiscordInboundContent = (message: DiscordInboundMessage): string => {
  const body = [String(message.content || '').trim(), ...attachmentUrls(message)].filter(Boolean).join('\n');
  if (!body) return '';
  const name = message.member?.displayName || message.author?.globalName || message.author?.username;
  return name ? `💬 ${name} (via Discord): ${body}` : `💬 (via Discord): ${body}`;
};

/**
 * One Discord channel message → its pod, when the row relays live and the
 * author is proven. Resolves `{ relayed: false }` for every line that is not
 * relayed, and `duplicate: true` when another replica's gateway claimed it.
 */
export const relayDiscordMessageToPod = async (opts: {
  integration: DiscordIntegrationDoc;
  message: DiscordInboundMessage;
}): Promise<{ relayed: boolean; duplicate?: boolean }> => {
  const { integration, message } = opts;
  if (isIgnoredDiscordMessage(message)) return { relayed: false };
  if (!isInboundRelayableIntegration(integration, message)) return { relayed: false };
  const sender = proveInboundSender(discordInboundAdapter, integration, message);
  if (!sender) return { relayed: false };
  const content = renderDiscordInboundContent(message);
  if (!content) return { relayed: false };

  // Each backend replica holds its own gateway socket, so each receives this
  // message. One claim per (row, message) across all of them.
  const claim = await claimInboundMessage('discord', integration._id, String(message.id));
  if (claim === 'duplicate') return { relayed: false, duplicate: true };
  if (claim === 'unavailable') {
    // Fail closed: two replicas writing the same line is the defect the claim
    // exists for, and the line is still in the summary buffer.
    console.warn(`${LOG} inbound not relayed integration=${String(integration._id)}: claim store unavailable`);
    return { relayed: false };
  }

  const podId = String(integration.podId);
  const author = await loadInboundAuthor({
    podId,
    sender,
    logPrefix: LOG,
    // A shared channel gets no notice: the refusal is about one person's pod
    // membership, and everyone in the guild would read it.
    onNotMember: async () => {},
  });
  if (!author) return { relayed: false };
  await writeInboundAsLinkedUser({
    podId,
    podType: author.pod.type,
    sender,
    linkedUser: author.linkedUser,
    content,
    replyToMessageId: null,
    logPrefix: LOG,
  });
  return { relayed: true };
};

/** The gateway's entry: re-read the row (the gateway's cache is stale by design) and relay. */
export const relayDiscordMessageForIntegration = async (
  integrationId: unknown,
  message: DiscordInboundMessage,
): Promise<{ relayed: boolean; duplicate?: boolean }> => {
  if (isIgnoredDiscordMessage(message)) return { relayed: false };
  const integration = await Integration.findById(integrationId)
    .select('_id podId type isActive status createdBy config.serverId config.channelId config.liveRelay '
      + 'config.linkedUserId config.discordUserId config.adminPause')
    .lean() as DiscordIntegrationDoc | null;
  if (!integration) return { relayed: false };
  return relayDiscordMessageToPod({ integration, message });
};

module.exports = {
  discordInboundAdapter,
  isIgnoredDiscordMessage,
  renderDiscordInboundContent,
  relayDiscordMessageToPod,
  relayDiscordMessageForIntegration,
};
