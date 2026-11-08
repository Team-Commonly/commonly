// `agentName:instanceId`, lowercased with a missing instance as `default`, so a
// notice's payload agentKey and an agent-states row meet on one key (F339).
export const agentKeyOf = (agentName?: string, instanceId?: string | null): string => (
  `${String(agentName || '').toLowerCase()}:${String(!instanceId || instanceId === 'undefined' ? 'default' : instanceId).toLowerCase()}`
);
export const normalizeAgentKey = (key: string): string => {
  const at = key.indexOf(':');
  return at < 0 ? agentKeyOf(key) : agentKeyOf(key.slice(0, at), key.slice(at + 1));
};

// reconnect=1 keeps the agent's own name, so the page can't allocate "<name>-2".
export const agentConnectLink = (agent?: {
  agentName?: string;
  instanceId?: string;
  connectPodId?: string;
} | null): string => (
  agent?.connectPodId && agent.agentName
    ? `/v2/agents/byo?pod=${encodeURIComponent(agent.connectPodId)}&name=${encodeURIComponent(agent.agentName)}&instanceId=${encodeURIComponent(agent.instanceId || 'default')}&reconnect=1`
    : ''
);
