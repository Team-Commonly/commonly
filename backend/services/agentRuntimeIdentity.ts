/**
 * Identity used to address runtime-token agents in the event queue.
 *
 * This is deliberately narrower than display-label resolution: agent events
 * must use the exact `(agentName, instanceId)` pair produced by runtime-token
 * authentication, or a valid event will remain pending forever under a key
 * the polling agent never asks for.
 */
export interface RuntimeIdentityInput {
  username?: unknown;
  botMetadata?: {
    agentName?: unknown;
    instanceId?: unknown;
  };
}

const normalize = (value: unknown): string => String(value || '').trim().toLowerCase();

const deriveInstanceIdFromUsername = (agentName: string, username: string): string | null => {
  if (!agentName || !username) return null;
  if (username === agentName) return 'default';
  const prefix = `${agentName}-`;
  if (!username.startsWith(prefix)) return null;
  const suffix = username.slice(prefix.length).trim();
  return suffix || null;
};

export const resolveAgentRuntimeIdentity = (
  agentUser: RuntimeIdentityInput,
): { agentName: string; instanceId: string } => {
  const meta = agentUser?.botMetadata || {};
  const username = normalize(agentUser?.username);
  const agentName = normalize(meta.agentName || meta.instanceId || username);

  const metadataInstanceId = normalize(meta.instanceId);
  const usernameInstanceId = deriveInstanceIdFromUsername(agentName, username);
  const instanceId = usernameInstanceId && (!metadataInstanceId || metadataInstanceId === 'default')
    ? usernameInstanceId
    : (metadataInstanceId || usernameInstanceId || 'default');

  return { agentName, instanceId };
};
