/**
 * F390 part A: a person's ask never dies in silence.
 *
 * A person @mentions an agent that can't take the turn: it never connected, its
 * computer stopped checking in, its owner stopped it, or it has no turns left
 * today. The room already says so in one line (neverConnectedMentionService,
 * stoppedMentionService, the native runtime's turns-used line), but every live
 * agent then read the message as "not addressed to me", so nobody answered
 * (11-06 and 11-07 in My Workspace). This hands the same ask to the pod's host
 * agent as ADDRESSED to it, once per message, so the person gets an answer.
 *
 * Runtime-agnostic: the reasons come from deriveAgentState and the stop
 * timestamps, the same verdicts the notices read, and the host's event is an
 * ordinary chat.mention any driver already delivers.
 */
import { hostedStoppedAt } from './hostedEngine';
import { agentReach } from './neverConnectedMentionService';
import { approverFor } from './runRequestService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentEventService = require('./agentEventService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');

/** The agent that hosts a pod a person was given: the guide every signup gets. */
export const HOST_AGENT_NAME = 'scout';

export type CannotRunReason = 'never-connected' | 'offline' | 'stopped' | 'out-of-turns';

const REASON_TEXT: Record<CannotRunReason, string> = {
  'never-connected': 'it has never connected',
  offline: 'its computer has stopped checking in',
  stopped: 'its owner stopped it',
  'out-of-turns': 'it has no turns left today',
};

// Inline, not metadata: the host reads content. The room already carries the
// "can't answer" line, so the host answers the ask instead of repeating it.
export const handoffFrame = (label: string, reason: CannotRunReason): string => `[${label} can't answer this `
  + `right now (${REASON_TEXT[reason]}), and the room already says so. You are this pod's host and the person is `
  + 'waiting: answer them yourself if you can, or tell them plainly what to do next. This is addressed to you.]';

/**
 * Why this agent's install in this pod can't take a turn now, with the label
 * the room knows it by; null when it can, or when its state can't be read
 * (unknown never counts as unrunnable). Out of turns is decided at run time,
 * by the native runtime, and handed off from there.
 *
 * The same verdicts the notices read, from the same helpers: stopped as
 * noteStoppedMention resolves it (the effective install, so a projection
 * inherits its parent's stop), never connected and offline from agentReach.
 */
export async function cannotRunReason({
  podId, agentName, instanceId, now = new Date(),
}: {
  podId: string; agentName: string; instanceId: string; now?: Date;
}): Promise<{ reason: CannotRunReason; label: string } | null> {
  const name = String(agentName).toLowerCase();
  const id = instanceId || 'default';
  const effective = await AgentEventService.resolveEffectiveInstallation(name, id, podId) as Record<string, unknown> | null;
  if (effective && hostedStoppedAt(effective)) {
    const agent = await User.findOne({
      isBot: true, 'botMetadata.agentName': name, 'botMetadata.instanceId': id,
    }).select('username botMetadata').lean() as {
      username?: string; botMetadata?: { displayName?: string; instanceId?: string; machineId?: unknown };
    } | null;
    // As the stopped line reads it: a daemon seat sharing the identity is still up.
    if (agent && !agent.botMetadata?.machineId) {
      return { reason: 'stopped', label: AgentIdentityService.resolveAgentDisplayLabel(agent, name) };
    }
  }
  const reach = await agentReach({ podId, agentName: name, instanceId: id, now });
  if (!reach) return null;
  const label = AgentIdentityService.resolveAgentDisplayLabel(reach.agent, name);
  if (reach.state === 'never-connected') return { reason: 'never-connected', label };
  if (reach.state === 'gone-dark') return { reason: 'offline', label };
  return null;
}

type HostInstall = { agentName: string; instanceId: string; installedBy?: unknown; config?: unknown };

/**
 * The pod's active host install, or null. Several people's guides can share a
 * pod; the asker's own comes first, then the lowest instanceId, so the pick
 * never depends on index order.
 */
