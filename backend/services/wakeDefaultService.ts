/**
 * What a new install of a person's own agent wakes on.
 *
 * ADR-018 D8.1 (2026-10-21) made an agent a person brings wake on every human
 * message: "have the byo agent by default wake on message instead of mention
 * (the knob is always there still)". F669 (2026-11-26) narrows it, because
 * each wake runs on the owner's own Claude or Codex account, and a busy shared
 * pod spent it for them:
 *
 * - In a pod with other people: mentions only. Replies to the agent and
 *   answers to its own question still reach it (agentMentionService).
 * - In a pod where the owner is the only person, and in the owner's direct
 *   message: every human message, as D8.1 set it.
 * - A digest wake once a day (`digestWake.afterMinutes: 1440`), so a
 *   mention-only agent does not take the scheduler's hourly default in every
 *   pod. schedulerService.resolveDigestWakeAfterMinutes reads it.
 *
 * Several listening agents in one pod are safe because of the claim inbox, not
 * because of a default: all wake, one claims and acts, the others stand down
 * (D8), a broadcast NO_REPLY releases the claim for a second pass (D6.1), and
 * the typing indicator shows who is on it (D7).
 *
 * Scope, deliberately narrow:
 * - New installs only, applied when the install route writes a row. An active
 *   row is never rewritten (AgentInstallation.install refuses a second one),
 *   so it keeps its setting. Reinstalling over an uninstalled row does take
 *   the new default: that write replaces the old row's config.
 * - Agents a person runs themselves, by either setup path: the Bring your own
 *   page (`runtimeType: 'webhook'` with no push URL, stamped `host: 'byo'`, or
 *   the computer placement `'wrapper'`), and `commonly agent attach`, which
 *   sends its CLI's runtime type with `host: 'byo'`. Not hosted or other
 *   cloud runtimes, whatever `host` says, not first-party apps, not push
 *   webhooks.
 * - An explicit `wakeOnMessage`, `boardWake` or `digestWake` in the install
 *   request always wins (attach's `--wake-on-message`).
 *
 * What it writes:
 * - `wakeOnMessage: { enabled: true, humanOnly: true }` where it wakes on
 *   messages. `humanOnly` means an agent-authored message never wakes it
 *   ambiently (agentMentionService), so a default can't start agents
 *   answering each other. `{ enabled: false }` elsewhere. Each carries a
 *   `reason` stamp, so a later step can tell a default from a choice.
 * - `boardWake: { enabled: false }`, unless the request set one. An absent
 *   boardWake inherits wakeOnMessage, so turning chat on would otherwise also
 *   subscribe the agent to task-board wakes (the 2026-10-06 lesson, in the
 *   other direction).
 */
import User from '../models/User';
import { isCloudRuntime } from './agentIdentityService';
import { HOSTED_RUNTIME_TYPE } from './hostedRuntimeService';

const PERSON_AGENT_WAKE_REASON = 'person-agent-default';
const SHARED_POD_WAKE_REASON = 'person-agent-shared-pod';
const PERSON_AGENT_DIGEST_WAKE_MINUTES = 1440;
// The owner's own 1:1 room with the agent.
const DIRECT_MESSAGE_POD_TYPE = 'agent-room';

type InstallConfig = Record<string, unknown> & {
  runtime?: { runtimeType?: unknown; host?: unknown; webhookUrl?: unknown };
  wakeOnMessage?: unknown;
  boardWake?: unknown;
  digestWake?: unknown;
};

/** The pod an install lands in, as the default reads it. */
type InstallPod = { type?: unknown; otherHumans: boolean };

/** Whether this install is an agent a person runs themselves, from the page or `agent attach`. */
export const isPersonBroughtAgent = (installConfig: InstallConfig): boolean => {
  const runtime = installConfig.runtime || {};
  const runtimeType = String(runtime.runtimeType || '').trim().toLowerCase();
  if (runtimeType === 'wrapper') return true;
  // Only Commonly runs these, so a `host: 'byo'` label on one changes nothing.
  if (runtimeType === HOSTED_RUNTIME_TYPE || isCloudRuntime({ runtimeType, host: String(runtime.host || '') })) {
    return false;
  }
  return Boolean(runtimeType) && !runtime.webhookUrl && String(runtime.host || '') === 'byo';
};

/**
 * The config keys to add to a new install, or null to leave it as it is.
 * `installConfig` is the config about to be stored, after the route has
 * normalised its runtime block.
 */
export const personAgentWakeDefault = (
  installConfig: InstallConfig,
  pod: InstallPod,
  now: Date = new Date(),
): Record<string, unknown> | null => {
  if (!isPersonBroughtAgent(installConfig)) return null;
  const patch: Record<string, unknown> = {};
  if (installConfig.wakeOnMessage === undefined) {
    const wakesOnMessages = String(pod.type || '') === DIRECT_MESSAGE_POD_TYPE || !pod.otherHumans;
    patch.wakeOnMessage = wakesOnMessages
      ? { enabled: true, humanOnly: true, reason: PERSON_AGENT_WAKE_REASON, defaultedAt: now.toISOString() }
      : { enabled: false, reason: SHARED_POD_WAKE_REASON, defaultedAt: now.toISOString() };
    if (installConfig.boardWake === undefined) patch.boardWake = { enabled: false };
  }
  if (installConfig.digestWake === undefined) {
    patch.digestWake = { afterMinutes: PERSON_AGENT_DIGEST_WAKE_MINUTES };
  }
  return Object.keys(patch).length ? patch : null;
};

/**
 * Whether anyone in the pod besides its owner is a person. A lookup that fails
 * answers yes, so the default falls to mentions only, the one that spends less
 * of the owner's account.
 */
export const podHasOtherHumans = async (
  pod: { members?: unknown[] } | null | undefined, ownerId: unknown,
): Promise<boolean> => {
  // A member is an id; legacy rows hold `{ userId }`, as the install route reads them.
  const others = (pod?.members || [])
    .map((member) => String((member as { userId?: unknown } | null)?.userId ?? member ?? ''))
    .filter((id) => id && id !== String(ownerId));
  if (!others.length) return false;
  try {
    return Boolean(await User.exists({ _id: { $in: others }, isBot: { $ne: true } }));
  } catch {
    return true;
  }
};

/** The install route's one call: the wake default for this install in this pod. */
export const personAgentInstallDefaults = async (
  installConfig: InstallConfig,
  pod: { type?: unknown; members?: unknown[] } | null | undefined,
  ownerId: unknown,
  now: Date = new Date(),
): Promise<Record<string, unknown> | null> => {
  if (!isPersonBroughtAgent(installConfig)) return null;
  return personAgentWakeDefault(installConfig, {
    type: pod?.type, otherHumans: await podHasOtherHumans(pod, ownerId),
  }, now);
};

// CJS compat: consumed from both `import` and `require()` call sites.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports; Object.assign(module.exports, exports);
