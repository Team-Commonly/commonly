/**
 * Which agent a board assignee names, and the one spelling the board stores.
 *
 * An agent has three names someone might type: its board name (the instanceId,
 * or the agentName when the instance is "default"), the username @mentions
 * route to, and its agentName. The assigned-task wake and the board's other
 * seat readers match the board name, so a row assigned by either of the other
 * two never reached the agent it named (F45). On write, a name that picks out
 * exactly one agent member of the pod is stored as that agent's board name.
 * Anything else is kept as typed: it may name a person.
 */
import mongoose from 'mongoose';
import Pod from '../models/Pod';
import User from '../models/User';

export interface AssigneeAgent { agentName: string; instanceId: string; username: string }

const lower = (value: unknown): string => String(value || '').toLowerCase();
const typedName = (typed: string): string => lower(typed.trim().replace(/^@/, ''));

export const boardNameOf = ({ agentName, instanceId }: { agentName?: string; instanceId?: string }): string => (
  lower(instanceId || 'default') === 'default' ? String(agentName || '') : String(instanceId)
);

// The assignee names this seat by its board name. A leading @ and case are ignored.
export const assigneeNamesSeat = (seat: { agentName?: string; instanceId?: string }, assignee: unknown): boolean => (
  typeof assignee === 'string' && typedName(assignee) !== '' && typedName(assignee) === lower(boardNameOf(seat))
);

async function podMembers(podId: string): Promise<{ agents: AssigneeAgent[]; people: Set<string> }> {
  if (!mongoose.isValidObjectId(podId)) return { agents: [], people: new Set() };
  const pod = await Pod.findById(podId).select('members').lean<{ members?: unknown[] } | null>();
  const ids = (pod?.members || []).map((m) => String((m as { _id?: unknown })?._id ?? m)).filter(Boolean);
  if (ids.length === 0) return { agents: [], people: new Set() };
  const users = await User.find({ _id: { $in: ids } }).select('username isBot botMetadata')
    .lean<Array<{ username?: string; isBot?: boolean; botMetadata?: { agentName?: string; instanceId?: string } }>>();
  const agents = users.filter((u) => u.isBot && u.botMetadata?.agentName).map((u) => ({
    agentName: String(u.botMetadata?.agentName),
    instanceId: String(u.botMetadata?.instanceId || 'default'),
    username: String(u.username || ''),
  }));
  return { agents, people: new Set(users.filter((u) => !u.isBot).map((u) => lower(u.username))) };
}

/**
 * The one agent member of the pod a typed assignee names, or null. A board name
 * wins outright; then a username, then an agentName, each only when exactly one
 * agent carries it and no person in the pod has that username.
 */
export async function resolveAssigneeAgent(podId: string, typed: unknown): Promise<AssigneeAgent | null> {
  if (typeof typed !== 'string' || typedName(typed) === '') return null;
  const want = typedName(typed);
  const { agents, people } = await podMembers(podId);
  const byBoard = agents.filter((a) => lower(boardNameOf(a)) === want);
  if (byBoard.length === 1) return byBoard[0];
  if (byBoard.length > 1 || people.has(want)) return null;
  for (const field of ['username', 'agentName'] as const) {
    const hits = agents.filter((a) => lower(a[field]) === want);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  return null;
}

/** The assignee to store: the named agent's board name, or the input as typed. */
export async function canonicalAssignee(
  podId: string, typed: string | null | undefined,
): Promise<string | null | undefined> {
  const agent = await resolveAssigneeAgent(podId, typed);
  return agent ? boardNameOf(agent) : typed;
}
