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
// Outbound (F132): with live relay on, the pod's agent lines reach the bound
// channel by mode, through the core's hold/mute/escalate ladder, sent by the
// channel's own webhook. Agent text reaches everyone in the guild, so the send
// can ping no one (`allowed_mentions: { parse: [] }`), and it is paced to the
// webhook's rate limit. The webhook's own echo of each line is a webhook-authored
// message, which `isIgnoredDiscordMessage` drops, so nothing loops back in.

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const axios = require('axios');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { isGatedPodTarget, isListedPodMember } = require('./connectorRelayPolicy');
import { resolveDiscordWebhookUrl } from '../utils/discordWebhookUrl';
import {
  claimInboundMessage,
  loadInboundAuthor,
  proveInboundSender,
  writeInboundAsLinkedUser,
} from './chatRelay/chatRelayCore';
import type {
  ChatRelayAdapter, InboundRelayAdapter, LiveRelayRow, OutboundRelayOptions,
} from './chatRelay/chatRelayCore';
import type { DecisionRelayCard } from './decisionCardRelay';

const LOG = '[discord-bridge]';
const AUTHOR_LOAD_ATTEMPTS = 3;

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
    webhookUrlRef?: string;
    webhookUrl?: string;
    relayAllAgentMessages?: boolean;
    relayMutedUntil?: Date | string;
    leadAgentUsername?: string;
    gates?: Record<string, { enabled?: boolean; mode?: 'attention' | 'mirror'; lead?: string }>;
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
const LIVE_RELAY_MEMBERS_ONLY = 'Live relay on a Discord channel needs the person who added the bot to still be '
  + 'a member of this pod: the channel is theirs, and the pod\'s agent messages would go to it.';
const LIVE_RELAY_INSTALLER_ONLY = 'Only the person who added the bot can turn on live relay for this channel: '
  + 'it posts their own Discord messages into the pod as them, and the pod\'s agent messages into the channel.';

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
  // must be the one whose Discord id the row holds — and, since the channel is
  // theirs and shared, still a listed member of the pod whose agent lines it
  // would carry (F132 review). A caller that hands no pod is refused: fail closed.
  liveRelayRefusal: (row: LiveRelayRow, requesterId: string) => {
    if (!row.config?.discordUserId) return LIVE_RELAY_NEEDS_PROOF;
    if (!requesterId || idOf(row.createdBy) !== String(requesterId)) return LIVE_RELAY_INSTALLER_ONLY;
    if (!row.pod || !isListedPodMember(row.pod, requesterId)) return LIVE_RELAY_MEMBERS_ONLY;
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
    // A deliberate exception to review rule 19 (INTEGRATION_CONTRACT.md, F131):
    // the operator is the audience, so name the row and the message.
    console.warn(
      `${LOG} inbound not relayed integration=${String(integration._id)} message=${String(message.id)}: `
      + 'claim store unavailable; the line is in the summary buffer only',
    );
    return { relayed: false };
  }

  const podId = String(integration.podId);
  // The claim is held from here on, and no other replica will write this line.
  // So a transient read failure would lose it for good: the author load is
  // read-only and retried. The write below is not — a retried write is the
  // duplicate the claim exists to prevent.
  let author: Awaited<ReturnType<typeof loadInboundAuthor>> = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      author = await loadInboundAuthor({
        podId,
        sender,
        logPrefix: LOG,
        // A shared channel gets no notice: the refusal is about one person's pod
        // membership, and everyone in the guild would read it.
        onNotMember: async () => {},
      });
      break;
    } catch (error) {
      if (attempt >= AUTHOR_LOAD_ATTEMPTS) {
        console.error(
          `${LOG} inbound not relayed integration=${String(integration._id)} message=${String(message.id)}: `
          + `author load failed ${AUTHOR_LOAD_ATTEMPTS} times: ${(error as Error).message}`,
        );
        return { relayed: false };
      }
    }
  }
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


// ---------------------------------------------------------------------------
// Outbound (F132) — agent message → the bound channel, by its webhook.
// ---------------------------------------------------------------------------

/** Discord rejects a message `content` longer than this. */
export const DISCORD_CONTENT_LIMIT = 2000;

