export type AgentConnection = {
  state: 'connected' | 'revoked' | 'stale' | 'never';
  lastSeenAt: string | null;
};

export const connectionLabel = (
  connection: AgentConnection,
  t: (key: string, options?: Record<string, unknown>) => string,
  now = Date.now(),
): string => {
  if (connection.state === 'revoked') return t('agentConnection.revoked');
  if (connection.state === 'never') return t('agentConnection.never');
  if (connection.state === 'connected') return t('agentConnection.connected');
  const seen = connection.lastSeenAt ? new Date(connection.lastSeenAt).getTime() : NaN;
  const minutes = Number.isFinite(seen) ? Math.max(1, Math.floor((now - seen) / 60000)) : 1;
  return t('agentConnection.stale', { count: minutes });
};
