import { createHash } from 'crypto';
import mongoose from 'mongoose';

// Server-side BYO funnel rows. The browser posts its steps through
// POST /api/stats/byo-step; events only the backend can see (an agent's first
// authenticated call) are written here directly, so they never depend on the
// user keeping the page open. Fixed step names only: never a command, key or name.
export type ServerByoStep = 'seat-registered' | 'daemon-registered';

export type ByoCopyAgent = { agentName: string; podId: string };

/**
 * The setup commands a person copied at or after `since` for one agent. The
 * onboarding copy marks are write-once (the first copy ever), so they cannot
 * say what was copied for a later agent; these rows carry their own time and,
 * since TASK-345, the agent the page was showing.
 *
 * An MCP copy counts only when it names this agent, so a copy for another
 * agent never stands in for this one. A listener or daemon copy counts when it
 * names this agent or names none (older rows, and the machine-wide daemon
 * command), which errs toward "not MCP-only". userId is stored as a string.
 */
export async function byoCopiesSince(
  userId: unknown,
  since: Date,
  agent: ByoCopyAgent,
): Promise<{ firstMcpAt: Date | null; listener: number }> {
  const rows = await mongoose.connection.db.collection('byo_telemetry').find({
    userId: String(userId),
    at: { $gte: since },
    step: { $in: ['mcp-command-copied', 'cli-command-copied', 'daemon-command-copied'] },
  }).project({ step: 1, at: 1, agentName: 1, podId: 1 }).toArray();
  const forThisAgent = (r: Record<string, unknown>) => r.agentName === agent.agentName && r.podId === agent.podId;
  let firstMcpAt: Date | null = null;
  let listener = 0;
  for (const r of rows) {
    if (r.step === 'mcp-command-copied') {
      if (forThisAgent(r) && (!firstMcpAt || r.at < firstMcpAt)) firstMcpAt = r.at;
    } else if (!r.agentName || forThisAgent(r)) {
      listener += 1;
    }
  }
  return { firstMcpAt, listener };
}

/**
 * The agent a copy event names, kept only when the person installed that agent
 * in that pod. Anything else is dropped, never stored as given.
 */
export async function byoCopyAgentFor(userId: unknown, body: Record<string, unknown>): Promise<ByoCopyAgent | null> {
  const agentName = typeof body?.agentName === 'string' ? body.agentName : '';
  const podId = typeof body?.podId === 'string' ? body.podId : '';
  if (!/^[a-z0-9-]{1,64}$/.test(agentName) || !/^[a-f0-9]{24}$/.test(podId)) return null;
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { AgentInstallation } = require('../models/AgentRegistry');
    const owned = await AgentInstallation.exists({ agentName, podId, installedBy: String(userId) });
    return owned ? { agentName, podId } : null;
  } catch {
    return null;
  }
}

// A once-per-seat event is keyed by a hash of the token record's hash, so the
// unique _id index makes concurrent first calls write one row. The hash is one-way
// and is never the credential itself.
export function seatRegisteredKey(tokenHash: string): string {
  return `seat-registered:${createHash('sha256').update(tokenHash).digest('hex')}`;
}

// A person registers a daemon once per setup, however many machines they add,
// so the row is keyed by the user alone.
export function daemonRegisteredKey(userId: unknown): string {
  return `daemon-registered:${String(userId)}`;
}

export async function recordByoEvent(
  userId: unknown,
  step: ServerByoStep,
  extra: Record<string, unknown> = {},
  dedupeKey?: string,
): Promise<void> {
  try {
    // The collection is untyped here; a string _id is only set for the keyed seat row.
    const doc: Record<string, unknown> = {
      ...(dedupeKey ? { _id: dedupeKey } : {}),
      userId,
      step,
      ...extra,
      at: new Date(),
    };
    await mongoose.connection.db.collection('byo_telemetry').insertOne(doc as any);
  } catch (err: any) {
    // A duplicate key means this seat's row already exists: the expected outcome of a race.
    if (err?.code === 11000) return;
    // Telemetry must never fail the caller's flow.
    console.warn('[byo-telemetry] write failed:', err?.message);
  }
}
