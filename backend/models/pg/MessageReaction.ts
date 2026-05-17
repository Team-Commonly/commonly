// Sprint B5: message reactions backend model. Toggle-style (one row per
// (message, user, emoji), unique constraint enforces no duplicates).
// Aggregation for read happens at the SQL level — clients get
// `{emoji: count, mine: emoji[]}` shapes.

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount?: number;
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pool } = require('../../config/db-pg') as { pool: PgPool };

export interface ReactionSummary {
  emoji: string;
  count: number;
  mine: boolean;
  // Reactor user IDs in insertion order (earliest first). Resolved to
  // {username, displayName} downstream by reactionAttributionService —
  // this model stays a thin DB wrapper and doesn't touch the User model.
  userIds: string[];
}

class MessageReaction {
  /** Add (idempotent on the unique constraint — INSERT…ON CONFLICT DO NOTHING). */
  static async add(messageId: string | number, userId: string, emoji: string): Promise<void> {
    await pool.query(
      `INSERT INTO message_reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
      [Number(messageId), userId, emoji],
    );
  }

  /** Remove (idempotent — DELETE matches at most one row per the unique key). */
  static async remove(messageId: string | number, userId: string, emoji: string): Promise<void> {
    await pool.query(
      `DELETE FROM message_reactions
       WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [Number(messageId), userId, emoji],
    );
  }

  /**
   * Aggregated reactions for a single message keyed by emoji. Includes a
   * `mine` flag so frontend can highlight the user's own reactions
   * without a second query.
   */
  static async listForMessage(messageId: string | number, userId: string): Promise<ReactionSummary[]> {
    const result = await pool.query(
      `SELECT emoji,
              COUNT(*)::int AS count,
              BOOL_OR(user_id = $2) AS mine,
              ARRAY_AGG(user_id ORDER BY created_at) AS user_ids
       FROM message_reactions
       WHERE message_id = $1
       GROUP BY emoji
       ORDER BY COUNT(*) DESC, emoji ASC`,
      [Number(messageId), userId],
    );
    return result.rows.map((r) => ({
      emoji: String(r.emoji),
      count: Number(r.count) || 0,
      mine: Boolean(r.mine),
      userIds: Array.isArray(r.user_ids) ? r.user_ids.map(String) : [],
    }));
  }

  /**
   * Bulk fetch reactions for a batch of message IDs — used by the
   * messages list path to avoid N+1. Returns a Map keyed by message id.
   */
  static async listForMessages(
    messageIds: Array<string | number>,
    userId: string,
  ): Promise<Map<string, ReactionSummary[]>> {
    const out = new Map<string, ReactionSummary[]>();
    if (!messageIds.length) return out;
    const ids = messageIds.map((id) => Number(id)).filter((n) => Number.isFinite(n));
    if (!ids.length) return out;
    const result = await pool.query(
      `SELECT message_id,
              emoji,
              COUNT(*)::int AS count,
              BOOL_OR(user_id = $2) AS mine,
              ARRAY_AGG(user_id ORDER BY created_at) AS user_ids
       FROM message_reactions
       WHERE message_id = ANY($1::int[])
       GROUP BY message_id, emoji
       ORDER BY message_id, COUNT(*) DESC, emoji ASC`,
      [ids, userId],
    );
    for (const r of result.rows) {
      const key = String(r.message_id);
      const list = out.get(key) || [];
      list.push({
        emoji: String(r.emoji),
        count: Number(r.count) || 0,
        mine: Boolean(r.mine),
        userIds: Array.isArray(r.user_ids) ? r.user_ids.map(String) : [],
      });
      out.set(key, list);
    }
    return out;
  }
}

export default MessageReaction;
module.exports = MessageReaction;
module.exports.default = MessageReaction;
