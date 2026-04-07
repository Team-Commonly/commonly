// eslint-disable-next-line global-require
const { pool } = require('../../config/db-pg');

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

interface MessageRow {
  id: string;
  pod_id: string;
  user_id: string;
  content: string;
  message_type: string;
  reply_to_message_id?: string;
  created_at: unknown;
  updated_at?: unknown;
  username?: string;
  profile_picture?: string;
  is_bot?: boolean;
  reply_msg_id?: string;
  reply_content?: string;
  reply_user_id?: string;
  reply_username?: string;
}

interface FormattedMessage extends MessageRow {
  _id: string;
  text: string;
  messageType: string;
  createdAt: unknown;
  userId: { _id: string; username: string; profilePicture?: string } | string;
  replyTo: { id: string; content: string; username: string; userId: string } | null;
}

interface ActivityHintResult {
  count: number;
  lastAt: unknown;
  recentMessages: Array<{ id: string; username: string; content: string; createdAt: unknown }>;
}

interface PodActivityEntry {
  podId: string;
  lastAt: unknown;
}

function formatMessage(msg: MessageRow): FormattedMessage {
  const messageId = msg.id ? msg.id.toString() : '';
  const userId = msg.user_id || '';
  return {
    ...msg,
    _id: messageId,
    id: messageId,
    content: msg.content || '',
    text: msg.content || '',
    messageType: msg.message_type || 'text',
    createdAt: msg.created_at,
    user_id: userId,
    userId: msg.username
      ? { _id: userId, username: msg.username || 'Unknown User', profilePicture: msg.profile_picture }
      : userId,
    replyTo: msg.reply_msg_id
      ? {
          id: msg.reply_msg_id.toString(),
          content: (msg.reply_content || '').slice(0, 150),
          username: msg.reply_username || 'Unknown',
          userId: msg.reply_user_id || '',
        }
      : null,
  };
}

