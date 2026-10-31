// The server's verdict for each agent, as `daemon status --watch` shows it. The
// verdict is deriveAgentState's (backend/services/agentStateService.ts), the
// same one the Your Team row and the TASK-655 never-connected line use, so the
// watch and the product name an agent's state the same way. It is read through
// the operator's login, because the daemon's own credential cannot call the
// per-pod agent-states route.

// The reach states mapped to the words the watch prints. `reachable` is a
// native or push-webhook agent the server always treats as up.
const LABEL = {
  listening: 'running',
  reachable: 'running',
  'gone-dark': 'stalled',
  'never-connected': 'not connected',
};

// When one agent is installed in several pods, the most alive verdict wins.
const RANK = ['running', 'stalled', 'not connected', 'unknown'];

export const reachLabel = (reach) => LABEL[reach] || 'unknown';

export const seatKey = (agentName, instanceId) => (
  `${String(agentName || '').toLowerCase()}:${String(instanceId || 'default').toLowerCase()}`
);

const moreAlive = (a, b) => (RANK.indexOf(a) <= RANK.indexOf(b) ? a : b);

// `client` is a user-token client. One call lists the caller's pods, then one
// agent-states call per pod. Returns Map<seatKey, label>.
export const loadReachByAgent = async ({ client }) => {
  const listed = await client.get('/api/pods');
  const pods = Array.isArray(listed) ? listed : (listed?.pods || []);
  const byAgent = new Map();
  for (const pod of pods) {
    const podId = pod?._id || pod?.id;
    if (!podId) continue;
    const body = await client.get(`/api/pods/${podId}/agent-states`);
    for (const agent of body?.agents || []) {
      const key = seatKey(agent.agentName, agent.instanceId);
      const label = reachLabel(agent.state);
      byAgent.set(key, byAgent.has(key) ? moreAlive(byAgent.get(key), label) : label);
    }
  }
  return byAgent;
};

// Caches the verdict map so the 2 s watch refresh does not re-read every pod.
// A failed load is thrown, not cached, so the next tick retries.
export const createReachCache = ({ load, ttlMs = 10_000, now = Date.now }) => {
  let value = null;
  let loadedAt = 0;
  return async () => {
    if (value && now() - loadedAt < ttlMs) return value;
    value = await load();
    loadedAt = now();
    return value;
  };
};
