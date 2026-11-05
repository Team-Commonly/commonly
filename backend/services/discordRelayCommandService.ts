// Discord bridge commands (D249, F133): /mode /status /mute /unmute /tldr
// /summary /help, the same commands a Telegram chat has, as Discord
// application commands.
//
// They arrive on the HTTP interactions endpoint (routes/discord.ts), which
// verifies Discord's Ed25519 signature before anything here runs. What a
// command MEANS — the mode flag, the mute window, the status read, and the rule
// that a settings write needs proven authority — is the shared chat-relay
// core's (chatRelay/chatRelayCore). What stays here is what only Discord knows:
//
//   - a guild channel is a SHARED surface, so the core's authority gate is fed
//     a proof: the caller's Discord id must be the row's `config.discordUserId`,
//     the installer the OAuth callback proved with `users/@me` (F131). That is
//     the same person the Connectors toggle and the PATCH admit;
//   - a command acts only on rows bound to the guild AND channel it was typed
//     in, never on another channel's or another pod's row;
//   - replies are interaction responses: settings and reads that concern one
//     person are ephemeral (flags 64); /tldr posts to the channel and can ping
//     no one (`allowed_mentions: { parse: [] }`, markdown escaped);
//   - Discord's 3-second deadline: /summary generates, so it defers (type 5)
//     and edits the deferred reply when the work is done.

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const axios = require('axios');
import { applyRelayCommand, parseRelayCommand } from './chatRelay/chatRelayCore';
import type { RelayCommandOutcome } from './chatRelay/chatRelayCore';
import {
  DISCORD_CONTENT_LIMIT, defuseMassMentions, escapeDiscordMarkdown, fitWithin,
} from './discordBridgeService';
import DISCORD_APPLICATION_COMMANDS from '../config/discordApplicationCommands.json';

const LOG = '[discord-commands]';
const EPHEMERAL = 64;
const NO_MENTIONS = { parse: [] as string[] };

/** The bridge commands this module answers; the rest of the set is legacy. */
export const DISCORD_RELAY_COMMAND_NAMES = ['mode', 'status', 'mute', 'unmute', 'tldr', 'summary', 'help'] as const;
const RELAY_COMMANDS = new Set<string>(DISCORD_RELAY_COMMAND_NAMES);

/** The full set registered with Discord, bridge and legacy, in one bulk overwrite. */
export const discordApplicationCommands = (): Array<{ name: string }> => DISCORD_APPLICATION_COMMANDS;

export const isDiscordRelayCommand = (name: unknown): boolean => RELAY_COMMANDS.has(String(name || ''));

export interface DiscordInteraction {
  type?: number;
  id?: string;
  token?: string;
  application_id?: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id?: string } } | null;
  user?: { id?: string } | null;
  data?: { name?: string; options?: Array<{ name?: string; value?: unknown }> };
}

export interface DiscordCommandRow {
  _id: unknown;
  podId?: unknown;
  createdBy?: unknown;
  status?: string;
  isActive?: boolean;
  config?: {
    serverId?: string;
    channelId?: string;
    discordUserId?: string;
    liveRelay?: boolean;
    relayAllAgentMessages?: boolean;
    relayMutedUntil?: Date | string;
    leadAgentUsername?: string;
    adminPause?: unknown;
    webhookListenerEnabled?: boolean;
    [key: string]: unknown;
  };
}

export interface InteractionReply {
  type: number;
  data?: { content?: string; flags?: number; allowed_mentions?: { parse: string[] } };
}

export interface DiscordCommandHandled {
  /** The HTTP body for Discord's 3-second window. */
  response: InteractionReply;
  /** Work that runs after the response is sent (a deferred reply's edit). */
  after?: () => Promise<void>;
}

const reply = (content: string, opts: { ephemeral?: boolean } = {}): InteractionReply => ({
  type: 4,
  data: {
    content: fitWithin(content, DISCORD_CONTENT_LIMIT),
    flags: opts.ephemeral === false ? 0 : EPHEMERAL,
    allowed_mentions: NO_MENTIONS,
  },
});

/** The Discord user who typed the command: `member.user` in a guild, `user` in a DM. */
export const interactionActorId = (interaction: DiscordInteraction): string => String(
  interaction.member?.user?.id || interaction.user?.id || '',
);

/** The row binds exactly the guild and channel the command was typed in. */
export const isBoundToChannel = (row: DiscordCommandRow, guildId: string, channelId: string): boolean => (
  Boolean(guildId) && Boolean(channelId)
  && String(row.config?.serverId || '') === guildId
  && String(row.config?.channelId || '') === channelId
);

/**
 * May this Discord user change the row's relay settings? Only the person who
 * added the bot, matched by the Discord id the install proved — the same
 * person the Connectors toggle and the PATCH admit. A row without a proven id
 * admits no one: there is nothing to match a caller against.
 */
export const mayChangeRelaySettings = (row: DiscordCommandRow, actorId: string): boolean => (
  Boolean(actorId) && Boolean(row.config?.discordUserId) && String(row.config?.discordUserId) === actorId
);

