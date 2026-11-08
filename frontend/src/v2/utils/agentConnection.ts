export type AgentConnection = {
  state: 'connected' | 'available' | 'revoked' | 'stale' | 'never' | 'stopped';
  lastSeenAt: string | null;
};

type Get = <T>(url: string) => Promise<{ data: T }>;

// The public profile is tokenless, so connection state comes only from the
// owner's authenticated roster of a pod they manage the agent in. Null when
// there is no such pod or the roster has no connection for it.
export const fetchOwnedConnection = async (
  get: Get,
  agentName: string,
  instanceId: string,
): Promise<{ connection: AgentConnection; podId: string; runtimeType?: string } | null> => {
  const id = instanceId || 'default';
  const writable = await get<{ writablePodId?: string | null }>(
    `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings?instanceId=${encodeURIComponent(id)}`,
  );
  const podId = writable.data.writablePodId;
  if (!podId) return null;
  const roster = await get<{ agents?: Array<{
    name: string; instanceId: string; runtime?: { runtimeType?: string }; connection?: AgentConnection;
  }> }>(`/api/registry/pods/${encodeURIComponent(podId)}/agents`);
  const match = roster.data.agents?.find((row) => row.name === agentName && row.instanceId === id && row.connection);
  return match?.connection ? { connection: match.connection, podId, runtimeType: match.runtime?.runtimeType } : null;
};

export const connectionLabel = (
  connection: AgentConnection,
  t: (key: string, options?: Record<string, unknown>) => string,
  now = Date.now(),
): string => {
  if (connection.state === 'revoked') return t('agentConnection.revoked');
  if (connection.state === 'available') return t('agentConnection.available');
  if (connection.state === 'stopped') return t('agentConnection.stopped');
  if (connection.state === 'never') return t('agentConnection.never');
  if (connection.state === 'connected') return t('agentConnection.connected');
  const seen = connection.lastSeenAt ? new Date(connection.lastSeenAt).getTime() : NaN;
  const minutes = Number.isFinite(seen) ? Math.max(1, Math.floor((now - seen) / 60000)) : 1;
  // Past an hour, minutes stop helping: 6390 min reads as four days.
  if (minutes < 60) return t('agentConnection.stale', { count: minutes });
  if (minutes < 1440) return t('agentConnection.staleHours', { count: Math.floor(minutes / 60) });
  return t('agentConnection.staleDays', { count: Math.floor(minutes / 1440) });
};
