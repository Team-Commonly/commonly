interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount?: number;
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pool } = require('../../config/db-pg') as { pool: PgPool };

interface MessageRow {
  id: string;
  pod_id: string;
  user_id: string;
  content: string;
  message_type: string;
  // ADR-020 D3: structured component payload (approval cards). JSONB; null
  // for ordinary messages.
  payload?: unknown;
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
  userId: { _id: string; username: string; profilePicture?: string; isBot?: boolean } | string;
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
      ? {
        _id: userId,
        username: msg.username || 'Unknown User',
        profilePicture: msg.profile_picture,
        // The SELECT has fetched u.is_bot since the beginning; this mapper was
        // dropping it, so the frontend could never tell an agent's message
        // from a human's without a second lookup. Needed by the avatar tier
        // split (humans get faces, agents get robots).
        isBot: msg.is_bot === true,
      }
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
    payload: unknown = null,
  ): Promise<MessageRow> {
    console.log('Creating message with params:', {
      podId, userId, content, messageType, podIdType: typeof podId,
    });
    // Threading (W-T, TASK-029). The root is DERIVED from the reply edge on
    // write and stored, never walked on read: `reply_to_message_id` carries no
    // index (schema.sql indexes pod_id and created_at only), so resolving a
    // root per read is a sequential scan per level of the chain.
    //
    // One level of derivation is enough for any depth. A reply to a root takes
    // that root's id; a reply to a reply inherits the root the parent already
    // stored. Measured on the live instance before this shipped: 227 reply
    // edges, max chain depth 7, and every one of those deeper links resolves
    // by this same inheritance because the parent was written first.
    //
    // COALESCE(parent.thread_root_id, parent.id) is the whole rule — a parent
    // that is itself a root has NULL there and contributes its own id.
    //
    // Deliberately NOT derived from anything but the reply edge: thread_root_id
    // must never acquire addressing semantics (see schema.sql).
    //
    // The `::int` casts are explicit on purpose. Postgres infers them fine
    // either way, but without them the scalar subquery is typed as an array by
    // pg-mem — which is what lets this exact query be exercised at the unit
    // tier instead of only against a real server. A cast that costs nothing in
    // production and buys a fast test everywhere is worth writing down.
    const query = `
      INSERT INTO messages (pod_id, user_id, content, message_type, reply_to_message_id, payload, thread_root_id)
      SELECT $1, $2, $3, $4, $5::int, $6,
             (SELECT COALESCE(parent.thread_root_id, parent.id)
                FROM messages parent
               WHERE parent.id = $5::int)::int
      RETURNING *
    `;
    try {
      const result = await (pool as PgPool).query(query, [
        podId, userId, content || '', messageType, replyToMessageId || null,
        payload == null ? null : JSON.stringify(payload),
      ]);
      await (pool as PgPool).query(
        'UPDATE pods SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [podId],
      );
      return result.rows[0] as unknown as MessageRow;
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
    // Defense-in-depth clamp at the data layer: callers should pass a bounded
    // limit, but a stray unbounded value must never turn into a million-row
    // SELECT streamed into Node memory.
    const safeLimit = Math.min(200, Math.max(1, Number.parseInt(String(limit), 10) || 50));
    limit = safeLimit;
    try {
      let query = `
        SELECT
          m.id, m.pod_id, m.user_id, m.content, m.message_type, m.payload,
          m.reply_to_message_id,
          -- MUST be selected. Late columns are easy to miss in an explicit
          -- projection, and this one is read by the wake path.
          m.thread_root_id,
          m.created_at, m.updated_at,
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
      const rows = (result.rows as unknown as MessageRow[]).slice().reverse();
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
          m.id, m.pod_id, m.user_id, m.content, m.message_type, m.payload,
          m.reply_to_message_id,
          -- MUST be selected. The controller prefers THIS row over create()'s
          -- RETURNING * (message = populated || created) and hands it to
          -- enqueueMentions, so a column absent from this projection is a
          -- column the wake path cannot see. Ambient thread scoping read
          -- undefined for every message until this line existed — while its
          -- own tests passed, because they build the message object directly
          -- and never travel this path.
          m.thread_root_id,
          m.created_at, m.updated_at,
          u._id as user_db_id, u.username, u.profile_picture, u.is_bot,
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
      return formatMessage(result.rows[0] as unknown as MessageRow);
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
    return result.rows[0] as unknown as MessageRow | undefined;
  }

  // ADR-020 D3: card status transitions rewrite the message's payload so
  // every client (and late loaders) see the authoritative card face.
  static async updatePayload(id: string, payload: unknown): Promise<MessageRow | undefined> {
    const query = `
      UPDATE messages
      SET payload = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `;
    const result = await (pool as PgPool).query(query, [
      payload == null ? null : JSON.stringify(payload), id,
    ]);
    return result.rows[0] as unknown as MessageRow | undefined;
  }

  static async delete(id: string): Promise<MessageRow | undefined> {
    const query = `DELETE FROM messages WHERE id = $1 RETURNING *`;
    const result = await (pool as PgPool).query(query, [id]);
    return result.rows[0] as unknown as MessageRow | undefined;
  }

  static async deleteByPodId(podId: string): Promise<MessageRow[]> {
    const query = `DELETE FROM messages WHERE pod_id = $1 RETURNING *`;
    const result = await (pool as PgPool).query(query, [podId]);
    return result.rows as unknown as MessageRow[];
  }

  /**
   * Bulk-delete messages older than `days` days. Used by the retention cron
   * (pgRetentionService) to enforce the 30-day message retention window on
   * the PostgreSQL chat store.
   *
   * Pods named in PG_RETENTION_EXEMPT_POD_IDS (comma-separated) are skipped.
   * The exemption exists because the delete used to be unconditional and, on
   * 2026-08-05, was discovered to have silently emptied the public showcase
   * pod the landing page points at — the room the product uses to prove
   * itself was erased by the product's own retention policy, and nothing
   * anywhere said so. A showroom, or any publicly-linked pod, must not be on
   * a rolling 30-day self-destruct.
   *
   * Env-var rather than a pod flag, deliberately, for now: the paid tier
   * being designed makes retention a per-account entitlement, and THAT
   * mechanism should own per-pod retention when it lands. An env list is the
   * smallest honest stopgap that cannot drift into being a second tier
   * system — it names specific operator-owned pods, nothing more.
   */
  /*
   * `protectedPodIds` is the entitlement half the comment above anticipated.
   * The caller resolves it (retention policy is not this model's business, and
   * the answer lives in Mongo), and it is UNIONED with the env list rather
   * than replacing it — operator-pinned pods and paid pods are both exempt,
   * for different reasons.
   */
  static async deleteOlderThan(
    days: number,
    protectedPodIds: string[] = [],
  ): Promise<{ deleted: number }> {
    if (!Number.isFinite(days) || days <= 0) {
      return { deleted: 0 };
    }
    const fromEnv = String(process.env.PG_RETENTION_EXEMPT_POD_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const exempt = [...new Set([...fromEnv, ...protectedPodIds.map(String).filter(Boolean)])];
    const query = exempt.length > 0
      ? `DELETE FROM messages WHERE created_at < NOW() - $1::interval AND pod_id != ALL($2) RETURNING id`
      : `DELETE FROM messages WHERE created_at < NOW() - $1::interval RETURNING id`;
    const params: unknown[] = exempt.length > 0
      ? [`${Math.trunc(days)} days`, exempt]
      : [`${Math.trunc(days)} days`];
    const result = await (pool as PgPool).query(query, params);
    const deleted = typeof result.rowCount === 'number'
      ? result.rowCount
      : (Array.isArray(result.rows) ? result.rows.length : 0);
    return { deleted };
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

  // One row per pod: the given user's most-recent non-system message in each pod.
  // Powers the agent-profile "pods" list (their last message + when, per pod).
  static async findLastMessageByUserPerPod(
    userId: unknown,
    podIds: unknown[],
  ): Promise<Array<{ podId: string; content: string; createdAt: unknown }>> {
    if (!userId || !podIds || !podIds.length) return [];
    try {
      const uid = (userId as { toString(): string }).toString();
      const podIdStrs = podIds.map((id) => (id as { toString(): string } | undefined)?.toString()).filter(Boolean);
      if (!podIdStrs.length) return [];
      const result = await (pool as PgPool).query(
        `SELECT DISTINCT ON (pod_id) pod_id, content, created_at
         FROM messages
         WHERE user_id = $1 AND pod_id = ANY($2) AND message_type != 'system'
         ORDER BY pod_id, created_at DESC`,
        [uid, podIdStrs],
      );
      return (result.rows as Array<{ pod_id: string; content: string; created_at: unknown }>).map((r) => ({
        podId: r.pod_id,
        content: r.content,
        createdAt: r.created_at,
      }));
    } catch (error) {
      const e = error as { message?: string };
      console.error('Error in findLastMessageByUserPerPod:', e.message);
      return [];
    }
  }
}

export default Message;
export { Message, MessageRow, FormattedMessage };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
