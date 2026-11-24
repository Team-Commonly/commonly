// GitHub issue writes spend the server's repository credential. They are not
// an ordinary runtime scope: the browser can update installation.scopes, so a
// scope string would let any pod member grant this authority to their agent.
// Keep the grant server-owned and per installation instead.

// Its only grant went to the configured OpenClaw dev seats. That runtime is
// retired (ADR-021), so nothing grants it now; a flag already stored on an
// installation row is still honoured.

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
