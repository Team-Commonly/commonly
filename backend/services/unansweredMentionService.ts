import { askedSomeoneElse } from './mentionCoalesce';
import { emitUnansweredMentionLine } from './systemActionLineService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');

/**
 * TASK-656. The event types that mean a person is waiting on this agent: the
 * wrapper's PERSON_WAITING_EVENT_TYPES (cli/src/commands/agent.js). When one
 * exhausts the requeue cap, the person gets one visible line instead of
 * silence.
 */
export const PERSON_WAITING_EVENT_TYPES: readonly string[] = ['chat.mention', 'thread.mention', 'dm.message'];

interface RetiredEvent {
  agentName?: string;
  instanceId?: string;
  podId?: unknown;
  attempts?: number;
  createdAt?: Date | string;
  payload?: Record<string, unknown> | null;
}

interface PgPool {
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * A message a retired row was carrying: its own, then any joined to it
 * (ADR-018 D6.5). Each person waiting gets their own line, and one who asked
 * someone else isn't waiting on this agent. Not `notAnAsk`: a message that
 * carried on from the agent is one too, and that person is waiting.
 */
const carriedMessages = (event: RetiredEvent): Array<{ userId: unknown; messageId: unknown; since: Date }> => {
  const payload = (event.payload || {}) as Record<string, unknown>;
  const rowSince = new Date(event.createdAt || 0);
  const joined = (Array.isArray(payload.coalesced) ? payload.coalesced : []) as unknown[];
  return [
    ...(askedSomeoneElse(payload) ? [] : [{ userId: payload.userId, messageId: payload.messageId, since: rowSince }]),
    ...joined
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .filter((entry) => !entry.askedSomeoneElse)
      .map((entry) => {
        const sentAt = new Date(entry.createdAt as string);
        return {
          userId: entry.userId,
          messageId: entry.messageId,
          since: Number.isNaN(sentAt.getTime()) ? rowSince : sentAt,
        };
      }),
  ];
};

/**
 * The messages on this row that a person sent. Empty for a wake from the
 * kernel (assigned work, a board change) and for an agent's message: nobody
 * is waiting on those. The event type can't say this, because an agent's DM
 * arrives as chat.mention too.
 */
export async function messagesFromPeople(
  event: RetiredEvent,
): Promise<ReturnType<typeof carriedMessages>> {
  const payload = (event.payload || {}) as Record<string, unknown>;
  if (payload.triggerAuthor === 'kernel' || payload.assignedTaskWake === true || payload.boardWake === true) {
    return [];
  }
  const people: ReturnType<typeof carriedMessages> = [];
  for (const message of carriedMessages(event)) {
    const senderId = typeof message.userId === 'string' || typeof message.userId === 'number'
      ? String(message.userId) : '';
    if (/^[a-f0-9]{24}$/i.test(senderId)) {
      // eslint-disable-next-line no-await-in-loop -- a row carries at most nine messages
      const sender = await User.findById(senderId).select('isBot').lean() as { isBot?: boolean } | null;
      if (sender && !sender.isBot) people.push(message);
    }
  }
  return people;
}

/**
 * Posts the unanswered-mention line for an event the requeue cap just retired,
 * for each person waiting on it. Returns whether a line was posted. With
 * `stillPending` (F452) the event stays in the queue, so the line says the
 * agent hasn't answered yet, which stays true if it answers later.
 *
 * Silent for a message when:
 * - the wake came from the kernel (assigned work, a board change) or from an
 *   agent: nobody is waiting on it. A welcome wake is a newcomer's first
 *   message, so a row retired here does get this line, but a native turn that
 *   runs on one and fails posts nothing (personAddressedThisTurn);
 * - it was a comment on a post with no pod: there is no room to tell them in;
 * - the agent has posted since the message where an answer to it would sit:
 *   at top level, in the message's thread, or as a reply to it. It was alive
 *   and may have answered without acknowledging, and a line claiming silence
 *   would then be false. Missing a line is better than a wrong one. A post in
 *   another thread was the agent answering someone else (F237), so it doesn't.
 */
/**
 * Whether the agent has posted in the pod after `since`. A platform line stored
 * under the agent's id (`system`) is not the agent posting. With `excludeKernel`,
 * neither is a kernel notice stored as text under it (`author_kind = 'kernel'`,
 * e.g. a failed-turn notice): it answers nobody, so it must not tell the model
 * an earlier turn may have answered. With `answering` (F237), a post in some
 * other thread doesn't count either: under D278 an answer to that message sits
 * at top level, in its thread, or replies to it, so a post elsewhere was the
 * agent talking to someone else. Postgres only: with no pool there is no
 * answer, and each caller says what that means for it.
 */
export async function agentPostedSince(
  pool: PgPool, agentUserId: unknown, podId: unknown, since: Date,
  { excludeKernel = false, answering = null }: {
    excludeKernel?: boolean;
    answering?: { messageId: number; threadRootId: number } | null;
  } = {},
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM messages
     WHERE pod_id = $1 AND user_id = $2 AND created_at > $3 AND message_type <> 'system'
     ${excludeKernel ? "AND (author_kind IS NULL OR author_kind <> 'kernel')" : ''}
     ${answering ? 'AND (thread_root_id IS NULL OR thread_root_id = $4 OR reply_to_message_id = $5)' : ''}
     LIMIT 1`,
    [String(podId), String(agentUserId), since,
      ...(answering ? [answering.threadRootId, answering.messageId] : [])],
  );
  return rows.length > 0;
}

// The message's conversation, for `answering`: its thread, or the message
// itself when it sits at top level. Null when either id isn't a Postgres row
// id, which keeps the old reading (any post since counts).
const conversationOf = (messageId: unknown, threadRootId: unknown) => {
  const asId = (value: unknown) => (/^\d+$/.test(String(value ?? '')) ? Number(value) : null);
  const message = asId(messageId);
  if (message === null) return null;
  const root = threadRootId === undefined || threadRootId === null ? message : asId(threadRootId);
  return root === null ? null : { messageId: message, threadRootId: root };
};

/**
 * F242: the delivered rows whose agent has posted in their pod since their
 * newest message was sent. Ids of the rows to mark; empty without Postgres or
 * when the agent has no user. A failed read throws, and the caller delivers
 * unmarked: a lost turn is worse than a missing mark.
 */
export async function rowsPostedSince(
  agentName: string, instanceId: string,
  rows: Array<{ _id?: unknown; podId?: unknown; since: Date }>,
): Promise<Set<string>> {
  const marked = new Set<string>();
  if (rows.length === 0) return marked;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg') as { pool: PgPool | null };
  if (!pool) return marked;
  const agent = await User.findOne({
    isBot: true,
    'botMetadata.agentName': AgentIdentityService.resolveAgentType(String(agentName || '')),
    'botMetadata.instanceId': String(instanceId || 'default'),
  }).select('_id').lean() as { _id: unknown } | null;
  if (!agent) return marked;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- one delivered page, bounded by its limit
    if (await agentPostedSince(pool, agent._id, row.podId, row.since, { excludeKernel: true })) {
      marked.add(String(row._id));
    }
  }
  return marked;
}

export async function noteUnansweredMention(
  event: RetiredEvent,
  { stillPending = false }: { stillPending?: boolean } = {},
): Promise<boolean> {
  const payload = (event.payload || {}) as Record<string, unknown>;
  // A comment on a post with no pod carries some pod of the commenter's.
  const comment = payload.thread as { postPodId?: unknown } | null | undefined;
  if (comment && !comment.postPodId) return false;
  const waiting = await messagesFromPeople(event);
  if (waiting.length === 0) return false;

  const agentName = AgentIdentityService.resolveAgentType(String(event.agentName || ''));
  const instanceId = String(event.instanceId || 'default');
  const agent = await User.findOne({
    isBot: true,
    'botMetadata.agentName': agentName,
    'botMetadata.instanceId': instanceId,
  }).select('username profilePicture botMetadata').lean() as {
    _id: unknown; username?: string; profilePicture?: string | null;
    botMetadata?: { displayName?: string; instanceId?: string };
  } | null;
  if (!agent) return false;

  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg') as { pool: PgPool | null };
  if (!pool) return false;
  const podId = String(event.podId || '');
  let posted = false;
  for (const { messageId, since } of waiting) {
    const answering = conversationOf(messageId, payload.threadRootId);
    // eslint-disable-next-line no-await-in-loop -- a row carries at most nine messages
    if (!await agentPostedSince(pool, agent._id, podId, since, { answering })) {
      // eslint-disable-next-line no-await-in-loop
      await emitUnansweredMentionLine({
        podId,
        actorUserId: String(agent._id),
        actorUsername: agent.username || agentName,
        actorAvatarUrl: agent.profilePicture || null,
        actorIsBot: true,
        agentLabel: AgentIdentityService.resolveAgentDisplayLabel(agent, agentName),
        attempts: Number(event.attempts) || 0,
        ...(stillPending ? { stillPending: true } : {}),
        messageId: (messageId as string | number | null | undefined) ?? null,
        threadRootId: (payload.threadRootId as string | number | null | undefined) ?? null,
      });
      posted = true;
    }
  }
  return posted;
}
