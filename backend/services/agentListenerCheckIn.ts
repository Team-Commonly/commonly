import User from '../models/User';

/**
 * A listener check-in is the one signal that "mentions will wake this agent":
 * the events poll (`GET /api/agents/runtime/events`) or the agent WebSocket
 * connect. `lastUsedAt` cannot say that. `agentRuntimeAuth` stamps it on any
 * authenticated call, so an MCP tool call alone used to read as "listening"
 * (TASK-719). The stamp lives on the same embedded token record, in its own
 * field, so the two meanings stay separate.
 *
 * The events poll runs every few seconds per listener, so the write is
 * throttled per token; the process-lifetime map is bounded by the count of
 * distinct listener tokens, and a restart only costs one extra write each.
 *
 * Only tokens on the agent's User row are stamped. A token that exists only on
 * `AgentInstallation.runtimeTokens` matches nothing here, and
 * `/api/users/me/agent-connection` never read that list (it reads the User
 * row), so such a token never showed as connected before this change either.
 * Every issuer in use (`issueRuntimeTokenForAgent`) writes the same hash to
 * both places; `issueRuntimeTokenForInstallation` has no callers.
 */
const CHECK_IN_INTERVAL_MS = 60 * 1000;
const lastWrites = new Map<string, number>();

export function recordListenerCheckIn(agentUserId: unknown, tokenHash: unknown): void {
  if (!agentUserId || typeof tokenHash !== 'string' || !tokenHash) return;
  const now = Date.now();
  const prev = lastWrites.get(tokenHash);
  if (prev && now - prev < CHECK_IN_INTERVAL_MS) return;
  lastWrites.set(tokenHash, now);
  try {
    User.updateOne(
      { _id: agentUserId, 'agentRuntimeTokens.tokenHash': tokenHash },
      { $set: { 'agentRuntimeTokens.$.lastListenedAt': new Date(now) } },
    ).catch(() => {
      // Retry on the next poll instead of staying "waiting" for a minute.
      lastWrites.delete(tokenHash);
    });
  } catch {
    // Presence is best-effort: it must never turn a poll into an error.
    lastWrites.delete(tokenHash);
  }
}

export const resetListenerCheckInThrottle = (): void => lastWrites.clear();
