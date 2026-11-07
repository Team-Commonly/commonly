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
