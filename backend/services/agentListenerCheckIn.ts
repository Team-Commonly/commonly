import User from '../models/User';
import { AgentInstallation } from '../models/AgentRegistry';

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
 * A token lives on the agent's User row, on `AgentInstallation.runtimeTokens`,
 * or both (`issueRuntimeTokenForAgent` writes the same hash to both places).
 * The check-in stamps whichever copies exist, so `deriveAgentState`, which
 * reads both stores, sees a seat whose only token is installation-bound as
 * listening. Before this, such a token could not be stamped and would have
 * read as never-connected the moment the derivation moved off `lastUsedAt`.
 */
const CHECK_IN_INTERVAL_MS = 60 * 1000;
const lastWrites = new Map<string, number>();

export function recordListenerCheckIn(agentUserId: unknown, tokenHash: unknown): void {
  if (typeof tokenHash !== 'string' || !tokenHash) return;
  const now = Date.now();
  const prev = lastWrites.get(tokenHash);
  if (prev && now - prev < CHECK_IN_INTERVAL_MS) return;
  lastWrites.set(tokenHash, now);
  const at = new Date(now);
  // Retry on the next poll instead of staying "waiting" for a minute.
  const retryNextPoll = () => { lastWrites.delete(tokenHash); };
  try {
    if (agentUserId) {
      User.updateOne(
        { _id: agentUserId, 'agentRuntimeTokens.tokenHash': tokenHash },
        { $set: { 'agentRuntimeTokens.$.lastListenedAt': at } },
      ).catch(retryNextPoll);
    }
    AgentInstallation.updateMany(
      { 'runtimeTokens.tokenHash': tokenHash },
      { $set: { 'runtimeTokens.$.lastListenedAt': at } },
    ).catch(retryNextPoll);
  } catch {
    // Presence is best-effort: it must never turn a poll into an error.
    retryNextPoll();
  }
}

export const resetListenerCheckInThrottle = (): void => lastWrites.clear();
