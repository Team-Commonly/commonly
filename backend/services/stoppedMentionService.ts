import {
  emitPausedLine, emitRemovedLine, emitStoppedLine, hasPausedLineSince, hasRemovedLineSince, hasStoppedLineSince,
} from './systemActionLineService';
import { hostedStoppedAt } from './hostedEngine';
import { IDENTITY_COLLATION, installationIdentityFilter } from './agentInstallationIdentity';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');

/**
 * When this install was stopped, or null while it can run. Hosted is the only
 * runtime that stops today; another one that can adds itself here, and the line
 * below reaches it with no other change.
 */
const stoppedSince = (installation: Record<string, unknown>): Date | null => hostedStoppedAt(installation);

const inFlight = new Set<string>();

interface AgentRow {
  _id: unknown;
  username?: string;
  profilePicture?: string | null;
  botMetadata?: { displayName?: string; instanceId?: string; machineId?: unknown };
}

const findAgent = (agentName: string, instanceId: string): Promise<AgentRow | null> => User.findOne({
  isBot: true,
  'botMetadata.agentName': { $eq: agentName },
  'botMetadata.instanceId': { $eq: instanceId },
}).select('username profilePicture botMetadata').lean();

const startOfUtcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * F297. A person addressed an agent its owner stopped. This tells the room once,
 * as a reply to the message, and promises nothing: the wake stays queued, and
 * Start runs it only while it's recent. Silent when the agent is running, when a
 * daemon seat shares the identity (that seat is still up), when a line is already
 * there, or for a comment on a post, which has no chat message to answer. The
 * caller checks the sender is a person: agents don't get told.
 *
 * Once since midnight UTC or the stop, whichever is later, so a mention days
 * after the last line isn't met with silence, and neither is a second stop.
 */
export async function noteStoppedMention({
  podId, agentName: rawAgentName, instanceId, messageId, threadRootId, now = new Date(),
}: {
  podId: string;
  agentName: string;
  instanceId: string;
  messageId: string | number | null;
  threadRootId?: string | number | null;
  now?: Date;
}): Promise<boolean> {
  if (messageId === null) return false;
  const agentName = rawAgentName.toLowerCase();
  // As routing sees it: a projection with no runtime of its own never gets the
  // stop written on it, and reads as stopped through the row it inherits from.
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentEventService = require('./agentEventService') as {
    resolveEffectiveInstallation: (
      agentName: string, instanceId: string, podId: string,
    ) => Promise<Record<string, unknown> | null>;
  };
  const install = await AgentEventService.resolveEffectiveInstallation(agentName, instanceId, podId);
  const stoppedAt = install ? stoppedSince(install) : null;
  if (!stoppedAt) return false;

  const agent = await findAgent(agentName, instanceId);
  if (!agent || agent.botMetadata?.machineId) return false;

  const agentKey = `${agentName}:${instanceId}`;
  // The check is read-then-insert, so `@nova @nova` could pass it twice. Across
  // replicas the worst case stays one extra line, never a dropped mention.
  const flightKey = `${podId}:${agentKey}`;
  if (inFlight.has(flightKey)) return false;
  inFlight.add(flightKey);
  try {
    const midnight = startOfUtcDay(now);
    const since = stoppedAt > midnight ? stoppedAt : midnight;
    if (await hasStoppedLineSince(podId, agentKey, since)) return false;
    await emitStoppedLine({
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
  } finally {
    inFlight.delete(flightKey);
  }
}

/**
 * F270. A person wrote in a DM with an agent that has no active install left.
 * Nothing will read the message and no wake waits for it, so the room says so,
 * once a UTC day, and says only what every row bears out: removed when they're
 * all uninstalled, paused when the only others are paused. An error or stale row
 * stays quiet, and so does an active one the caller's exact-match query missed,
 * with no instanceId or a stored name in another case. The caller checks the
 * sender is a person.
 */
export async function noteUnreachableAgentDm({
  podId, agentName: rawAgentName, instanceId, messageId, threadRootId, now = new Date(),
}: {
  podId: string;
  agentName: string;
  instanceId: string;
  messageId: string | number | null;
  threadRootId?: string | number | null;
  now?: Date;
}): Promise<boolean> {
  if (messageId === null) return false;
  const agentName = rawAgentName.toLowerCase();
  const statuses: string[] = await AgentInstallation.distinct('status', {
    ...installationIdentityFilter(agentName, instanceId),
    agentName: { $in: AgentIdentityService.identityNames(agentName) },
  }).collation(IDENTITY_COLLATION);
  const live = statuses.filter((status) => status !== 'uninstalled');
  if (live.some((status) => status !== 'paused')) return false;
  const paused = live.length > 0;
  const agent = await findAgent(agentName, instanceId);
  if (!agent) return false;

  const agentKey = `${agentName}:${instanceId}`;
  const flightKey = `${paused ? 'paused' : 'removed'}:${podId}:${agentKey}`;
  if (inFlight.has(flightKey)) return false;
  inFlight.add(flightKey);
  try {
    const hasLineSince = paused ? hasPausedLineSince : hasRemovedLineSince;
    if (await hasLineSince(podId, agentKey, startOfUtcDay(now))) return false;
    await (paused ? emitPausedLine : emitRemovedLine)({
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
  } finally {
    inFlight.delete(flightKey);
  }
}
