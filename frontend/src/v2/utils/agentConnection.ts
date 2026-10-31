export type AgentConnection = {
  state: 'connected' | 'available' | 'revoked' | 'stale' | 'never';
  lastSeenAt: string | null;
};

export const connectionLabel = (
  connection: AgentConnection,
  t: (key: string, options?: Record<string, unknown>) => string,
  now = Date.now(),
): string => {
  if (connection.state === 'revoked') return t('agentConnection.revoked');
  if (connection.state === 'available') return t('agentConnection.available');
  if (connection.state === 'never') return t('agentConnection.never');
  if (connection.state === 'connected') return t('agentConnection.connected');
  const seen = connection.lastSeenAt ? new Date(connection.lastSeenAt).getTime() : NaN;
  const minutes = Number.isFinite(seen) ? Math.max(1, Math.floor((now - seen) / 60000)) : 1;
  // Past an hour, minutes stop helping: 6390 min reads as four days.
  if (minutes < 60) return t('agentConnection.stale', { count: minutes });
  if (minutes < 1440) return t('agentConnection.staleHours', { count: Math.floor(minutes / 60) });
  return t('agentConnection.staleDays', { count: Math.floor(minutes / 1440) });
};
