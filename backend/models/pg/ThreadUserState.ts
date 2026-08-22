/**
 * ThreadUserState — per-user, per-thread state (W-T, TASK-029).
 *
 * ONE record carrying both `following` and `collapsed`, per the ruling in
 * docs/design/threading-surface-ruling.md, section "One state record, two
 * booleans".
 *
 * Cited by DOC AND SECTION, never by commit sha. #1107 and #1112 were both
 * squash-merged, which rewrote every sha discussed in the pod — 5e7060fd,
 * 392b86e5 and 41707609 all resolve in a working clone that still has the
 * branches and are on NONE of main. A sha citation to a squashed PR is a
 * dangling pointer the moment anyone clones fresh (@ux-lead 56830, who hit
 * the same thing checking their own work): they share the key (user, pod, thread root), so two tables would
 * mean two writes for one gesture. The collapse column ships here rather than
 * in the render PR because the key already exists.
 *
 * A row means "this user has non-default state on this thread". Row PRESENCE
 * carries no meaning on its own — a collapse write creates rows for users who
 * are not following, so `following` has to be a column. If presence meant
 * following, expanding a thread would subscribe you to it.
 *
 * `following` is TRI-STATE on purpose:
 *   NULL  — no explicit choice; defer to the participation default (posted in
 *           the thread or was @-mentioned => following). Resolving that
 *           default is 3/4's job, in the wake path.
 *   TRUE  — explicitly followed.
 *   FALSE — explicitly unfollowed. For a participant this is a MUTE and must
 *           outrank the participation default, which is exactly why a
 *           NOT NULL DEFAULT false would be a bug rather than a simplification.
 */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const { pool } = require('../../config/db-pg');

interface PgPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

export interface ThreadUserStateRow {
  id: number;
  thread_root_id: number;
  user_id: string;
  pod_id: string;
  following: boolean | null;
  collapsed: boolean;
  followed_at: string;
  updated_at: string;
}

/**
 * Upsert exactly ONE column, leaving the other at whatever it already was (or
 * at its schema default if the row is new). Every writer here is a single
 * gesture — a follow toggle must not silently re-collapse an expanded thread,
 * and an expand must not silently subscribe you.
 */
