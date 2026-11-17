/* eslint-disable @typescript-eslint/no-require-imports */
// A person's read point in a pod's main channel (first minute back). The
// table comes from migration 0014. It only moves forward, and it is clamped
// to now, so a stale tab or a bad clock can't move it back or into the future.
const { pool } = require('../../config/db-pg');

interface PgPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

class PodReadPoint {
  static async get(podId: string, userId: string): Promise<string | null> {
    const { rows } = await (pool as PgPool).query(
      'SELECT last_read_at FROM pod_read_points WHERE pod_id = $1 AND user_id = $2',
      [podId, userId],
    );
    return toIso(rows[0]?.last_read_at);
  }

  static async markRead(podId: string, userId: string, at: Date): Promise<string | null> {
    const clamped = new Date(Math.min(at.getTime(), Date.now()));
    await (pool as PgPool).query(
      `INSERT INTO pod_read_points (pod_id, user_id, last_read_at)
       VALUES ($1, $2, $3::timestamptz)
       ON CONFLICT (pod_id, user_id)
       DO UPDATE SET last_read_at = $3::timestamptz, updated_at = CURRENT_TIMESTAMP
       WHERE pod_read_points.last_read_at < $3::timestamptz`,
      [podId, userId, clamped.toISOString()],
    );
    return PodReadPoint.get(podId, userId);
  }

  /**
   * Write a first read point only where none exists. Unlike markRead it never
   * touches an existing row, earlier or later, so a seed can't move a real
   * point. Clamped to now like markRead.
   */
  static async seedIfAbsent(podId: string, userId: string, at: Date): Promise<string | null> {
    const clamped = new Date(Math.min(at.getTime(), Date.now()));
    await (pool as PgPool).query(
      `INSERT INTO pod_read_points (pod_id, user_id, last_read_at)
       VALUES ($1, $2, $3::timestamptz)
       ON CONFLICT (pod_id, user_id) DO NOTHING`,
      [podId, userId, clamped.toISOString()],
    );
    return PodReadPoint.get(podId, userId);
  }

  /**
   * What this member last did in this pod: their latest thread read point and
   * their latest message. System lines are left out: a decline or a task claim
   * is filed under the person's id from outside the pod, so it doesn't show
   * they read the channel.
   */
  static async activityIn(podId: string, userId: string): Promise<{ threadReadAt: unknown; lastMessageAt: unknown }> {
    const [threads, messages] = await Promise.all([
      (pool as PgPool).query(
        'SELECT MAX(last_read_at) AS at FROM thread_user_state WHERE pod_id = $1 AND user_id = $2',
        [podId, userId],
      ),
      (pool as PgPool).query(
        `SELECT MAX(created_at) AS at FROM messages
         WHERE pod_id = $1 AND user_id = $2 AND COALESCE(message_type, '') <> 'system'`,
        [podId, userId],
      ),
    ]);
    return { threadReadAt: threads.rows[0]?.at ?? null, lastMessageAt: messages.rows[0]?.at ?? null };
  }
}

module.exports = PodReadPoint;
export default PodReadPoint;
