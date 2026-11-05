import { emitNotConnectedLine, hasNotConnectedLineToday } from './systemActionLineService';
import { deriveAgentState } from './agentStateService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');

type NeverConnectedAgent = {
  _id: unknown; username?: string; profilePicture?: string | null;
  botMetadata?: { displayName?: string; instanceId?: string };
  agentRuntimeTokens?: Array<{ lastListenedAt?: Date | string | null }>;
};

/**
 * The agent's bot row when its active install in this pod has never polled
 * (`deriveAgentState` → `never-connected`), else null. The one derivation the
 * notice below and the wake fan-out (agentMentionService) both read.
 */
async function neverConnectedAgent({
  podId, agentName, instanceId, now = new Date(),
}: {
  podId: string; agentName: string; instanceId: string; now?: Date;
}): Promise<NeverConnectedAgent | null> {
  const install = await AgentInstallation.findOne({
    podId, agentName, instanceId, status: 'active',
  }).lean() as Record<string, unknown> | null;
  if (!install) return null;

  const agent = await User.findOne({
    isBot: true,
    'botMetadata.agentName': agentName,
    'botMetadata.instanceId': instanceId,
  }).select('username profilePicture botMetadata agentRuntimeTokens').lean() as NeverConnectedAgent | null;
  if (!agent) return null;

  const derived = deriveAgentState(
    install as Parameters<typeof deriveAgentState>[0],
    agent.agentRuntimeTokens || [],
    '',
    now.getTime(),
  );
  return derived.state === 'never-connected' ? agent : null;
}

/** Has this agent's install in this pod never connected? */
export async function isNeverConnectedAgent(args: {
  podId: string; agentName: string; instanceId: string; now?: Date;
}): Promise<boolean> {
  return Boolean(await neverConnectedAgent(args));
}

/**
 * TASK-655 item 3. A person @mentions a Bring your own agent that has never
 * polled. The mention still queues (it is delivered the moment the agent
 * connects), but the room now says so once, as a reply to the mention, so the
 * person is not left waiting on silence.
 *
 * ONE DERIVATION. "Never connected" is `deriveAgentState` returning
 * `never-connected`, the same verdict the Your Team row and the stalled-connect
 * nudge use. There is no second rule here.
 *
 * Silent when: the sender is a bot (agents do not get told they are unseen),
 * the install is not active, the agent is not in the never-connected state, or
 * a line for this agent already sits in the pod today.
 */
export async function noteNeverConnectedMention({
  podId,
  agentName,
  instanceId,
  senderId,
  messageId,
  threadRootId,
  now = new Date(),
}: {
  podId: string;
  agentName: string;
  instanceId: string;
  senderId: string;
  messageId: string | number | null;
  threadRootId?: string | number | null;
  now?: Date;
}): Promise<boolean> {
  const sender = await User.findById(senderId).select('isBot').lean() as { isBot?: boolean } | null;
  if (!sender || sender.isBot) return false;

  const agent = await neverConnectedAgent({ podId, agentName, instanceId, now });
  if (!agent) return false;

  const agentKey = `${agentName}:${instanceId}`;
  // The day check is read-then-insert, so two mentions racing in one process
  // (`@nova @nova`) would both pass it. An in-flight key closes that window;
  // across replicas the worst case stays one extra line, never a dropped mention.
  const flightKey = `${podId}:${agentKey}`;
  if (inFlight.has(flightKey)) return false;
  inFlight.add(flightKey);
  try {
    return await postOnce(podId, agentKey, agent, agentName, messageId, threadRootId, now);
  } finally {
    inFlight.delete(flightKey);
  }
}

const inFlight = new Set<string>();

async function postOnce(
  podId: string,
  agentKey: string,
  agent: { _id: unknown; username?: string; profilePicture?: string | null; botMetadata?: { displayName?: string; instanceId?: string } },
  agentName: string,
  messageId: string | number | null,
  threadRootId: string | number | null | undefined,
  now: Date,
): Promise<boolean> {
  if (await hasNotConnectedLineToday(podId, agentKey, now)) return false;

  await emitNotConnectedLine({
    podId,
    actorUserId: String(agent._id),
    actorUsername: agent.username || agentName,
    actorAvatarUrl: agent.profilePicture || null,
    actorIsBot: true,
    agentLabel: AgentIdentityService.resolveAgentDisplayLabel(agent, agentName),
    agentKey,
    messageId,
    threadRootId: threadRootId ?? null,
  });
  return true;
}
