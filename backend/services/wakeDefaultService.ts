/**
 * ADR-018 D8.1 (2026-10-21): an agent a person brings into a pod wakes on
 * every human message by default.
 *
 * The direction: "have the byo agent by default wake on message instead of
 * mention (the knob is always there still)", and the principle behind it:
 * every agent should read new messages even when it doesn't own the reply.
 * Until now ambient wake was opt-in only, so a person who connected their own
 * agent and then talked to it got silence unless they typed its @name.
 *
 * Several listening agents in one pod are safe because of the claim inbox, not
 * because of a default: all wake, one claims and acts, the others stand down
 * (D8), a broadcast NO_REPLY releases the claim for a second pass (D6.1), and
 * the typing indicator shows who is on it (D7).
 *
 * Scope, deliberately narrow:
 * - New installs only. Nothing here touches an existing installation.
 * - Agents a person brings themselves from the Bring your own page: the
 *   own-agent seat (`runtimeType: 'webhook'` with no push URL, stamped
 *   `host: 'byo'`) and the computer placement (`'wrapper'`). Not hosted agents
 *   (they can't take an ambient turn yet), not first-party apps, and not
 *   `agent attach`, which sends its CLI's own runtime type and keeps its
 *   explicit `--wake-on-message` flag.
 * - An explicit `wakeOnMessage` in the install request always wins.
 *
 * What it writes:
 * - `wakeOnMessage: { enabled: true, humanOnly: true }`. `humanOnly` means an
 *   agent-authored message never wakes it ambiently (agentMentionService), so
 *   a default can't start agents answering each other. Agents still see each
 *   other's messages in the context they read when a person's message wakes
 *   them.
 * - `boardWake: { enabled: false }`, unless the request set one. An absent
 *   boardWake inherits wakeOnMessage, so turning chat on would otherwise also
 *   subscribe the agent to task-board wakes (the 2026-10-06 lesson, in the
 *   other direction).
 */

export const PERSON_AGENT_WAKE_REASON = 'person-agent-default';

type InstallConfig = Record<string, unknown> & {
  runtime?: { runtimeType?: unknown; host?: unknown; webhookUrl?: unknown };
  wakeOnMessage?: unknown;
  boardWake?: unknown;
};

/** Whether this install is an agent a person brought from the Bring your own page. */
export const isPersonBroughtAgent = (installConfig: InstallConfig): boolean => {
  const runtime = installConfig.runtime || {};
  const runtimeType = String(runtime.runtimeType || '').trim().toLowerCase();
  if (runtimeType === 'wrapper') return true;
  return runtimeType === 'webhook' && !runtime.webhookUrl && String(runtime.host || '') === 'byo';
};

/**
 * The config keys to add to a new install, or null to leave it as it is.
 * `installConfig` is the config about to be stored, after the route has
 * normalised its runtime block.
 */
export const personAgentWakeDefault = (
  installConfig: InstallConfig,
  now: Date = new Date(),
): Record<string, unknown> | null => {
  if (installConfig.wakeOnMessage !== undefined) return null;
  if (!isPersonBroughtAgent(installConfig)) return null;
  return {
    wakeOnMessage: {
      enabled: true, humanOnly: true, reason: PERSON_AGENT_WAKE_REASON, defaultedAt: now.toISOString(),
    },
    ...(installConfig.boardWake === undefined ? { boardWake: { enabled: false } } : {}),
  };
};

// CJS compat: consumed from both `import` and `require()` call sites.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports; Object.assign(module.exports, exports);