async function upsertOne(
  column: 'following' | 'collapsed',
  threadRootId: number,
  userId: string,
  podId: string,
  value: boolean | null,
): Promise<ThreadUserStateRow> {
  // `column` is never caller-supplied — it is one of two literals chosen by
  // the call sites below, so the interpolation cannot carry user input.
  //
  // The UPDATE set names EXACTLY the target column plus updated_at, per
  // ux-lead's ruling. It previously also wrote
  // `pod_id = EXCLUDED.pod_id`, which was both a deviation and inconsistent
  // with followByParticipation, which never rewrote it. A thread root's pod
  // cannot change — the root implies it — so that write could only ever be a
  // no-op or a bug quietly papered over. If a row's pod_id ever disagrees with
  // the caller's, that is a fact worth surfacing rather than overwriting.
  //
  // On INSERT the other column is not supplied at all, so it takes its schema
  // default: `following` → NULL (defer to participation), `collapsed` → TRUE.
  const { rows } = await (pool as PgPool).query(
    `INSERT INTO thread_user_state (thread_root_id, user_id, pod_id, ${column})
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (thread_root_id, user_id)
     DO UPDATE SET ${column} = EXCLUDED.${column},
                   updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [threadRootId, userId, podId, value],
  );
  return rows[0];
}

class ThreadUserState {
  /** Explicit follow. Idempotent — following twice is the state you asked for. */
  static async follow(threadRootId: number, userId: string, podId: string): Promise<ThreadUserStateRow> {
    return upsertOne('following', threadRootId, userId, podId, true);
  }

  /**
   * Explicit unfollow. Writes FALSE rather than deleting the row: for a thread
   * participant, "no row" means following-by-participation, so a delete would
   * re-subscribe them on the next reply. Deleting would also discard their
   * collapse state.
   */
  static async unfollow(threadRootId: number, userId: string, podId: string): Promise<ThreadUserStateRow> {
    return upsertOne('following', threadRootId, userId, podId, false);
  }

  /** Clear the explicit choice and fall back to the participation default. */
  static async clearFollowChoice(threadRootId: number, userId: string, podId: string): Promise<ThreadUserStateRow> {
    return upsertOne('following', threadRootId, userId, podId, null);
  }

  /**
   * Follow because you participated — posted in the thread, or were mentioned
   * in it (55854: "implicit by participation").
   *
   * Writes TRUE only where `following IS NULL`. An explicit FALSE is a MUTE and
   * outranks participation, so this must never flip it: otherwise a mute is one
   * @mention away from being silently revoked, and the user never asked for
   * that. Muting a thread and then being mentioned in it is the ordinary case,
   * not an edge one.
   *
   * The mention still WAKES the muted user — a mute scopes ambient activity,
   * never addressing. That is the wake path's job (3/4); this only decides
   * whether the subscription gets created.
   *
   * Returns the resulting state by re-reading, NOT by trusting rowCount: a
   * conditional DO UPDATE that matches nothing is not distinguishable from one
   * that wrote, across drivers.
   */
  static async followByParticipation(
    threadRootId: number, userId: string, podId: string,
  ): Promise<boolean | null> {
    await (pool as PgPool).query(
      `INSERT INTO thread_user_state (thread_root_id, user_id, pod_id, following)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (thread_root_id, user_id)
       DO UPDATE SET following = TRUE, updated_at = CURRENT_TIMESTAMP
       WHERE thread_user_state.following IS NULL`,
      [threadRootId, userId, podId],
    );
    const { rows } = await (pool as PgPool).query(
      'SELECT following FROM thread_user_state WHERE thread_root_id = $1 AND user_id = $2',
      [threadRootId, userId],
    );
    return rows[0]?.following ?? null;
  }

  /** The expand/collapse gesture. The ONLY writer of `collapsed`. */
  static async setCollapsed(
    threadRootId: number, userId: string, podId: string, collapsed: boolean,
  ): Promise<ThreadUserStateRow> {
    return upsertOne('collapsed', threadRootId, userId, podId, collapsed);
  }

  /**
   * Users who have EXPLICITLY followed. Deliberately does not include
   * participation-default followers — resolving that default needs the thread's
   * participant set, which lives in `messages`, and 3/4 owns that join. A
   * caller that treats this as "everyone who should wake" will under-notify;
   * the name says so, because `followerIds` would have made that read correct.
   */
  static async explicitFollowerIds(threadRootId: number): Promise<string[]> {
    const { rows } = await (pool as PgPool).query(
      'SELECT user_id FROM thread_user_state WHERE thread_root_id = $1 AND following IS TRUE',
      [threadRootId],
    );
    return rows.map((r) => String(r.user_id));
  }

  /** Users who have explicitly MUTED — these outrank the participation default. */
  static async mutedUserIds(threadRootId: number): Promise<string[]> {
    const { rows } = await (pool as PgPool).query(
      'SELECT user_id FROM thread_user_state WHERE thread_root_id = $1 AND following IS FALSE',
      [threadRootId],
    );
    return rows.map((r) => String(r.user_id));
  }

  /**
   * Everything the render path needs for one pod, with `collapsed` ALREADY
   * RESOLVED for every root in the pod — @ux-lead's ruling (56996).
   *
   * The sparse version below returns only rows that exist, which pushes two
   * jobs onto the client: notice absence, and know the threading cutoff to
   * interpret it (`collapsed = row?.collapsed ?? (root.createdAt >= cutoff)`).
   * That makes the cutoff part of every client's model of the system for the
   * sake of one boolean. The row is storage; the payload is meaning.
   *
   * So this enumerates the pod's roots and left-joins the caller's state. A
   * root is a message something else points at, which is exactly when a thread
   * starts existing. Written as an uncorrelated `IN (SELECT DISTINCT …)`
   * rather than a correlated `EXISTS`: pg-mem cannot resolve the outer alias
   * inside a correlated subquery here ("column root.id does not exist"), and
   * the uncorrelated form is equivalent, runs on both, and keeps this query
   * exercisable at the unit tier instead of only against a real server.
   *
   * The three-state cutoff is resolved here rather than at the wire, and the
   * ORDER of the CASE arms is the whole #1115 ruling:
   *   cutoffUnknown          -> false. Never collapse on an unknown.
   *   cutoff NULL, known     -> true. The backfill ran and rooted nothing, so
   *                             there is no pre-cutoff history to protect.
   *   otherwise              -> created_at >= cutoff.
   *
   * Cost, since a comment on the old shape argued against paying it: this is
   * one extra join bounded by the pod's THREAD count, not its message count,
   * and the caller is already rendering those messages. The argument that it
   * "duplicates data the client already has" was mine and it was the wrong
   * trade — it bought an O(1) payload by making every future client carry a
   * migration detail.
   */
  static async effectiveStateForPod(
    userId: string,
    podId: string,
    cutoff: Date | string | null,
    cutoffUnknown: boolean,
  ): Promise<Array<{ thread_root_id: number; following: boolean | null; collapsed: boolean }>> {
    const { rows } = await (pool as PgPool).query(
      `SELECT root.id AS thread_root_id,
              s.following AS following,
              COALESCE(
                s.collapsed,
                CASE WHEN $4::boolean THEN false
                     WHEN $3::timestamptz IS NULL THEN true
                     ELSE root.created_at >= $3::timestamptz
                END
              ) AS collapsed
         FROM messages root
         LEFT JOIN thread_user_state s
           ON s.thread_root_id = root.id AND s.user_id = $1
        WHERE root.pod_id = $2
          AND root.id IN (
                SELECT DISTINCT child.thread_root_id
                  FROM messages child
                 WHERE child.pod_id = $2 AND child.thread_root_id IS NOT NULL
              )
        ORDER BY root.id`,
      [userId, podId, cutoff, cutoffUnknown],
    );
    return rows.map((r: any) => ({
      thread_root_id: Number(r.thread_root_id),
      following: r.following === null || r.following === undefined ? null : Boolean(r.following),
      collapsed: Boolean(r.collapsed),
    }));
  }

  /**
   * The sparse read: only rows that exist. Retained because the wake path and
   * the state-setters reason about the ROW, where absence is meaningful —
   * `following IS NULL` is "defer to participation", which is not a value the
   * effective read can express. Do not use it for the render payload.
   */
  static async stateForPod(userId: string, podId: string): Promise<ThreadUserStateRow[]> {
    const { rows } = await (pool as PgPool).query(
      `SELECT thread_root_id, following, collapsed
         FROM thread_user_state WHERE user_id = $1 AND pod_id = $2`,
      [userId, podId],
    );
    return rows;
  }
}

export default ThreadUserState;
module.exports = exports["default"]; Object.assign(module.exports, exports);
