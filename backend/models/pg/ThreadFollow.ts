/**
 * ThreadFollow — who is following which thread (W-T, TASK-029).
 *
 * A SEPARATE record rather than a widened `User.followedThreads`. That field
 * is typed `postId: { type: ObjectId, ref: 'Post', required: true }`, so it
 * cannot hold a Postgres `messages.id`; widening it would silently drop chat
 * rows from every consumer that does `Post.find({ _id: { $in: postIds } })` —
 * `postController:457/:513/:548`, `activityService:614/:712`,
 * `ActivityFeedPage:584`. Two surfaces with one shape each beats one surface
 * with a polymorphic key.
 *
 * Follow is a SUBSCRIPTION, not a claim. Many users follow one thread; the
 * unique is (thread_root_id, user_id) so a double-follow is idempotent rather
 * than an error — a UI that fires twice must not surface a failure.
 */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const { pool } = require('../../config/db-pg');

interface PgPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

export interface ThreadFollowRow {
  id: number;
  thread_root_id: number;
  user_id: string;
  pod_id: string;
  followed_at: string;
}

class ThreadFollow {
  /**
   * Idempotent. Returns the row whether it was created now or already existed,
   * so a caller never has to distinguish "followed" from "already following" —
   * both mean the same thing to the user and to the wake path.
   */
  static async follow(threadRootId: number, userId: string, podId: string): Promise<ThreadFollowRow> {
    const { rows } = await (pool as PgPool).query(
      `INSERT INTO thread_follows (thread_root_id, user_id, pod_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (thread_root_id, user_id) DO UPDATE SET pod_id = EXCLUDED.pod_id
       RETURNING *`,
      [threadRootId, userId, podId],
    );
    return rows[0];
  }

  /** Idempotent in the same way: unfollowing what you do not follow is fine. */
  static async unfollow(threadRootId: number, userId: string): Promise<boolean> {
    const { rowCount } = await (pool as PgPool).query(
      'DELETE FROM thread_follows WHERE thread_root_id = $1 AND user_id = $2',
      [threadRootId, userId],
    );
    return rowCount > 0;
  }

  /**
   * The wake path's question, asked on every threaded reply. Returns user ids
   * only — resolving them to identities is the caller's job, because the wake
   * path and the UI want different shapes and neither should pay for the other.
   */
  static async followerIds(threadRootId: number): Promise<string[]> {
    const { rows } = await (pool as PgPool).query(
      'SELECT user_id FROM thread_follows WHERE thread_root_id = $1',
      [threadRootId],
    );
    return rows.map((r) => String(r.user_id));
  }

  /** The UI's question: what am I following in this room. */
  static async followedRootsForUser(userId: string, podId: string): Promise<number[]> {
    const { rows } = await (pool as PgPool).query(
      'SELECT thread_root_id FROM thread_follows WHERE user_id = $1 AND pod_id = $2',
      [userId, podId],
    );
    return rows.map((r) => Number(r.thread_root_id));
  }

  static async isFollowing(threadRootId: number, userId: string): Promise<boolean> {
    const { rowCount } = await (pool as PgPool).query(
      'SELECT 1 FROM thread_follows WHERE thread_root_id = $1 AND user_id = $2 LIMIT 1',
      [threadRootId, userId],
    );
    return rowCount > 0;
  }
}

export default ThreadFollow;
// CJS compat: let require() return the class directly
module.exports = exports["default"]; Object.assign(module.exports, exports);
