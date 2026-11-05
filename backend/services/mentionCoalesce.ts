/**
 * The shape of ADR-018 D6.5: a second mention of one agent in one place.
 *
 * A mention joins an earlier row only while that row is pending, because a
 * claimed row's turn may be running and could not read it. Everything here is
 * pure; the reads and the compare-and-set live in AgentEventService.enqueueEvent,
 * the one place every runtime's mentions pass through.
 */

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

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * One person-or-agent message addressed to this agent. Kernel wakes reuse the
 * chat.mention type so deployed wrappers read them; they join nothing, and
 * samePlaceFilter keeps them from being joined.
 */
export const isCoalescibleMention = (type: unknown, payload: Payload | undefined): boolean => (
  (type === 'chat.mention' || type === 'thread.mention')
  && Boolean(payload?.messageId)
  && Boolean(payload?.userId)
  && typeof payload?.rawContent === 'string'
  && typeof payload?.content === 'string'
  && !payload?.triggerAuthor
  && !payload?.welcomeWake
  && !payload?.assignedTaskWake
  && !payload?.boardWake
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
    'payload.threadRootId': root === undefined || root === null ? null : root,
  };
};

export const coalescedEntry = (payload: Payload): Payload => ({
  messageId: String(payload.messageId),
  userId: String(payload.userId),
  username: payload.username,
  rawContent: payload.rawContent,
  createdAt: payload.createdAt,
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
  const blocks = entries.map((entry) => (
    `[From @${asText(entry.username) || 'unknown'}, message ${asText(entry.messageId)}]\n${asText(entry.rawContent)}`
  ));
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
  const place = `your turn on message ${asText(earlier.messageId)} from @${asText(earlier.username) || 'unknown'}`;
  return sameAsker
    ? `[This message reached you while ${place} was running. That turn could not see it. Check what you `
      + 'posted before you act. Do not answer twice, and do not retract or repost: if your reply covers this, '
      + 'return NO_REPLY; if this adds something, answer only that. If that turn posted nothing, answer normally.]'
    : `[@${asText(username) || 'unknown'} wrote this while ${place} was running. That turn could not see it, `
      + 'and this is a different person, so answer them. Check what you posted first so you do not repeat it. '
      + 'Return NO_REPLY only if that reply already answers them.]';
};