const optionValue = (interaction: DiscordInteraction, name: string): string | undefined => {
  const option = (interaction.data?.options || []).find((o) => o?.name === name);
  return option?.value === undefined || option.value === null ? undefined : String(option.value);
};

const NOT_CONNECTED = "This channel isn't connected to a Commonly pod. Connect it from the pod's Connectors page.";

const HELP_TEXT = [
  '**Commonly commands for this channel**',
  '/mode: show the relay mode, or switch it to mirror or attention',
  '  • mirror: every agent message in the pod is copied here',
  '  • attention: only escalations and the lead agent reach this channel',
  '/status: pod, mode, and mute state for this channel',
  '/mute [30m | 2h]: pause relay here (default 60 minutes); /unmute to resume',
  '/tldr: post the pod\'s latest summary here',
  '/summary: summarize recent chat here into the pod',
  'Only the person who connected this channel can change mode or mute.',
].join('\n');

const refusalFor = (row: DiscordCommandRow): string => (
  row.config?.discordUserId
    ? `Only <@${row.config.discordUserId}>, who connected this channel to Commonly, can change its relay settings.`
    : 'Only the person who connected this channel to Commonly can change its relay settings, and this connection '
      + "doesn't record their Discord account. They can reconnect it from Commonly to fix that."
);

const relayStateOf = (row: DiscordCommandRow): string => {
  if (!row.config?.liveRelay) return 'off';
  if (row.status !== 'connected') return `on, but the connection is ${row.status || 'not connected'}`;
  return 'on';
};

/** A Discord timestamp tag: each reader sees it in their own time zone. */
const discordTime = (at: Date): string => `<t:${Math.floor(at.getTime() / 1000)}:t>`;

/** Discord's words for one row's outcome. Plain text; the caller adds the pod tag. */
const discordCommandReply = (outcome: RelayCommandOutcome, row: DiscordCommandRow, podName: string): string => {
  switch (outcome.kind) {
    case 'help':
      return HELP_TEXT;
    case 'not-linked':
      return NOT_CONNECTED;
    case 'refused':
      return refusalFor(row);
    case 'mode-show':
      return `Relay mode: **${outcome.mode}**. Switch with /mode mirror or /mode attention.`;
    case 'mode-usage':
      return 'Usage: /mode mirror or /mode attention';
    case 'mode-set':
      return outcome.mode === 'mirror'
        ? 'Mode: **mirror**. Every agent message in the pod is copied here.'
        : 'Mode: **attention**. Only escalations and the lead agent reach this channel.';
    case 'mute':
      return `Muted for ${outcome.minutes} min. Nothing relays here until ${discordTime(outcome.until)}. `
        + '/unmute to resume.';
    case 'unmute':
      return 'Unmuted. Relay resumes.';
    case 'status': {
      const muted = outcome.mutedUntil
        ? `muted until ${discordTime(outcome.mutedUntil)}`
        : 'not muted';
      return [
        `Pod: **${escapeDiscordMarkdown(podName)}**`,
        `Mode: **${outcome.mode}** · Relay: ${relayStateOf(row)} · ${muted}`,
        outcome.lead ? `Lead agent: ${escapeDiscordMarkdown(outcome.lead)}` : null,
      ].filter(Boolean).join('\n');
    }
    default:
      return HELP_TEXT;
  }
};

const podNameOf = async (row: DiscordCommandRow): Promise<string> => {
  try {
    const pod = await Pod.findById(row.podId).select('name').lean();
    return String(pod?.name || row.podId || 'unknown');
  } catch {
    return String(row.podId || 'unknown');
  }
};

// Several pods can share one channel; each answer then says which pod it is.
const joinPerPod = (blocks: Array<{ podName: string; text: string }>): string => (
  blocks.length === 1
    ? blocks[0].text
    : blocks
      .map(({ podName, text }) => `**${escapeDiscordMarkdown(defuseMassMentions(podName))}**\n${text}`)
      .join('\n\n')
);

/** The rows bound to the channel the command came from. Every row is re-checked, not just queried. */
export const findBoundRows = async (guildId: string, channelId: string): Promise<DiscordCommandRow[]> => {
  if (!guildId || !channelId) return [];
  const rows = await Integration.find({
    type: 'discord',
    isActive: true,
    'config.serverId': guildId,
    'config.channelId': channelId,
    'config.adminPause': { $exists: false },
  }).lean() as DiscordCommandRow[] | null;
  return (rows || []).filter((row) => isBoundToChannel(row, guildId, channelId));
};

const runSettingsCommand = async (
  interaction: DiscordInteraction,
  rows: DiscordCommandRow[],
): Promise<InteractionReply> => {
  const name = String(interaction.data?.name);
  const arg = name === 'mode' ? optionValue(interaction, 'mode') : optionValue(interaction, 'duration');
  const command = parseRelayCommand(name, arg);
  if (!command) return reply(HELP_TEXT);
  const actorId = interactionActorId(interaction);
  const blocks = await Promise.all(rows.map(async (row) => {
    const outcome = applyRelayCommand(command, row, new Date(), {
      mayChangeSettings: mayChangeRelaySettings(row, actorId),
    });
    if ('update' in outcome) await Integration.findByIdAndUpdate(row._id, outcome.update);
    const podName = await podNameOf(row);
    return { podName, text: discordCommandReply(outcome, row, podName) };
  }));
  return reply(joinPerPod(blocks));
};

