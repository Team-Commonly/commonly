// GitHub issue writes spend the server's repository credential. They are not
// an ordinary runtime scope: the browser can update installation.scopes, so a
// scope string would let any pod member grant this authority to their agent.
// Keep the grant server-owned and per installation instead.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const GlobalModelConfigService = require('./globalModelConfigService');

export const isDevTierGitHubIssueWriter = ({
  instanceId,
  runtimeType,
  devAgentIds,
}: {
  instanceId: unknown;
  runtimeType: unknown;
  devAgentIds: unknown;
}): boolean => {
  const normalizedInstance = String(instanceId || '').trim().toLowerCase();
  const normalizedRuntime = String(runtimeType || '').trim().toLowerCase();
  const devSeats = Array.isArray(devAgentIds)
    ? devAgentIds.map((id) => String(id || '').trim().toLowerCase())
    : [];

  return normalizedRuntime === 'moltbot' && devSeats.includes(normalizedInstance);
};

/**
 * Resolve the server-owned initial grant for an already-existing agent
 * identity. This is deliberately keyed by the canonical agent type rather
 * than installation.config: the latter is user-editable, while an untrusted
 * caller must never be able to promote its own installation by writing
 * `runtimeType: 'moltbot'` into config.
 *
 * The caller persists a positive result on the installation row. A config
 * read failure returns false, so rollout fails closed instead of turning a
 * transient settings outage into a GitHub write grant.
 */
export const isConfiguredDevTierGitHubIssueWriter = async ({
  agentName,
  instanceId,
}: {
  agentName: unknown;
  instanceId: unknown;
}): Promise<boolean> => {
  const runtimeType = AgentIdentityService
    .getAgentTypeConfig(String(agentName || ''))?.runtime;
  if (String(runtimeType || '').trim().toLowerCase() !== 'moltbot') return false;

  try {
    const modelConfig = await GlobalModelConfigService.getConfig();
    return isDevTierGitHubIssueWriter({
      instanceId,
      runtimeType,
      devAgentIds: modelConfig?.openclaw?.devAgentIds,
    });
  } catch (err) {
    console.warn('[github-issue-write] could not resolve dev-tier capability:', (err as Error).message);
    return false;
  }
};

export const agentCanWriteGitHubIssues = (installations: unknown): boolean => (
  Array.isArray(installations)
  && installations.some((installation) => (
    installation && typeof installation === 'object'
    && (installation as { githubIssueWrite?: unknown }).githubIssueWrite === true
  ))
);

// CJS compat: let require() return named exports without a .default hop.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports;