export async function hostInstallFor(podId: string, askerId?: string): Promise<HostInstall | null> {
  const hosts = await AgentInstallation.find({
    podId, agentName: HOST_AGENT_NAME, status: 'active',
  }).select('agentName instanceId installedBy config').lean() as Array<Record<string, unknown>> | null;
  if (!hosts?.length) return null;
  const ordered = [...hosts].sort((a, b) => String(a.instanceId || 'default').localeCompare(String(b.instanceId || 'default')));
  const host = ordered.find((h) => askerId && String(h.installedBy || '') === askerId) || ordered[0];
  return {
    agentName: HOST_AGENT_NAME,
    instanceId: String(host.instanceId || 'default'),
    installedBy: host.installedBy,
    config: host.config,
  };
}

// One hand-off per message: two unrunnable agents in one message are one ask.
const handedOff = new Map<string, number>();
const HANDOFF_MEMORY_MS = 10 * 60 * 1000;

const firstHandoff = (key: string, nowMs: number): boolean => {
  for (const [stored, at] of handedOff) if (nowMs - at > HANDOFF_MEMORY_MS) handedOff.delete(stored);
  if (handedOff.has(key)) return false;
  handedOff.set(key, nowMs);
  return true;
};

/**
 * Enqueue the person's ask to the pod's host as addressed. Returns the host's
 * key when it was handed off, null when there is no host, the host is the
 * agent that can't run, or this message was already handed off.
 *
 * `payload` is the mention payload the addressed agent got (or would have):
 * the person's words, ids and thread. `content` is the host's framed copy.
 */
export async function handOffToHost({
  podId, from, label, reason, payload, sender, excludeKeys, now = new Date(),
}: {
  podId: string;
  from: { agentName: string; instanceId?: string };
  label: string;
  reason: CannotRunReason;
  payload: Record<string, unknown>;
  // The person asking. The host is skipped when its owner asks first (F371):
  // an unrunnable agent is no way around that.
  sender: { isBot?: boolean; botMetadata?: unknown } | null;
  // Agents this message already reached or held for their owner.
  excludeKeys?: Set<string>;
  now?: Date;
}): Promise<string | null> {
  const messageId = payload.messageId ? String(payload.messageId) : '';
  const askerId = payload.userId ? String(payload.userId) : '';
  if (!messageId || !askerId || sender?.isBot !== false) return null;
  const host = await hostInstallFor(podId, askerId);
  if (!host) return null;
  const fromKey = `${String(from.agentName).toLowerCase()}:${String(from.instanceId || 'default').toLowerCase()}`;
  const hostKey = `${host.agentName}:${host.instanceId.toLowerCase()}`;
  if (fromKey === hostKey || excludeKeys?.has(hostKey)) return null;
  if (await approverFor(host as Parameters<typeof approverFor>[0], sender as Parameters<typeof approverFor>[1], askerId)) {
    return null;
  }
  if (!firstHandoff(`${podId}:${messageId}`, now.getTime())) return null;
  const first = typeof payload.rawContent === 'string' ? payload.rawContent : String(payload.content || '');
  // A joined row carries the person's later messages; the host gets them all.
  const joined = (Array.isArray(payload.coalesced) ? payload.coalesced : []) as Array<Record<string, unknown>>;
  const words = [first, ...joined
    .filter((entry) => !entry.notAnAsk && typeof entry.rawContent === 'string')
    .map((entry) => String(entry.rawContent))].join('\n\n');
  // How the ask reached the first agent says nothing about the host: drop the
  // edges and joined rows so the host's row reads as a plain ask of its own.
  const {
    implicitReply: _implicit, adjacentReply: _adjacent, coalesced: _coalesced, replyToMessageId: _replyTo,
    handoffCue: _cue, ...ask
  } = payload;
  await AgentEventService.enqueue({
    agentName: host.agentName,
    instanceId: host.instanceId,
    podId,
    type: 'chat.mention',
    payload: {
      ...ask,
      content: `${handoffFrame(label, reason)}\n${words}`,
      rawContent: words,
      // The person named another agent; this ask is the host's now.
      mentions: [],
      addressed: true,
      handoffFrom: fromKey,
      handoffReason: reason,
    },
  });
  return hostKey;
}

/** Test seam: forget which messages were handed off. */
export const resetHandoffsForTest = (): void => { handedOff.clear(); };
