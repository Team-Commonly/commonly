// System action lines are kernel-authored facts. They bypass the ordinary
// message writer so they cannot create mention attention, wake agents, or
// advance a pod's human-message unread timestamp.
export interface SystemActionLine {
  podId: string;
  actorUserId: string;
  actorName: string;
  action: 'task-claimed';
  taskId: string;
}

interface PgMessageRow {
  id: number | string;
  created_at: Date | string;
}

export async function emitSystemActionLine(line: SystemActionLine): Promise<void> {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg') as {
    pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: PgMessageRow[] }> } | null;
  };
  if (!pool) throw new Error('System action lines require PostgreSQL');

  const content = `${line.actorName} claimed ${line.taskId}`;
  const payload = {
    kind: 'system-action',
    action: line.action,
    actorName: line.actorName,
    taskId: line.taskId,
  };
  const { rows } = await pool.query(
    `INSERT INTO messages (pod_id, user_id, content, message_type, payload)
     VALUES ($1, $2, $3, 'system', $4::jsonb)
     RETURNING id, created_at`,
    [line.podId, line.actorUserId, content, JSON.stringify(payload)],
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
      user: { username: line.actorName },
      thread_root_id: null,
      reply_to_message_id: null,
    });
  } catch (error) {
    // The row is already durable; reconnect fetches it. A socket failure
    // cannot turn a successful claim into an HTTP error or a duplicate line.
    console.warn('[system-action] socket emit failed:', (error as Error).message);
  }
}
