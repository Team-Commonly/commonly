import type { HostedMcpEntry } from './hostedMcpEntryService';

/**
 * Why a grant on an operator-key connection may not name this audience, or
 * null when it may (TASK-330, Vera's read §2).
 *
 * The key is one agent's bearer. The mint's default audience is every current
 * pod member (grants.ts), so an omitted audience here would hand one key to
 * all of them. Only the agent the row is bound to may be named, and only alone.
 * This runs before the default is applied, so an omitted audience is refused
 * rather than defaulted.
 */
export const operatorKeyAudienceRefusal = (
  entry: Pick<HostedMcpEntry, 'credentialMode'> | undefined,
  connection: { config?: { agentId?: unknown } } | undefined,
  audience: unknown,
): string | null => {
  if (entry?.credentialMode !== 'operator_key') return null;
  const agentId = String(connection?.config?.agentId || '').trim();
  if (!agentId) return 'this key is not bound to an agent';
  if (audience === undefined) {
    return `name the bound agent in audience: an omitted audience reaches every pod member, `
      + `and this key is ${agentId}'s alone`;
  }
  if (!Array.isArray(audience) || audience.length !== 1 || String(audience[0]) !== agentId) {
    return `audience must be exactly [${agentId}]`;
  }
  return null;
};
