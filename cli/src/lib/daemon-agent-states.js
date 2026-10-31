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

// Caches each pod's verdict for `ttlMs`, so the 2 s watch frame does not re-read
// every pod. A failed read is thrown and not cached, so the next frame retries.
// `load(podId)` returns Map<seatKey, label>. Returns `reachFor(podIds)`, which
// merges the pods' maps into one.
export const createReachCache = ({ load, ttlMs = 10_000, now = Date.now }) => {
  const cached = new Map();
  const reachFor = async (podIds) => {
    const merged = new Map();
    for (const podId of podIds) {
      const hit = cached.get(podId);
      const agents = hit && now() - hit.loadedAt < ttlMs
        ? hit.agents
        : await load(podId).then((loaded) => {
          cached.set(podId, { agents: loaded, loadedAt: now() });
          return loaded;
        });
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
