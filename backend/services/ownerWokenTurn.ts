// F145: did this agent's owner, and nobody else, wake this turn?
//
// A public seat answers strangers, so its memory can only be written on a turn
// the owner started. The answer comes from the event rows, never from a claim
// by the caller. Every doubt reads as no: a turn that isn't proven to be the
// owner's is a stranger's, and the seat still answers it, just without writes.
import AgentEvent from '../models/AgentEvent';
import User from '../models/User';
import { carriesOtherAuthors } from './mentionCoalesce';
import { ownsIdentityCountingPaused } from './runtimeIdentityOwnership';

// The wakes that carry a person's message, in `payload.userId`, DMs and post
// comments included. Heartbeats, digests, first contact, decisions, asks and the
// rest are not here, so they don't count even if they name the owner.
const PERSON_WAKE_TYPES: ReadonlySet<string> = new Set(['chat.mention', 'thread.mention', 'message.posted']);

// Above any batch the wrapper builds (GET /events caps a page at 50), and it
// keeps a request from reading an unbounded list.
const MAX_TURN_EVENTS = 200;

const OBJECT_ID = /^[a-f\d]{24}$/i;

type WakeEvent = {
  agentName?: string;
  instanceId?: string;
  type?: string;
  deliveryMode?: string;
  payload?: Record<string, unknown> | null;
};

const sameIdentityPart = (left: unknown, right: unknown): boolean => (
  String(left).toLowerCase() === String(right).toLowerCase()
);

/**
 * Whose words this event puts in the turn, or null if that isn't one known
 * person. `payload.userId` names only the row's first message: an agent the same
 * owner installed can join a mention onto it (ADR-018 D6.5), and the turn reads
 * what joined.
 */
const senderOf = (event: WakeEvent): string | null => {
  const payload = event.payload;
  if (!payload || !PERSON_WAKE_TYPES.has(String(event.type))) return null;
  if (event.deliveryMode === 'digest' || payload.triggerAuthor || carriesOtherAuthors(payload)) return null;
  const sender = String(payload.userId);
  return OBJECT_ID.test(sender) ? sender : null;
};

const readTurnSenders = async ({ agentName, instanceId, eventIds }: {
  agentName: string; instanceId: string; eventIds: string[];
}): Promise<string[] | null> => {
  const events = await AgentEvent.find({ _id: { $in: eventIds } })
    .select('agentName instanceId type deliveryMode payload').lean() as WakeEvent[];
  if (events.length !== eventIds.length) return null;
  const senders = new Set<string>();
  for (const event of events) {
    if (!sameIdentityPart(event.agentName, agentName)
      || !sameIdentityPart(event.instanceId || 'default', instanceId)) return null;
    const sender = senderOf(event);
    if (!sender) return null;
    senders.add(sender);
  }
  return [...senders];
};

const isOwningPerson = async (senderId: string, agentName: string, instanceId: string): Promise<boolean> => {
  const sender = await User.findById(senderId).select('isBot').lean() as { isBot?: boolean } | null;
  if (sender?.isBot !== false) return false;
  // The rule the owner's memory editor uses (routes/agentMemoryView.ts), so a
  // paused second installer counts here as it does there.
  return (await ownsIdentityCountingPaused(senderId, agentName, instanceId)).owned === true;
};

/** True only if every event is this agent's, is a person's wake, and came from its owner alone. */
export const turnWokenByOwner = async ({ agentName, instanceId, eventIds }: {
  agentName?: unknown; instanceId?: unknown; eventIds?: unknown;
}): Promise<boolean> => {
  if (typeof agentName !== 'string' || !agentName || typeof instanceId !== 'string' || !instanceId) return false;
  if (!Array.isArray(eventIds) || !eventIds.length || eventIds.length > MAX_TURN_EVENTS) return false;
  if (!eventIds.every((id) => typeof id === 'string' && OBJECT_ID.test(id))) return false;
  try {
    const senders = await readTurnSenders({ agentName, instanceId, eventIds: [...new Set(eventIds as string[])] });
    if (!senders?.length) return false;
    const owners = await Promise.all(senders.map((sender) => isOwningPerson(sender, agentName, instanceId)));
    return owners.every(Boolean);
  } catch (error) {
    console.warn('[owner-woken] could not read the turn, leaving it unmarked:', (error as Error).message);
    return false;
  }
};
