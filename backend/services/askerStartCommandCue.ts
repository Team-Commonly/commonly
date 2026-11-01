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
import { deriveAgentState } from './agentStateService';
import { CLI_INSTALL } from './byoHandoffService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');

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
  if (installs.length === 0) return [];

  const bots = await User.find({
    isBot: true,
    $or: installs.map((i) => ({
      'botMetadata.agentName': i.agentName, 'botMetadata.instanceId': i.instanceId || 'default',
    })),
  }).select('botMetadata.agentName botMetadata.instanceId agentRuntimeTokens.lastListenedAt').lean() as BotRow[];
  const tokensByKey = new Map(bots.map((b) => [
    keyOf(b.botMetadata?.agentName, b.botMetadata?.instanceId), b.agentRuntimeTokens || [],
  ]));

  const seen = new Set<string>();
  const agents: NeverConnectedAgent[] = [];
  for (const i of installs) {
    const key = keyOf(i.agentName, i.instanceId);
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
  const commands = [CLI_INSTALL, ...agents.map((a) => a.fixCommand)].join('\n');
  return `[Their own agent has never connected] The person writing to you set up ${names}, `
    + `and ${one ? 'it has' : 'they have'} never connected, so ${one ? 'it cannot' : 'they cannot'} answer anyone yet. `
    + 'Answer what they asked, and in the same reply give them the start command in a code block, exactly as written:\n'
    + `${commands}\n`
    + 'Tell them to run it in a Terminal on a Mac, and to copy the full listener command from the agent\'s '
    + 'Bring your own page, which carries its token. Never ask for a token here. The MCP snippet alone lets a '
    + 'client call Commonly, but it does not start the agent or answer @mentions. If you already gave this '
    + 'command in this conversation, repeat only the run line.';
}

/** The cue for this turn, or '' when the asker has no never-connected agent. */
export async function askerStartCommandCue(podId: string, askerId: string): Promise<string> {
  return formatStartCommandCue(await askerNeverConnectedAgents(podId, askerId));
}
