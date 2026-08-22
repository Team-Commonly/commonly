/**
 * ThreadUserState — per-user, per-thread state (W-T, TASK-029).
 *
 * ONE record carrying both `following` and `collapsed`, per ux-lead's ruling
 * in docs/design/threading-surface-ruling.md ("One state record, two
 * booleans"): they share the key (user, pod, thread root), so two tables would
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
  // ux-lead's ruling (41707609 on #1107). It previously also wrote
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
   * Everything the render path needs for one pod in one query. Returns only
   * rows that exist — a thread the user has never touched is absent, and the
   * caller applies the defaults (collapsed true, following from participation).
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
