// System action lines are kernel-authored facts. They bypass the ordinary
// message writer so they cannot create mention attention, wake agents, or
// advance a pod's human-message unread timestamp.
export interface SystemActionLine {
  podId: string;
  actorUserId: string;
  actorName: string;
  actorUsername: string;
  actorAvatarUrl: string | null;
  actorIsBot: boolean;
  action: 'task-claimed';
  taskId: string;
}

interface PgMessageRow {
  id: number | string;
  created_at: Date | string;
}

interface SystemLineActor {
  podId: string;
  actorUserId: string;
  actorUsername: string;
  actorAvatarUrl: string | null;
  actorIsBot: boolean;
}

// What a kernel line places it next to: the thread a person asked in, and the
// message it is about. Both are PG message ids; anything else is dropped.
interface SystemLinePlacement {
  threadRootId?: string | number | null;
  replyToMessageId?: string | number | null;
}

const pgMessageId = (value: unknown): number | null => (
  /^\d+$/.test(String(value ?? '')) ? Number(value) : null
);

async function insertSystemLine(
  line: SystemLineActor,
  content: string,
  payload: Record<string, unknown>,
  placement: SystemLinePlacement = {},
): Promise<void> {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg') as {
    pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: PgMessageRow[] }> } | null;
  };
  if (!pool) throw new Error('System action lines require PostgreSQL');

  const threadRootId = pgMessageId(placement.threadRootId);
  const replyToMessageId = pgMessageId(placement.replyToMessageId);
  const { rows } = threadRootId === null && replyToMessageId === null
    ? await pool.query(
      `INSERT INTO messages (pod_id, user_id, content, message_type, payload)
       VALUES ($1, $2, $3, 'system', $4::jsonb)
       RETURNING id, created_at`,
      [line.podId, line.actorUserId, content, JSON.stringify(payload)],
    )
    : await pool.query(
      `INSERT INTO messages (pod_id, user_id, content, message_type, payload, thread_root_id, reply_to_message_id)
       VALUES ($1, $2, $3, 'system', $4::jsonb, $5, $6)
       RETURNING id, created_at`,
      [line.podId, line.actorUserId, content, JSON.stringify(payload), threadRootId, replyToMessageId],
    );
  const row = rows[0];
  if (!row) throw new Error('System action line was not persisted');

  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { getIO } = require('../config/socket') as {
      getIO: () => { to: (room: string) => { emit: (event: string, data: unknown) => void } } | null;
    };
    getIO()?.to(`pod_${line.podId}`).emit('newMessage', {
      id: String(row.id),
      _id: String(row.id),
      pod_id: line.podId,
      podId: line.podId,
      user_id: line.actorUserId,
      content,
      message_type: 'system',
      messageType: 'system',
      payload,
      created_at: row.created_at,
      createdAt: row.created_at,
      user: {
        username: line.actorUsername,
        profile_picture: line.actorAvatarUrl,
        isBot: line.actorIsBot,
      },
      thread_root_id: threadRootId,
      reply_to_message_id: replyToMessageId,
    });
  } catch (error) {
    // The row is already durable; reconnect fetches it. A socket failure
    // cannot turn a successful claim into an HTTP error or a duplicate line.
    console.warn('[system-action] socket emit failed:', (error as Error).message);
  }
}

export async function emitSystemActionLine(line: SystemActionLine): Promise<void> {
  await insertSystemLine(line, `${line.actorName} claimed ${line.taskId}`, {
    kind: 'system-action',
    action: line.action,
    actorName: line.actorName,
    taskId: line.taskId,
  });
}

/**
 * TASK-656. A person's message to an agent that never answered: delivered up
 * to the requeue cap and never acknowledged, or a webhook POST that failed.
 * Without this line the person waits on silence. It is placed in the thread they asked in, as a reply to their
 * message, and like every system line it wakes no agent.
 */
export interface UnansweredMentionLine extends SystemLineActor {
  agentLabel: string;
  attempts: number;
  messageId: string | number | null;
  threadRootId?: string | number | null;
}

export async function emitUnansweredMentionLine(line: UnansweredMentionLine): Promise<void> {
  const content = `${line.agentLabel} didn't answer this and may be offline. `
    + 'Ask again later, or ask someone else in the pod.';
  await insertSystemLine(line, content, {
    kind: 'system-action',
    action: 'mention-unanswered',
    actorName: line.agentLabel,
    attempts: line.attempts,
  }, { threadRootId: line.threadRootId ?? null, replyToMessageId: line.messageId });
}

/**
 * TASK-655. A person mentioned a Bring your own agent that has never polled.
 * Without this line the mention waits in a queue nobody reads and the person
 * sees silence. Placed as a reply to their mention, like the line above.
 * Callers dedupe with `hasNotConnectedLineToday`: one per agent per UTC day.
 */
export interface NotConnectedLine extends SystemLineActor {
  agentLabel: string;
  agentKey: string;
  messageId: string | number | null;
  threadRootId?: string | number | null;
}

export async function emitNotConnectedLine(line: NotConnectedLine): Promise<void> {
  const content = `${line.agentLabel} isn't connected yet, so it won't see this until it runs. `
    + 'Run the connect command shown on its page.';
  await insertSystemLine(line, content, {
    kind: 'system-action',
    action: 'agent-not-connected',
    actorName: line.agentLabel,
    agentKey: line.agentKey,
  }, { threadRootId: line.threadRootId ?? null, replyToMessageId: line.messageId });
}

/**
 * Whether a not-connected line for this agent already sits in the pod since
 * UTC midnight. A missing pool reads as "already posted": no line is better
 * than a second line the person did not need.
 */
export async function hasNotConnectedLineToday(
  podId: string,
  agentKey: string,
  now: Date = new Date(),
): Promise<boolean> {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg') as {
    pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> } | null;
  };
  if (!pool) return true;
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const { rows } = await pool.query(
    `SELECT 1 FROM messages
     WHERE pod_id = $1 AND message_type = 'system' AND created_at >= $2
       AND payload->>'action' = 'agent-not-connected' AND payload->>'agentKey' = $3
     LIMIT 1`,
    [podId, startOfDay, agentKey],
  );
  return rows.length > 0;
}
