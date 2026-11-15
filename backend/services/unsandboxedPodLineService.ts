/**
 * A Bring your own agent its owner started without a sandbox (`--unsandboxed`,
 * D245: Codex on native Windows, or on Linux where bubblewrap can't start)
 * answers only while every pod it is in is invite-only and neither publicly
 * readable nor listed (cli/src/lib/workspace-trust.js podIsConfirmedPrivate).
 * Once a pod stops qualifying, the CLI refuses each turn and the events wait,
 * but the agent keeps polling, so it reads as connected and nothing else would
 * say why it is silent. This says it in the pod:
 *
 * - once, when the pod's owner changes a setting that takes it out of
 *   qualifying, for each such agent in it;
 * - on a person's @mention of such an agent in a pod that doesn't qualify, at
 *   most once per agent per UTC day, as a reply to the mention.
 *
 * The signal is `botMetadata.hostUnconfined`, which `/host-unconfined` sets
 * when an unconfined run starts. Only the owner's `commonly agent
 * clear-unsandboxed` clears it (routes/registry/agent-tokens.ts), not a later
 * sandboxed run or a new key, so the line says only what stays true ("has been
 * run without a sandbox") and "may not answer", never that it won't.
 */

import { emitUnsandboxedPodLine, hasUnsandboxedLineSince } from './systemActionLineService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');

type PodSettings = { publicRead?: unknown; communityListed?: unknown; joinPolicy?: unknown } | null;

type UnsandboxedAgent = {
  _id: unknown;
  username?: string;
  profilePicture?: string | null;
  botMetadata?: { agentName?: string; instanceId?: string; displayName?: string; hostUnconfined?: unknown };
};

/**
 * The CLI's own test, read the way `/api/agents/runtime/installations` reports
 * a pod: a missing flag is false and a missing joinPolicy is open.
 */
export const podQualifiesForUnsandboxed = (pod: PodSettings): boolean => Boolean(pod)
  && pod?.publicRead !== true
  && pod?.communityListed !== true
  && pod?.joinPolicy === 'invite-only';

const startOfUtcDay = (now: Date): Date => new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
);

// The once-a-day check and its insert run one at a time per pod and agent, so
// two mentions at once (or a mention beside a settings change) can't both pass
// the check before either line exists. In-process: a second replica can still
// race, as with the other once-a-day lines; the worst case is a repeated line.
const inFlight = new Map<string, Promise<unknown>>();
const oneAtATime = <T>(key: string, run: () => Promise<T>): Promise<T> => {
  const next = (inFlight.get(key) || Promise.resolve()).catch(() => undefined).then(run);
  inFlight.set(key, next);
  const clear = () => { if (inFlight.get(key) === next) inFlight.delete(key); };
  next.then(clear, clear);
  return next;
};

const lineFor = async (
  podId: string, agent: UnsandboxedAgent, agentName: string, instanceId: string,
  placement: { messageId: string | number | null; threadRootId?: string | number | null },
): Promise<void> => {
  await emitUnsandboxedPodLine({
    podId,
    actorUserId: String(agent._id),
    actorUsername: agent.username || agentName,
    actorAvatarUrl: agent.profilePicture || null,
    actorIsBot: true,
    agentLabel: AgentIdentityService.resolveAgentDisplayLabel(agent, agentName),
    agentKey: `${agentName}:${instanceId}`,
    messageId: placement.messageId,
    threadRootId: placement.threadRootId ?? null,
  });
};

const postOnceToday = (
  podId: string, agent: UnsandboxedAgent, agentName: string, instanceId: string, now: Date,
  placement: { messageId: string | number | null; threadRootId?: string | number | null },
): Promise<boolean> => {
  const agentKey = `${agentName}:${instanceId}`;
  return oneAtATime(`${podId}|${agentKey}`, async () => {
    if (await hasUnsandboxedLineSince(podId, agentKey, startOfUtcDay(now))) return false;
    await lineFor(podId, agent, agentName, instanceId, placement);
    return true;
  });
};

/**
 * After the pod's owner changed who can join or who can read it. Posts one line
 * per agent in the pod that was last started without a sandbox, when the pod no
 * longer qualifies. Returns how many lines it posted.
 */
export async function noteUnsandboxedPodSettingsChange({
  podId, now = new Date(),
}: { podId: string; now?: Date }): Promise<number> {
  const pod = await Pod.findById(podId).select('publicRead communityListed joinPolicy').lean() as PodSettings;
  if (!pod || podQualifiesForUnsandboxed(pod)) return 0;
  const installs = await AgentInstallation.find({ podId, status: 'active' })
    .select('agentName instanceId').lean() as Array<{ agentName: string; instanceId?: string }>;
  let posted = 0;
  for (const install of installs) {
    const instanceId = install.instanceId || 'default';
    // eslint-disable-next-line no-await-in-loop
    const agent = await User.findOne({
      isBot: true,
      'botMetadata.agentName': install.agentName,
      'botMetadata.instanceId': instanceId,
      'botMetadata.hostUnconfined': true,
    }).select('username profilePicture botMetadata').lean() as UnsandboxedAgent | null;
    if (!agent) continue;
    // A second toggle the same day says nothing new.
    // eslint-disable-next-line no-await-in-loop
    if (await postOnceToday(podId, agent, install.agentName, instanceId, now, { messageId: null })) posted += 1;
  }
  return posted;
}

/**
 * A person @mentioned an agent last started without a sandbox, in a pod that
 * doesn't qualify. One reply to the mention, at most once per agent per UTC
 * day. The mention still queues.
 */
export async function noteUnsandboxedMention({
  podId, agentName, instanceId, senderId, messageId, threadRootId, now = new Date(),
}: {
  podId: string;
  agentName: string;
  instanceId: string;
  senderId: string;
  messageId: string | number | null;
  threadRootId?: string | number | null;
  now?: Date;
}): Promise<boolean> {
  if (messageId === null) return false;
  // The pod first: in a pod that qualifies, which is the common case, nothing
  // else is read.
  const pod = await Pod.findById(podId).select('publicRead communityListed joinPolicy').lean() as PodSettings;
  if (!pod || podQualifiesForUnsandboxed(pod)) return false;
  const agent = await User.findOne({
    isBot: true,
    'botMetadata.agentName': agentName,
    'botMetadata.instanceId': instanceId,
    'botMetadata.hostUnconfined': true,
  }).select('username profilePicture botMetadata').lean() as UnsandboxedAgent | null;
  if (!agent) return false;
  const sender = await User.findById(senderId).select('isBot').lean() as { isBot?: boolean } | null;
  if (!sender || sender.isBot) return false;
  const install = await AgentInstallation.findOne({ podId, agentName, instanceId, status: 'active' })
    .select('_id').lean();
  if (!install) return false;
  return postOnceToday(podId, agent, agentName, instanceId, now, { messageId, threadRootId });
}
