import { emitNotConnectedLine, hasNotConnectedLineToday } from './systemActionLineService';
import { deriveAgentState } from './agentStateService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');

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

  const install = await AgentInstallation.findOne({
    podId, agentName, instanceId, status: 'active',
  }).lean() as Record<string, unknown> | null;
  if (!install) return false;

  const agent = await User.findOne({
    isBot: true,
    'botMetadata.agentName': agentName,
    'botMetadata.instanceId': instanceId,
  }).select('username profilePicture botMetadata agentRuntimeTokens').lean() as {
    _id: unknown; username?: string; profilePicture?: string | null;
    botMetadata?: { displayName?: string; instanceId?: string };
    agentRuntimeTokens?: Array<{ lastUsedAt?: Date | string | null }>;
  } | null;
  if (!agent) return false;

  const derived = deriveAgentState(
    install as Parameters<typeof deriveAgentState>[0],
    agent.agentRuntimeTokens || [],
    '',
    now.getTime(),
  );
  if (derived.state !== 'never-connected') return false;

  const agentKey = `${agentName}:${instanceId}`;
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
