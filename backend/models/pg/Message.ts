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
  /**
   * True when the query FAILED and `count: 0` is therefore not a measurement.
   * Without this the caller cannot tell a Postgres outage from a quiet pod —
   * they return byte-identical values, and the quiet-pod reading is shipped
   * into every agent's heartbeat prompt (schedulerService.buildHeartbeatActivityHint).
   */
  unavailable?: boolean;
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
    // Already RESOLVED and validated by services/threadRootResolver — this
    // model does not decide precedence. When null the SQL derives from the
    // reply edge, which is the pre-existing behaviour and what the backfill
    // and explicit replies rely on.
    resolvedThreadRootId: number | null = null,
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
    // TWO SHAPES since @ux-lead's 56879 amendment. An ordinary in-thread post
    // carries NO reply edge — the composer sends thread_root_id explicitly, so
    // joining a thread never pings the root's author. Explicit replies and the
    // backfill still derive. `COALESCE($7, <derivation>)` is that precedence in
    // one line: explicit wins, derivation fills. Reconciling the two (and
    // rejecting a mismatch) happens in services/threadRootResolver, before
    // this runs — a model that silently picked a winner would hide a caller's
    // contradictory belief about which thread a message is in.
    //
    // The `::int` casts are explicit on purpose. Postgres infers them fine
    // either way, but without them the scalar subquery is typed as an array by
    // pg-mem — which is what lets this exact query be exercised at the unit
    // tier instead of only against a real server. A cast that costs nothing in
    // production and buys a fast test everywhere is worth writing down.
    const query = `
      INSERT INTO messages (pod_id, user_id, content, message_type, reply_to_message_id, payload, thread_root_id)
      SELECT $1, $2, $3, $4, $5::int, $6,
             COALESCE(
               $7::int,
               (SELECT COALESCE(parent.thread_root_id, parent.id)
                  FROM messages parent
                 WHERE parent.id = $5::int)
             )::int
      RETURNING *
    `;
    try {
      const result = await (pool as PgPool).query(query, [
        podId, userId, content || '', messageType, replyToMessageId || null,
        payload == null ? null : JSON.stringify(payload),
        resolvedThreadRootId ?? null,
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
    // Scope the read to one thread: rows whose thread_root_id matches, PLUS
    // the root row itself (a root carries NULL, not its own id — see the
    // derivation in create()). This is what makes agent-side thread reads
    // cheaper than paging the whole pod (TASK-052's cue depends on it).
    threadRootId: string | null = null,
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
      if (threadRootId) {
        const p = queryParams.length + 1;
        query += ` AND (m.thread_root_id = $${p}::int OR m.id = $${p}::int)`;
        queryParams.push(threadRootId);
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
  /**
   * Re-root chains an ancestor's deletion orphaned (TASK-043).
   *
   * `thread_root_id` is ON DELETE SET NULL, which is right for the row being
   * pointed at and wrong for everything below it. Delete root R from
   * R <- C <- G and Postgres nulls BOTH pointers:
   *
   *   C : reply_to -> NULL (its own FK), thread_root_id -> NULL   correct — C
   *       is now a root, and a root's thread_root_id is NULL by design.
   *   G : reply_to = C (ALIVE), thread_root_id -> NULL            WRONG — G's
   *       root should now be C, and nothing sets it.
   *
   * G then matches `reply_to_message_id IS NOT NULL AND thread_root_id IS NULL`
   * permanently: it is not a dangling edge (its parent is alive), so the
   * `reply_to_message_id` FK cannot help, and no write path revisits it.
   * @sprint-review found it (57204) and the distinction from the dangling-edge
   * case is the part that makes it easy to mis-close.
   *
   * The data is recoverable because the CHAIN is intact — only the pointer was
   * cleared. So this is derivation-on-write applied repeatedly: the same
   * COALESCE-of-parent expression `create` uses, run against parents that
   * already know their own root. Each pass fixes one level, so a chain of
   * depth d converges in d passes.
   *
   * (Deliberately not quoting that expression verbatim here. It appears twice
   * in this file — once in create's comment, once in its SQL — and
   * threadRootDerivation.pgmem.test.js pins the count at two, because a
   * first-match text mutation must land on the comment and not the SQL. A
   * third copy silently changes which one a probe hits. My own guard caught
   * this edit, which is the guard working.)
   *
   * Iterative rather than a recursive CTE ON PURPOSE. The backfill uses
   * `WITH RECURSIVE` and pg-mem cannot run it, which pushes its only coverage
   * to tier 1. This form is plain SQL, so the repair and its regression test
   * run at the unit tier — which is where a retention bug should be provable,
   * since reproducing it needs a DELETE and not a fixture.
   */
  static async reRootOrphanedChains(maxPasses = 32): Promise<{ reRooted: number; passes: number }> {
    let reRooted = 0;
    let passes = 0;
    for (let i = 0; i < maxPasses; i += 1) {
      // Read the level, then write it by id. `UPDATE ... FROM` with a
      // self-join is the natural single statement and pg-mem cannot run it
      // ("Unknown alias"), which would push this repair's only coverage to
      // tier 1 — the same trap the recursive CTE in the backfill fell into.
      // A JOINed SELECT plus keyed UPDATEs runs on both, and the population
      // is bounded by one delete's orphans.
      //
      // Only from a parent that KNOWS its root: either it is itself a root
      // (reply_to IS NULL) or it has been rooted already. Without that guard a
      // pass could copy one NULL onto another and report progress forever.
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await (pool as PgPool).query(
        `SELECT m.id AS id, COALESCE(p.thread_root_id, p.id) AS root
           FROM messages m
           JOIN messages p ON m.reply_to_message_id = p.id
          WHERE m.thread_root_id IS NULL
            AND (p.reply_to_message_id IS NULL OR p.thread_root_id IS NOT NULL)`,
      );
      for (const r of rows as Array<{ id: number; root: number }>) {
        // eslint-disable-next-line no-await-in-loop
        await (pool as PgPool).query(
          'UPDATE messages SET thread_root_id = $2::int WHERE id = $1::int',
          [r.id, r.root],
        );
      }
      const n = rows.length;
      passes += 1;
      reRooted += n;
      if (n === 0) break;
    }
    return { reRooted, passes };
  }

  static async deleteOlderThan(
    days: number,
    protectedPodIds: string[] = [],
  ): Promise<{ deleted: number; reRooted: number | null }> {
    if (!Number.isFinite(days) || days <= 0) {
      return { deleted: 0, reRooted: 0 };
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

    // Repair before returning. Deleting a thread root orphans everything below
    // it (see reRootOrphanedChains), and the caller has no way to know it
    // happened — the delete reports rows removed, not rows corrupted. Doing it
    // here rather than in the retention cron means every caller of this method
    // gets it, including a future one written by someone who never read
    // TASK-043.
    let reRooted: number | null = 0;
    if (deleted > 0) {
      try {
        const repair = await Message.reRootOrphanedChains();
        reRooted = repair.reRooted;
        if (repair.reRooted > 0) {
          console.log(
            `[pg-retention] re-rooted ${repair.reRooted} orphaned reply row(s) `
            + `in ${repair.passes} pass(es) after deleting ${deleted}`,
          );
        }
      } catch (err) {
        // Never fail the delete for a repair. The rows are already gone; a
        // failed re-root leaves an over-expand, which the reader treats as
        // unknown and renders expanded — noisy and non-destructive. Throwing
        // here would make retention look broken for a cosmetic consequence.
        console.warn('[pg-retention] re-root after delete failed:', (err as Error).message);
        // The delete happened; retaining a zero here would make the ledger
        // claim the repair executed and found nothing. Preserve that unknown.
        reRooted = null;
      }
    }
    return { deleted, reRooted };
  }

  /**
   * Counts and a last-seen stamp for the heartbeat's pod-selection pass.
   *
   * Metadata ONLY, and deliberately so. This used to run a second query — the
   * three most recent messages, joined to `users` for a username — because
   * 089d0058 shipped them into `activityHint.recentMessages` for the model to
   * read. 8608060d removed that field 23 minutes later ("agents fetch chat
   * messages themselves via commonly_get_messages"), but removed it only from
   * the CONSUMER. The producer kept running the join, per pod, per heartbeat
   * tick, for five months, and nothing in the repo ever read the result.
   *
   * Found by @sprint-review (57711) auditing this query for a MISSING column
   * (`thread_root_id`). The right answer was that adding one would have been
   * adding a field to dead code. Worth remembering when a projection looks
   * incomplete: check that it has a reader before deciding what it owes them.
   */
  static async findActivityHint(podId: unknown, since: unknown): Promise<ActivityHintResult> {
    const podIdStr = (podId as { toString(): string } | undefined)?.toString();
    if (!podIdStr) return { count: 0, lastAt: null };
    try {
      const statsResult = await (pool as PgPool).query(
        `SELECT COUNT(*) AS count, MAX(created_at) AS last_at
           FROM messages
          WHERE pod_id = $1 AND created_at >= $2 AND message_type != 'system'`,
        [podIdStr, since],
      );
      const stats = (statsResult.rows[0] || {}) as { count?: string; last_at?: unknown };
      return {
        count: parseInt(String(stats.count || 0), 10),
        lastAt: stats.last_at || null,
      };
    } catch (error) {
      const e = error as { message?: string };
      console.error('Error in findActivityHint:', e.message);
      return { count: 0, lastAt: null, unavailable: true };
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

  // One row per user: each given user's most-recent non-system message in ONE
  // pod. Powers the Your Team featured card's line 2 (last-message snippet) —
  // the inverse shape of findLastMessageByUserPerPod below.
  static async findLastMessagePerUserInPod(
    podId: unknown,
    userIds: unknown[],
  ): Promise<Array<{ userId: string; content: string; createdAt: unknown }>> {
    if (!podId || !userIds || !userIds.length) return [];
    try {
      const pid = (podId as { toString(): string }).toString();
      const userIdStrs = userIds.map((id) => (id as { toString(): string } | undefined)?.toString()).filter(Boolean);
      if (!userIdStrs.length) return [];
      const result = await (pool as PgPool).query(
        `SELECT DISTINCT ON (user_id) user_id, content, created_at
         FROM messages
         WHERE pod_id = $1 AND user_id = ANY($2) AND message_type != 'system'
         ORDER BY user_id, created_at DESC`,
        [pid, userIdStrs],
      );
      return (result.rows as Array<{ user_id: string; content: string; created_at: unknown }>).map((r) => ({
        userId: r.user_id,
        content: r.content,
        createdAt: r.created_at,
      }));
    } catch (error) {
      const e = error as { message?: string };
      console.error('Error in findLastMessagePerUserInPod:', e.message);
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
