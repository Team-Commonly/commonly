/**
 * The shape of ADR-018 D6.5: a second mention of one agent in one place.
 *
 * A mention joins an earlier row only before anything has claimed that row: a
 * claimed row's turn may be running and could not read it, even after a requeue
 * has put the row back to pending. Everything here is pure; the reads and the
 * compare-and-set live in AgentEventService.enqueueEvent, the one place every
 * runtime's mentions pass through.
 */

import { Types } from 'mongoose';

type Payload = Record<string, unknown>;

/** Rows per (agent, pod, place) worth reading: a live queue here is short. */
export const LIVE_MENTION_LIMIT = 5;
/** Messages one row can carry beyond its own. Bounds the prompt, not the delivery: the next one opens a row. */
export const MAX_COALESCED = 8;
/**
 * A delivered row older than this is not a running turn. It is the default
 * requeue threshold: a live driver renews deliveredAt, so past this the row is
 * waiting to be requeued, and saying "while your turn was running" would be false.
 */
export const RUNNING_TURN_WINDOW_MS = 10 * 60 * 1000;
/**
 * The oldest row a mention may join. A joined message shares the row's age, so
 * this keeps it clear of what keys on createdAt: the 30-minute stranded close
 * and the 168-hour retention delete. A row this old also has a slow reader, so
 * an own row costs little.
 */
export const JOINABLE_ROW_AGE_MS = 10 * 60 * 1000;

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * A username inside kernel-voice text. Registration applies no pattern, so a
 * stranger's chosen text would otherwise sit inside a frame on someone else's
 * message. Same rule as refusedItemRef in cli/src/lib/content-refusal.js.
 */
const asHandle = (value: unknown): string => (
  asText(value).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'unknown'
);

const isUserId = (value: unknown): boolean => (
  (typeof value === 'string' && value !== '') || value instanceof Types.ObjectId
);

const isAbsentOrScalar = (value: unknown): boolean => (
  value === undefined || value === null || typeof value === 'string' || typeof value === 'number'
);

/**
 * One person-or-agent message addressed to this agent. Kernel wakes reuse the
 * chat.mention type so deployed wrappers read them; they join nothing, and
 * samePlaceFilter keeps them from being joined. A context-overflow retry is a
 * row being replayed, not a new message: joined to another row it would drop
 * its own joined messages and restart its retry count. Its id fields reach
 * Mongo queries, and a caller may supply this payload, so non-scalars stay out.
 */
export const isCoalescibleMention = (type: unknown, payload: Payload | undefined): boolean => (
  (type === 'chat.mention' || type === 'thread.mention')
  && Boolean(payload?.messageId)
  && isUserId(payload?.userId)
  && isAbsentOrScalar(payload?.threadRootId)
  && typeof payload?.rawContent === 'string'
  && typeof payload?.content === 'string'
  && !payload?.triggerAuthor
  && !payload?.welcomeWake
  && !payload?.assignedTaskWake
  && !payload?.boardWake
  && payload?._contextOverflowRetryCount === undefined
  && payload?.coalesced === undefined
);

/**
 * Rows in the same place as this mention: one thread, or the main channel. A
 * comment thread carries a `thread` object rather than a thread root, so it
 * matches nothing here, in either direction.
 */
export const samePlaceFilter = (payload: Payload): Record<string, unknown> => {
  const root = payload.threadRootId;
  return {
    'payload.messageId': { $exists: true },
    'payload.thread': null,
    'payload.triggerAuthor': null,
    'payload.welcomeWake': null,
    'payload.assignedTaskWake': null,
    'payload.boardWake': null,
    'payload.threadRootId': typeof root === 'string' || typeof root === 'number' ? root : null,
  };
};

export const coalescedEntry = (payload: Payload): Payload => ({
  messageId: String(payload.messageId),
  userId: String(payload.userId),
  username: payload.username,
  rawContent: payload.rawContent,
  createdAt: payload.createdAt,
  ...(payload.handoffCue ? { handoffCue: payload.handoffCue } : {}),
});

const entriesOf = (payload: Payload | undefined): Payload[] => (
  Array.isArray(payload?.coalesced) ? payload?.coalesced as Payload[] : []
);

/** Whether the row already carries this message, as its own or a joined one. */
export const carriesMessage = (payload: Payload | undefined, messageId: unknown): boolean => (
  String(payload?.messageId) === String(messageId)
  || entriesOf(payload).some((entry) => entry.messageId === String(messageId))
);

/**
 * The payload a turn reads. Joined messages render at delivery, so a row
 * holds structured entries and every delivery path shows the same text.
 * `rawContent` grows too: programs read it instead of `content` (F109), and a
 * message they cannot see would be a lost mention.
 */
export const withCoalesced = (payload: Payload | undefined): Payload | undefined => {
  const entries = entriesOf(payload);
  if (!payload || entries.length === 0) return payload;
  const lead = entries.length === 1
    ? '[One more message for you here arrived before this turn started, so it is part of this turn. '
      + 'Read it with the message above and answer both. It may ask something different.]'
    : `[${entries.length} more messages for you here arrived before this turn started, so they are part of `
      + 'this turn. Read them with the message above and answer all of them. They may ask different things.]';
  const blocks = entries.map((entry) => [
    `[From @${asHandle(entry.username)}, message ${asText(entry.messageId)}]`,
    ...(entry.handoffCue ? [asText(entry.handoffCue)] : []),
    asText(entry.rawContent),
  ].join('\n'));
  return {
    ...payload,
    content: [`${asText(payload.content)}`, lead, ...blocks].join('\n\n'),
    rawContent: [asText(payload.rawContent), ...entries.map((entry) => asText(entry.rawContent))].join('\n\n'),
  };
};

/**
 * Whether a turn's text was written by anyone but `payload.userId`. Authority
 * follows the row's author, so a turn carrying someone else's words gets none
 * of what that author's own words would unlock.
 */
export const carriesOtherAuthors = (payload: unknown): boolean => {
  const row = payload as Payload | null | undefined;
  return entriesOf(row ?? undefined).some((entry) => entry.userId !== String(row?.userId));
};

/**
 * The inline mark on a mention that could not join: models act on the frame,
 * not on metadata. Which exit it leads with depends on who is asking. Whether a
 * reply already covers a message is a reading of both, so the kernel leaves
 * that to the model and only tells it the order things happened in.
 */
export const midTurnFrame = ({ earlier, sameAsker, username }: {
  earlier: Payload; sameAsker: boolean; username: unknown;
}): string => {
  const place = `your turn on message ${asText(earlier.messageId)} from @${asHandle(earlier.username)}`;
  return sameAsker
    ? `[This message reached you while ${place} was running. That turn could not see it. Check what you `
      + 'posted before you act. Do not answer twice, and do not retract or repost: if your reply covers this, '
      + 'return NO_REPLY; if this adds something, answer only that. If that turn posted nothing, answer normally.]'
    : `[@${asHandle(username)} wrote this while ${place} was running. That turn could not see it, `
      + 'and this is a different person, so answer them. Check what you posted first so you do not repeat it. '
      + 'Return NO_REPLY only if that reply already answers them.]';
};