class Message {
  static async create(
    podId: string,
    userId: string,
    content: string,
    messageType = 'text',
    replyToMessageId: string | null = null,
  ): Promise<MessageRow> {
    console.log('Creating message with params:', {
      podId, userId, content, messageType, podIdType: typeof podId,
    });
    const query = `
      INSERT INTO messages (pod_id, user_id, content, message_type, reply_to_message_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    try {
      const result = await (pool as PgPool).query(query, [
        podId, userId, content || '', messageType, replyToMessageId || null,
      ]);
      await (pool as PgPool).query(
        'UPDATE pods SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [podId],
      );
      return result.rows[0] as MessageRow;
    } catch (error) {
      const e = error as { message?: string };
      console.error('SQL Error in Message.create:', e.message);
      console.error('Query parameters:', { podId, userId, content, messageType });
      throw error;
    }
  }

  static async findByPodId(
    podId: string,
    limit = 50,
    before: string | null = null,
  ): Promise<FormattedMessage[]> {
    try {
      let query = `
        SELECT
          m.id, m.pod_id, m.user_id, m.content, m.message_type,
          m.reply_to_message_id, m.created_at, m.updated_at,
          u._id as user_db_id, u.username, u.profile_picture, u.is_bot,
          rm.id as reply_msg_id, rm.content as reply_content,
          rm.user_id as reply_user_id, ru.username as reply_username
        FROM messages m
        LEFT JOIN users u ON m.user_id = u._id
        LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
        LEFT JOIN users ru ON rm.user_id = ru._id
        WHERE m.pod_id = $1
      `;
      const queryParams: unknown[] = [podId];
      if (before) {
        query += ' AND m.created_at < $2';
        queryParams.push(before);
      }
      query += ` ORDER BY m.created_at DESC LIMIT $${queryParams.length + 1}`;
      queryParams.push(limit);

      const result = await (pool as PgPool).query(query, queryParams);
      const rows = (result.rows as MessageRow[]).slice().reverse();
      return rows.map(formatMessage);
    } catch (error) {
      const e = error as { message?: string };
      console.error('Error in findByPodId:', e.message);
      throw error;
    }
  }

  static async findById(id: string): Promise<FormattedMessage | null> {
    try {
      const query = `
        SELECT
          m.id, m.pod_id, m.user_id, m.content, m.message_type,
          m.reply_to_message_id, m.created_at, m.updated_at,
          u._id as user_db_id, u.username, u.profile_picture,
          rm.id as reply_msg_id, rm.content as reply_content,
          rm.user_id as reply_user_id, ru.username as reply_username
        FROM messages m
        LEFT JOIN users u ON m.user_id = u._id
        LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
        LEFT JOIN users ru ON rm.user_id = ru._id
        WHERE m.id = $1
      `;
      const result = await (pool as PgPool).query(query, [id]);
      if (result.rows.length === 0) return null;
      return formatMessage(result.rows[0] as MessageRow);
    } catch (error) {
      const e = error as { message?: string };
      console.error('Error in findById:', e.message);
      throw error;
    }
  }

  static async update(id: string, content: string): Promise<MessageRow | undefined> {
    const query = `
      UPDATE messages
      SET content = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `;
    const result = await (pool as PgPool).query(query, [content, id]);
    return result.rows[0] as MessageRow | undefined;
  }

  static async delete(id: string): Promise<MessageRow | undefined> {
    const query = `DELETE FROM messages WHERE id = $1 RETURNING *`;
    const result = await (pool as PgPool).query(query, [id]);
    return result.rows[0] as MessageRow | undefined;
  }

  static async deleteByPodId(podId: string): Promise<MessageRow[]> {
    const query = `DELETE FROM messages WHERE pod_id = $1 RETURNING *`;
    const result = await (pool as PgPool).query(query, [podId]);
    return result.rows as MessageRow[];
  }

  static async findActivityHint(podId: unknown, since: unknown): Promise<ActivityHintResult> {
    const podIdStr = (podId as { toString(): string } | undefined)?.toString();
    if (!podIdStr) return { count: 0, lastAt: null, recentMessages: [] };
    try {
      const [statsResult, recentResult] = await Promise.all([
        (pool as PgPool).query(
          `SELECT COUNT(*) AS count, MAX(created_at) AS last_at
           FROM messages
           WHERE pod_id = $1 AND created_at >= $2 AND message_type != 'system'`,
          [podIdStr, since],
        ),
        (pool as PgPool).query(
          `SELECT m.id, m.content, u.username, m.created_at
           FROM messages m
           LEFT JOIN users u ON m.user_id = u._id
           WHERE m.pod_id = $1 AND m.created_at >= $2 AND m.message_type != 'system'
           ORDER BY m.created_at DESC LIMIT 3`,
          [podIdStr, since],
        ),
      ]);
      const stats = (statsResult.rows[0] || {}) as { count?: string; last_at?: unknown };
      const recentMessages = (recentResult.rows as Array<{ id?: unknown; username?: string; content?: string; created_at?: unknown }>)
        .slice().reverse().map((m) => ({
          id: m.id?.toString() || '',
          username: m.username || 'unknown',
          content: (m.content || '').slice(0, 120),
          createdAt: m.created_at,
        }));
      return {
        count: parseInt(String(stats.count || 0), 10),
        lastAt: stats.last_at || null,
        recentMessages,
      };
    } catch (error) {
      const e = error as { message?: string };
      console.error('Error in findActivityHint:', e.message);
      return { count: 0, lastAt: null, recentMessages: [] };
    }
  }

  static async findMostRecentPodActivity(
    podIds: unknown[],
    since: unknown,
  ): Promise<PodActivityEntry[]> {
    if (!podIds || !podIds.length) return [];
    try {
      const podIdStrs = podIds.map((id) => (id as { toString(): string } | undefined)?.toString()).filter(Boolean);
      if (!podIdStrs.length) return [];
      const result = await (pool as PgPool).query(
        `SELECT pod_id, MAX(created_at) AS last_at
         FROM messages
         WHERE pod_id = ANY($1) AND created_at >= $2 AND message_type != 'system'
         GROUP BY pod_id
         ORDER BY last_at DESC`,
        [podIdStrs, since],
      );
      return (result.rows as Array<{ pod_id: string; last_at: unknown }>).map((r) => ({
        podId: r.pod_id,
        lastAt: r.last_at,
      }));
    } catch (error) {
      const e = error as { message?: string };
      console.error('Error in findMostRecentPodActivity:', e.message);
      return [];
    }
  }
}

module.exports = Message;