// The channel webhook the install created, and nothing else: a legacy
// plaintext `config.webhookUrl` is a field a row has carried from a request
// body, so the URL must be Discord's own webhook endpoint before agent text is
// posted to it.
const DISCORD_WEBHOOK_URL = new RegExp(
  '^https://(?:(?:ptb|canary)\\.)?discord(?:app)?\\.com/api/(?:v\\d+/)?webhooks/\\d+/[\\w-]+$',
);

// Same proof as inbound: live relay was switched on by the person whose Discord
// account the install proved (`linkedUserId` is stamped from that caller, and
// liveRelayRefusal admits only the creator holding a `discordUserId`). A row
// that fails it was turned on some other way and stays silent.
// `connected` exactly: disconnect writes 'disconnected' and leaves isActive and
// liveRelay as they were, and a webhook whose delete failed still posts.
const isRelayableIntegration = (integration: DiscordIntegrationDoc, podId: string): boolean => (
  isGatedPodTarget(integration, podId)
  && integration.type === 'discord'
  && integration.isActive === true
  && integration.status === 'connected'
  && integration.config?.liveRelay === true
  && !integration.config?.adminPause
  && Boolean(integration.config?.serverId)
  && Boolean(integration.config?.channelId)
  && Boolean(integration.config?.discordUserId)
  && Boolean(integration.config?.linkedUserId)
  && String(integration.config?.linkedUserId) === idOf(integration.createdBy)
);

const findLiveIntegration = async (podId: string): Promise<DiscordIntegrationDoc | null> => (
  Integration.findOne({
    type: 'discord',
    isActive: true,
    status: 'connected',
    podId,
    'config.liveRelay': true,
    'config.channelId': { $exists: true, $ne: null },
    'config.adminPause': { $exists: false },
  }).lean()
);

