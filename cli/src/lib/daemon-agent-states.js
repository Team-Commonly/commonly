import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The server's verdict for each agent, as `daemon status --watch` shows it. The
// verdict is deriveAgentState's (backend/services/agentStateService.ts), the
// same one the Your Team row and the TASK-655 never-connected line use, so the
// watch and the product name an agent's state the same way. It is read through
// the operator's login, because the daemon's own credential cannot call the
// per-pod agent-states route. Each agent's pod comes from its token record.

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

// Reads one pod's agents and returns Map<seatKey, label>. `client` is a
// user-token client.
export const loadPodReach = async ({ client, podId }) => {
  const body = await client.get(`/api/pods/${podId}/agent-states`);
  const byAgent = new Map();
  for (const agent of body?.agents || []) {
    byAgent.set(seatKey(agent.agentName, agent.instanceId), reachLabel(agent.state));
  }
  return byAgent;
};

// The server allows 60 agent-states reads a minute per IP. Each pod is refreshed
// once per TTL, and the TTL stretches with the pod count, so N pods cost about 50
// reads a minute whatever N is: 1.2 s per pod at least, and never below `ttlMs`.
const PER_POD_SPACING_MS = 1_200;

// Caches each pod's verdict, so the 2 s watch frame does not re-read every pod.
// A failed refresh keeps the pod's last verdict and waits one TTL before trying
// again, so a 429 is neither discarded nor retried every frame. A pod with no
// earlier verdict throws, and the next call retries it. `load(podId)` returns
// Map<seatKey, label>. Returns `reachFor(podIds)`, which merges the pods' maps.
export const createReachCache = ({ load, ttlMs = 10_000, now = Date.now }) => {
  const cached = new Map();
  const reachFor = async (podIds) => {
    const ttl = Math.max(ttlMs, podIds.length * PER_POD_SPACING_MS);
    const merged = new Map();
    for (const podId of podIds) {
      const hit = cached.get(podId);
      let agents;
      if (hit && now() - hit.loadedAt < ttl) {
        agents = hit.agents;
      } else {
        try {
          agents = await load(podId);
        } catch (error) {
          if (!hit) throw error;
          agents = hit.agents;
        }
        cached.set(podId, { agents, loadedAt: now() });
      }
      for (const [key, label] of agents) {
        merged.set(key, merged.has(key) ? moreAlive(merged.get(key), label) : label);
      }
    }
    return merged;
  };
  return reachFor;
};

// The agent's last supervised turn, from its session store, the record
// `agent list` reads. The most recent entry across pods, or null. The
// supervisor's own stamp is the spawn time, so the watch does not use it.
export const readSessionLastTurn = (name, { home = homedir() } = {}) => {
  try {
    const sessions = JSON.parse(readFileSync(join(home, '.commonly', 'sessions', `${name}.json`), 'utf8'));
    let latest = null;
    for (const entry of Object.values(sessions || {})) {
      if (entry?.lastTurn && (!latest || entry.lastTurn > latest)) latest = entry.lastTurn;
    }
    return latest;
  } catch {
    return null;
  }
};
