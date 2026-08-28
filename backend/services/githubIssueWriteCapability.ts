// GitHub issue writes spend the server's repository credential. They are not
// an ordinary runtime scope: the browser can update installation.scopes, so a
// scope string would let any pod member grant this authority to their agent.
// Keep the grant server-owned and per installation instead.

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
