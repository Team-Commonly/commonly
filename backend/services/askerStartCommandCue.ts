/**
 * The start command for the asker's own agent, inline in Scout's turn (F46).
 *
 * A person set up a Bring your own agent, copied only the MCP snippet, and
 * asked Scout something a few minutes later. Scout answered without the
 * command that starts the agent, and the person never came back. Scout could
 * not have known: nothing in its turn said the asker's agent had never run.
 *
 * Built from state, never from what the person wrote. The asker's own active
 * installs are judged by `deriveAgentState`, the one never-connected rule the
 * roster, the stalled-connect nudge and the mention line share, and the command
 * is that derivation's `fixCommand`, the same text the nudge gives. Only this
 * pod's installs count, except in the asker's 1:1 room with Scout, where no one
 * else reads the reply, so their installs anywhere do.
 *
 * Inline, not metadata: a native turn is [system, user], and a cue the model
 * must act on goes in the text it reads (the payload.content rule).
 */
import mongoose from 'mongoose';
import { classifyRuntime, deriveAgentState } from './agentStateService';
import { CLI_INSTALL } from './byoHandoffService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');

// Enough for anyone mid-setup; more would crowd out what they asked.
const MAX_AGENTS = 3;
const INSTALLS_READ = 20;

interface NeverConnectedAgent { displayName: string; fixCommand: string }

type InstallRow = Parameters<typeof deriveAgentState>[0] & { agentName: string; instanceId?: string };
type BotRow = {
  botMetadata?: { agentName?: string; instanceId?: string };
  agentRuntimeTokens?: Array<{ lastListenedAt?: Date | string | null }>;
};

const keyOf = (agentName: unknown, instanceId: unknown): string => (
  `${String(agentName || '').toLowerCase()}:${String(instanceId || 'default')}`
);

async function askerNeverConnectedAgents(podId: string, askerId: string): Promise<NeverConnectedAgent[]> {
  if (!mongoose.isValidObjectId(podId) || !mongoose.isValidObjectId(askerId)) return [];
  const asker = await User.findById(askerId).select('isBot').lean() as { isBot?: boolean } | null;
  if (!asker || asker.isBot) return [];

  const pod = await Pod.findById(podId).select('type').lean() as { type?: string } | null;
  if (!pod) return [];
  const where = pod.type === 'agent-room' ? {} : { podId };
  const installs = await AgentInstallation.find({ installedBy: askerId, status: 'active', ...where })
    .select('agentName instanceId displayName installedBy config runtimeTokens.lastListenedAt')
    .sort({ _id: -1 })
    .limit(INSTALLS_READ)
    .lean() as InstallRow[];
  // Only a Bring your own agent can be never-connected. Scout's own install is
  // native, so most turns stop here, before the bot read.
  const byo = installs.filter((i) => classifyRuntime(i).isByo);
  if (byo.length === 0) return [];

  // The bot row by its username (indexed), resolved the way the identity
  // service names it, so a legacy agentName still finds its row.
  const identity = (i: InstallRow) => {
    const agentType = AgentIdentityService.resolveAgentType(i.agentName) as string;
    const instanceId = i.instanceId || 'default';
    return {
      key: keyOf(agentType, instanceId),
      username: AgentIdentityService.buildAgentUsername(agentType, instanceId) as string,
    };
  };
  const bots = await User.find({ isBot: true, username: { $in: byo.map((i) => identity(i).username) } })
    .select('botMetadata.agentName botMetadata.instanceId agentRuntimeTokens.lastListenedAt')
    .lean() as BotRow[];
  // The username is not injective, so the row is matched on its metadata too.
  const tokensByKey = new Map(bots.map((b) => [
    keyOf(b.botMetadata?.agentName, b.botMetadata?.instanceId), b.agentRuntimeTokens || [],
  ]));

  const seen = new Set<string>();
  const agents: NeverConnectedAgent[] = [];
  for (const i of byo) {
    const { key } = identity(i);
    if (seen.has(key)) continue;
    seen.add(key);
    const derived = deriveAgentState(i, tokensByKey.get(key) || [], askerId);
    if (derived.state !== 'never-connected' || !derived.fixCommand) continue;
    agents.push({ displayName: derived.displayName, fixCommand: derived.fixCommand });
    if (agents.length === MAX_AGENTS) break;
  }
  return agents;
}

// A display name is free text the owner typed: one line, clipped, quoted.
const quoted = (name: string): string => JSON.stringify(name.replace(/\s+/g, ' ').trim().slice(0, 60));

export function formatStartCommandCue(agents: NeverConnectedAgent[]): string {
  if (agents.length === 0) return '';
  const names = agents.map((a) => quoted(a.displayName)).join(', ');
  const one = agents.length === 1;
  // The listener command on the Bring your own page, with its two values left
  // for the page: a bare run line fails with "No token" on a machine that only
  // ever had the MCP snippet. The server never learns the adapter either.
  const listener = [
    CLI_INSTALL,
    'export COMMONLY_API_URL=<from that page>',
    'export COMMONLY_AGENT_TOKEN=<from that page>',
    ...agents.map((a) => `${a.fixCommand} --adapter <as on that page>`),
  ].join('\n');
  // Scout wakes on every message in a workspace and may stay silent, so this
  // note shapes a reply it was going to send. It never asks for one.
  return `[Their own agent has never connected] The person writing to you set up ${names}, `
    + `and ${one ? 'it has' : 'they have'} never connected, so ${one ? 'it cannot' : 'they cannot'} answer anyone yet. `
    + 'This note is not a reason to reply. If you reply to them this turn, include how to start it: in a Terminal '
    + 'on a Mac, they run the listener command from the agent\'s Bring your own page, which installs the CLI, sets '
    + 'the agent\'s token and starts it. Show its shape in a code block:\n'
    + `${listener}\n`
    + 'Tell them to copy the real one from that page, with the values filled in, and never to paste a token here. '
    + 'The MCP snippet alone lets a client call Commonly, but it does not start the agent or answer @mentions. '
    + 'If you already gave this in this conversation, repeat only the last line.';
}

/** The cue for this turn, or '' when the asker has no never-connected agent. */
export async function askerStartCommandCue(podId: string, askerId: string): Promise<string> {
  return formatStartCommandCue(await askerNeverConnectedAgents(podId, askerId));
}