/** The /tldr text: the summary's title, then its body, the way Telegram sends it. */
export const renderDiscordTldr = (summary: { title?: string; content?: string }): string => {
  const title = defuseMassMentions(escapeDiscordMarkdown(String(summary.title || 'Pod Summary')));
  const body = defuseMassMentions(escapeDiscordMarkdown(String(summary.content || '')));
  return `**${title}**\n\n${body}`;
};

const runTldr = async (rows: DiscordCommandRow[]): Promise<InteractionReply> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const DiscordCommandService = require('./discordCommandService');
  const results = await Promise.all(rows.map(async (row) => ({
    row,
    podName: await podNameOf(row),
    found: await DiscordCommandService.latestPodSummaryFor(row) as
      { kind: 'refused' } | { kind: 'none' } | { kind: 'summary'; summary: { title?: string; content?: string } },
  })));
  const shared = results.filter((r) => r.found.kind === 'summary');
  if (!shared.length) {
    const refused = results.some((r) => r.found.kind === 'refused');
    return reply(refused
      ? "Only the pod's creator can share this pod's summary with a channel. Ask them to reconnect it."
      : '📝 No recent pod summaries available yet.');
  }
  const blocks = shared.map((r) => ({
    podName: r.podName,
    text: renderDiscordTldr((r.found as { summary: { title?: string; content?: string } }).summary),
  }));
  return reply(joinPerPod(blocks), { ephemeral: false });
};

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const INTERACTION_TOKEN = /^[A-Za-z0-9_.-]{1,512}$/;

// Edit the deferred reply. The interaction token is the credential, so the URL
// carries no bot token; the application id comes from config.
const editDeferredReply = async (interaction: DiscordInteraction, content: string): Promise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const config = require('../config/discord');
  const applicationId = String(interaction.application_id || config.applicationId || '');
  const token = String(interaction.token || '');
  // Both come from a signed payload, but they are still path segments: pin
  // them to Discord's shapes so the request can only reach this endpoint.
  if (!DISCORD_SNOWFLAKE.test(applicationId) || !INTERACTION_TOKEN.test(token)) return;
  await axios.patch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}/messages/@original`,
    { content: fitWithin(content, DISCORD_CONTENT_LIMIT), allowed_mentions: NO_MENTIONS },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10_000 },
  );
};

// /summary: the channel's buffered chat → a summary → Commonly Bot in the pod,
// the path `/discord-push` has always taken. It calls the summarizer, so it
// cannot promise Discord's 3 seconds and answers by deferring.
const deferSummary = (interaction: DiscordInteraction, rows: DiscordCommandRow[]): DiscordCommandHandled => ({
  response: { type: 5, data: { flags: EPHEMERAL } },
  after: async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { runCommandForIntegration } = require('./discordMultiCommandService');
    const blocks = await Promise.all(rows.map(async (row) => {
      const podName = await podNameOf(row);
      if (!row.config?.webhookListenerEnabled) {
        return {
          podName,
          text: 'Channel sync is off for this channel, so there is nothing buffered to summarize. '
            + 'Turn it on with /discord-enable.',
        };
      }
      try {
        const { result } = await runCommandForIntegration({ commandName: 'discord-push', integration: row });
        return { podName, text: String(result?.content || '❌ The summary did not run.') };
      } catch (error) {
        console.warn(`${LOG} /summary failed integration=${String(row._id)}: ${(error as Error).message}`);
        return { podName, text: '❌ The summary did not run. Try again shortly.' };
      }
    }));
    await editDeferredReply(interaction, joinPerPod(blocks));
  },
});

/**
 * One bridge command → its interaction response. Only for names
 * `isDiscordRelayCommand` accepts; the route keeps every other name.
 */
export const handleDiscordRelayCommand = async (interaction: DiscordInteraction): Promise<DiscordCommandHandled> => {
  const name = String(interaction.data?.name || '');
  if (name === 'help') return { response: reply(HELP_TEXT) };
  const guildId = String(interaction.guild_id || '');
  const channelId = String(interaction.channel_id || '');
  const rows = await findBoundRows(guildId, channelId);
  if (!rows.length) return { response: reply(NOT_CONNECTED) };
  if (name === 'tldr') return { response: await runTldr(rows) };
  if (name === 'summary') return deferSummary(interaction, rows);
  return { response: await runSettingsCommand(interaction, rows) };
};

module.exports = {
  DISCORD_RELAY_COMMAND_NAMES,
  discordApplicationCommands,
  isDiscordRelayCommand,
  interactionActorId,
  isBoundToChannel,
  mayChangeRelaySettings,
  findBoundRows,
  renderDiscordTldr,
  handleDiscordRelayCommand,
};