// Bold and the other inline marks would let a display or pod name restyle the
// prefix, and brackets and parentheses would let `x](https://evil) [y` close
// the tag and open a masked link; a backslash makes each one literal.
const escapeDiscordMarkdown = (value: string): string => value.replace(/([\\*_~`|>[\]()])/g, '\\$1');

// `allowed_mentions` already stops every ping. This also keeps the words from
// reading as one: a zero-width space after the @ renders the same and is no
// longer the mass-mention token.
const defuseMassMentions = (value: string): string => value.replace(/@(everyone|here)/gi, '@​$1');

/** Cut to `limit` characters with an ellipsis, never leaving half a surrogate pair. */
const fitWithin = (value: string, limit: number): string => {
  if (value.length <= limit) return value;
  if (limit <= 1) return '…'.slice(0, Math.max(0, limit));
  let cut = value.slice(0, limit - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
};

// The pod read the send needs twice: its name for the tag, and its listed
// members, because the installer must still be one (F132 review). A failed
// read returns null and the send fails closed — the line stays in the pod.
const podForSend = async (podId: string): Promise<{ name?: string; members?: unknown[] } | null> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const Pod = require('../models/Pod');
    return await Pod.findById(podId).select('name members').lean();
  } catch (error) {
    console.warn(`${LOG} pod lookup failed, line not sent:`, (error as Error).message);
    return null;
  }
};

/** `[Pod] **Agent**: text`, the shape the Slack and Telegram lines take, in 2000 characters. */
export const renderDiscordAgentLine = (opts: { podName: string; name: string; content: string }): string => {
  const tag = defuseMassMentions(escapeDiscordMarkdown(opts.podName));
  const prefix = `[${tag}] **${defuseMassMentions(escapeDiscordMarkdown(opts.name))}**: `;
  return fitWithin(prefix + defuseMassMentions(String(opts.content || '')), DISCORD_CONTENT_LIMIT);
};

// Discord has no reply-to-rule path yet (no relayMap reader on inbound), so the
// card sends the reader to the pod rather than asking for a reply here. The
// link sits in angle brackets so Discord does not unfurl it.
export const renderDiscordDecisionCard = (opts: {
  card: DecisionRelayCard;
  name: string;
  link: string;
}): string => {
  const { card, name, link } = opts;
  const footer = `\nRule on it in Commonly → <${link}>`;
  const options = card.options.map((option, index) => {
    const description = option.description ? `\n   ${fitWithin(String(option.description), 100)}` : '';
    const star = option.recommended ? ' ★ recommended' : '';
    return `\n${index + 1}. **${escapeDiscordMarkdown(option.label)}**${star}${description}`;
  }).join('');
  const title = `**${escapeDiscordMarkdown(name)} needs a ruling · ${escapeDiscordMarkdown(card.title)}**`;
  const header = `${title}\n${card.question}`;
  const optionsBlock = fitWithin(defuseMassMentions(options), Math.floor(DISCORD_CONTENT_LIMIT / 2));
  const body = fitWithin(
    defuseMassMentions(header),
    DISCORD_CONTENT_LIMIT - footer.length - optionsBlock.length,
  );
  return body + optionsBlock + footer;
};

/** What a webhook send hands the core and `connectorDeliveryFailureService`. */
export interface DiscordDeliveryResult {
  provider: 'discord';
  delivered: boolean;
  httpStatus?: number;
  code?: number;
  messageId?: string;
  retryAfterMs?: number;
  /** Not sent: the webhook's lane is still cooling down from a 429, or its queue is full. */
  rateLimited?: boolean;
  queueFull?: boolean;
}

/**
 * The webhook's rate limit, about 5 messages per 2 seconds per webhook. Each
 * row's webhook gets one lane: its sends run one at a time, at least
 * `minIntervalMs` apart. A 429 waits out Discord's `retry_after` once and
 * retries; a longer wait is not taken inline — the lane cools down for it and
 * lines arriving meanwhile are dropped and logged, never retried in a loop.
 * Per process: each backend replica paces its own sends, and Discord's 429 is
 * the backstop between them.
 */
interface WebhookLane { tail: Promise<unknown>; nextAt: number; coolUntil: number; depth: number }
export const discordWebhookPacing = {
  minIntervalMs: 400,
  maxRetryWaitMs: 5_000,
  // Lines waiting on one webhook, the one in flight included. A burst beyond
  // this is dropped and logged rather than queued without bound.
  maxQueueDepth: 20,
  defaultRetryAfterMs: 1_000,
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); }),
  lanes: new Map<string, WebhookLane>(),
  reset(): void { this.lanes.clear(); },
};

const retryAfterMsOf = (response: { data?: Record<string, unknown>; headers?: Record<string, unknown> }): number => {
  const body = Number(response?.data?.retry_after);
  if (Number.isFinite(body) && body >= 0) return Math.ceil(body * 1000);
  const header = Number(response?.headers?.['retry-after']);
  if (Number.isFinite(header) && header >= 0) return Math.ceil(header * 1000);
  return discordWebhookPacing.defaultRetryAfterMs;
};

const postToWebhook = async (url: string, payload: Record<string, unknown>): Promise<DiscordDeliveryResult> => {
  const response = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10_000,
    validateStatus: () => true,
  });
  const status = Number(response?.status);
  const data = (response?.data || {}) as { id?: unknown; code?: unknown };
  if (status >= 200 && status < 300 && data.id) {
    return { provider: 'discord', delivered: true, httpStatus: status, messageId: String(data.id) };
  }
  return {
    provider: 'discord',
    delivered: false,
    httpStatus: status,
    ...(typeof data.code === 'number' ? { code: data.code } : {}),
    ...(status === 429 ? { retryAfterMs: retryAfterMsOf(response) } : {}),
  };
};

const sendThroughLane = (
  laneKey: string,
  url: string,
  payload: Record<string, unknown>,
): Promise<DiscordDeliveryResult> => {
  const pacing = discordWebhookPacing;
  let lane = pacing.lanes.get(laneKey);
  if (!lane) {
    lane = { tail: Promise.resolve(), nextAt: 0, coolUntil: 0, depth: 0 };
    pacing.lanes.set(laneKey, lane);
  }
  const current = lane;
  if (current.depth >= pacing.maxQueueDepth) {
    return Promise.resolve({
      provider: 'discord', delivered: false, httpStatus: 429, rateLimited: true, queueFull: true,
    });
  }
  current.depth += 1;
  const run = async (): Promise<DiscordDeliveryResult> => {
    if (pacing.now() < current.coolUntil) {
      return {
        provider: 'discord', delivered: false, httpStatus: 429, rateLimited: true,
        retryAfterMs: current.coolUntil - pacing.now(),
      };
    }
    const wait = current.nextAt - pacing.now();
    if (wait > 0) await pacing.sleep(wait);
    let result = await postToWebhook(url, payload);
    current.nextAt = pacing.now() + pacing.minIntervalMs;
    if (result.httpStatus === 429) {
      const backoff = result.retryAfterMs ?? pacing.defaultRetryAfterMs;
      if (backoff <= pacing.maxRetryWaitMs) {
        await pacing.sleep(backoff);
        result = await postToWebhook(url, payload);
        current.nextAt = pacing.now() + pacing.minIntervalMs;
      }
      if (result.httpStatus === 429) {
        current.coolUntil = pacing.now() + (result.retryAfterMs ?? pacing.defaultRetryAfterMs);
      }
    }
    return result;
  };
  const next = current.tail.then(run).finally(() => { current.depth -= 1; });
  current.tail = next.catch(() => undefined);
  return next;
};

const webhookUrlFor = async (integration: DiscordIntegrationDoc): Promise<string | null> => {
  let legacyPlatformUrl: unknown;
  if (!integration.config?.webhookUrlRef && !integration.config?.webhookUrl) {
    // Rows connected before the webhook URL was encrypted kept it on the
    // platform document; the migration script moves it into the ref.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const DiscordIntegration = require('../models/DiscordIntegration');
    const platform = await DiscordIntegration.findOne({ integrationId: integration._id }).select('webhookUrl').lean();
    legacyPlatformUrl = platform?.webhookUrl;
  }
  const url = await resolveDiscordWebhookUrl(
    integration.config?.webhookUrlRef,
    integration.config?.webhookUrl,
    legacyPlatformUrl,
  );
  if (!url || !DISCORD_WEBHOOK_URL.test(url)) return null;
  return url;
};

const withWait = (url: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set('wait', 'true');
  return parsed.toString();
};

export const discordRelayAdapter: ChatRelayAdapter<DiscordIntegrationDoc> = {
  provider: 'discord',
  relayMapKey: 'externalMessageId',
  // The OAuth install writes the row; there is no Installable projection.
  directRows: true,
  findLiveIntegration,
  isRelayableIntegration,
  send: async ({
    integration, podId, agentUsername, displayName, content, card, link,
  }: OutboundRelayOptions<DiscordIntegrationDoc> & { integration: DiscordIntegrationDoc; link: string }) => {
    const webhookUrl = await webhookUrlFor(integration);
    const chatId = integration.config?.channelId;
    if (!webhookUrl) {
      console.warn(`${LOG} outbound skipped integration=${String(integration._id)}: no Discord webhook on the row`);
      return null;
    }
    const pod = await podForSend(podId);
    if (!pod) return null;
    // The channel is the installer's and shared with their guild: once they
    // leave the pod, its agent lines stop going there (F132 review).
    if (!isListedPodMember(pod, integration.createdBy)) {
      console.warn(`${LOG} outbound skipped integration=${String(integration._id)}: the installer left the pod`);
      return null;
    }
    const name = displayName || agentUsername;
    const text = card
      ? renderDiscordDecisionCard({ card, name, link })
      : renderDiscordAgentLine({ podName: String(pod.name || podId), name, content });
    const result = await sendThroughLane(String(integration._id), withWait(webhookUrl), {
      content: text,
      // Agent text goes to everyone in the guild: no @everyone, @here, role or
      // user ping, whatever the text says.
      allowed_mentions: { parse: [] },
    });
    return { chatId, externalMessageId: result.delivered ? result.messageId || null : null, result };
  },
  deliveryFailureError: (result) => {
    const r = (result || {}) as DiscordDeliveryResult;
    if (r.rateLimited) {
      const why = r.queueFull ? 'queue full' : `cooling down after a 429, ${r.retryAfterMs}ms left`;
      return new Error(`webhook lane rate-limited (${why}); line dropped`);
    }
    const code = r.code !== undefined ? ` code ${r.code}` : '';
    return new Error(`webhook send failed: HTTP ${String(r.httpStatus)}${code}`);
  },
  logOutboundFailure: (error, opts) => {
    console.warn(
      `${LOG} outbound relay failed integration=${String(opts.integration?._id || 'lookup')} `
      + `channel=${String(opts.integration?.config?.channelId || 'unknown')}: ${error.message}`,
    );
  },
};

module.exports = {
  discordInboundAdapter,
  discordRelayAdapter,
  discordWebhookPacing,
  renderDiscordAgentLine,
  renderDiscordDecisionCard,
  DISCORD_CONTENT_LIMIT,
  isIgnoredDiscordMessage,
  renderDiscordInboundContent,
  relayDiscordMessageToPod,
  relayDiscordMessageForIntegration,
};
