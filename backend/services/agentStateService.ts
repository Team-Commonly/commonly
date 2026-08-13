/**
 * agentStateService — #891 surface 1's derivation, kept pure.
 *
 * Answers, per agent install: can it actually respond to a mention right
 * now? States are PER RUNTIME CLASS because the #891 review measured
 * `lastUsedAt` lying for every class except the polling one:
 *
 *   - BYO wrapper/MCP installs (host 'byo' or legacy local-cli, no
 *     webhookUrl): the wrapper polls every ~5s while alive, so lastUsedAt is
 *     an honest reachability signal. null → never-connected · fresh →
 *     listening · stale → gone-dark.
 *   - push webhooks (webhookUrl set) and native runtime: reachable by
 *     construction — no dot, no guess.
 *   - everything else (gateway moltbots, cloud): 'unknown'. The gateway
 *     stamps one shared boot timestamp for a whole fleet (finding A);
 *     pretending to know is the false positive the ratified doc bans.
 *
 * Split key (decision 1): the state is the EXPLANATION and goes to any pod
 * viewer; `fixCommand` is an instruction and attaches only for the owner —
 * an instruction addressed to someone who cannot perform it is the P1/P2
 * contradiction the review caught.
 *
 * lastUsedAt is the max across BOTH token stores (User.agentRuntimeTokens
 * and AgentInstallation.runtimeTokens) — the legacy/new split that made
 * live agents read null (finding D). Pure function: callers fetch, this
 * derives; the seam is what makes the honesty rules testable without a DB.
 */

export const AGENT_LISTENING_STALE_MS = 5 * 60 * 1000;

export type AgentReachState = 'listening' | 'gone-dark' | 'never-connected' | 'reachable' | 'unknown';

interface TokenRow { lastUsedAt?: Date | string | null }

interface InstallationRow {
  agentName?: string;
  instanceId?: string;
  displayName?: string;
  installedBy?: unknown;
  config?: { runtime?: { runtimeType?: string; host?: string; webhookUrl?: string } };
  runtimeTokens?: TokenRow[];
}

export interface AgentStateRow {
  agentName: string;
  instanceId: string;
  displayName: string;
  state: AgentReachState;
  lastUsedAt: string | null;
  isOwner: boolean;
  fixCommand?: string;
}

const latestUse = (tokenLists: TokenRow[][]): Date | null => {
  let latest: Date | null = null;
  for (const list of tokenLists) {
    for (const row of list || []) {
      if (!row?.lastUsedAt) continue;
      const used = new Date(row.lastUsedAt as string);
      if (Number.isNaN(used.getTime())) continue;
      if (!latest || used > latest) latest = used;
    }
  }
  return latest;
};

export function deriveAgentState(
  installation: InstallationRow,
  userTokens: TokenRow[],
  callerId: string,
  now: number = Date.now(),
): AgentStateRow {
  const agentName = String(installation.agentName || '').toLowerCase();
  const instanceId = String(installation.instanceId || 'default');
  const runtime = installation.config?.runtime || {};
  const runtimeType = String(runtime.runtimeType || '').toLowerCase();
  const isByo = runtime.host === 'byo' || runtimeType === 'local-cli';
  const isPushWebhook = Boolean(runtime.webhookUrl);
  const isNative = runtimeType === 'native';

  let state: AgentReachState;
  let lastUsedAt: Date | null = null;
  if (isNative || isPushWebhook) {
    state = 'reachable';
  } else if (!isByo) {
    state = 'unknown';
  } else {
    lastUsedAt = latestUse([installation.runtimeTokens || [], userTokens || []]);
    if (!lastUsedAt) state = 'never-connected';
    else if (now - lastUsedAt.getTime() <= AGENT_LISTENING_STALE_MS) state = 'listening';
    else state = 'gone-dark';
  }

  const isOwner = String(installation.installedBy || '') === String(callerId || '');
  const needsFix = state === 'never-connected' || state === 'gone-dark';
  return {
    agentName,
    instanceId,
    displayName: installation.displayName || agentName,
    state,
    lastUsedAt: lastUsedAt ? lastUsedAt.toISOString() : null,
    isOwner,
    ...(isOwner && needsFix ? { fixCommand: `commonly agent run ${agentName}` } : {}),
  };
}

export default { deriveAgentState, AGENT_LISTENING_STALE_MS };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
