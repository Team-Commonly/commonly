/**
 * ADR-018 D8.1 (2026-10-21): the first agent a person brings into a pod wakes
 * on every human message by default; agents added after it stay mention-only.
 *
 * Sam's direction: "have the byo agent by default wake on message instead of
 * mention (the knob is always there still)". Until now ambient wake was opt-in
 * only, so a person who connected their own agent and then just talked to it
 * got silence unless they typed its @name.
 *
 * Scope, deliberately narrow:
 * - New installs only. Nothing here touches an existing installation.
 * - Agents a person brings themselves from the Bring your own page: the
 *   own-agent seat (`runtimeType: 'webhook'` with no push URL, stamped
 *   `host: 'byo'`) and the computer placement (`'wrapper'`). Not hosted agents
 *   (they can't take an ambient turn yet), not first-party apps, and not
 *   `agent attach`, which sends its CLI's own runtime type and keeps its
 *   explicit `--wake-on-message` flag.
 * - Never Scout, and not when another non-Scout agent in the pod already
 *   wakes on every message: one ambient answerer per pod by default.
 * - An explicit `wakeOnMessage` in the install request always wins.
 *
 * What it writes:
 * - `wakeOnMessage: { enabled: true, humanOnly: true }`. `humanOnly` means an
 *   agent-authored message never wakes it ambiently (agentMentionService), so
 *   a default can't start agents talking to each other.
 * - `boardWake: { enabled: false }`, unless the request set one. An absent
 *   boardWake inherits wakeOnMessage, so turning chat on would otherwise also
 *   subscribe the agent to task-board wakes (the 2026-10-06 lesson, in the
 *   other direction).
 */
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');

export const SCOUT_AGENT_NAME = 'scout';
export const FIRST_AGENT_WAKE_REASON = 'first-agent-default';

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
export const firstAgentWakeDefault = async ({
  podId, agentName, instanceId, installConfig, now = new Date(),
}: {
  podId: unknown;
  agentName: string;
  instanceId: string;
  installConfig: InstallConfig;
  now?: Date;
}): Promise<Record<string, unknown> | null> => {
  if (installConfig.wakeOnMessage !== undefined) return null;
  if (String(agentName || '').toLowerCase() === SCOUT_AGENT_NAME) return null;
  if (!isPersonBroughtAgent(installConfig)) return null;
  const anotherAnswerer = await AgentInstallation.exists({
    podId,
    status: 'active',
    agentName: { $ne: SCOUT_AGENT_NAME },
    'config.wakeOnMessage.enabled': true,
    $nor: [{ agentName: String(agentName).toLowerCase(), instanceId: instanceId || 'default' }],
  });
  if (anotherAnswerer) return null;
  return {
    wakeOnMessage: {
      enabled: true, humanOnly: true, reason: FIRST_AGENT_WAKE_REASON, defaultedAt: now.toISOString(),
    },
    ...(installConfig.boardWake === undefined ? { boardWake: { enabled: false } } : {}),
  };
};

// CJS compat: consumed from both `import` and `require()` call sites.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports; Object.assign(module.exports, exports);
