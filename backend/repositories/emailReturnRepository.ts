/**
 * F519 store: accepted email sends and their first signed-in return
 * (0013_email_sends.sql). Domain operations only, returning plain values.
 * Without PG_HOST there is no pool: nothing is recorded and counts are empty.
 */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */

interface PgPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

const loadPool = (): PgPool | null => (require('../config/db-pg') as { pool: PgPool | null }).pool;

export const isAvailable = (): boolean => Boolean(loadPool());

export const recordSend = async (send: {
  sendId: string; kind: string; recipientUserId: string; podId?: string | null; sentAt: Date;
}): Promise<void> => {
  const pool = loadPool();
  if (!pool) return;
  await pool.query(
    `INSERT INTO email_sends (send_id, kind, recipient_user_id, pod_id, sent_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (send_id) DO NOTHING`,
    [send.sendId, send.kind, send.recipientUserId, send.podId || null, send.sentAt],
  );
};

// The first return only, and only by the person the email went to. True when
// this call recorded it.
export const recordReturn = async (
  sendId: string, kind: string, userId: string, at: Date,
): Promise<boolean> => {
  const pool = loadPool();
  if (!pool) return false;
  const { rows } = await pool.query(
    `UPDATE email_sends SET returned_at = $4
     WHERE send_id = $1 AND kind = $2 AND recipient_user_id = $3 AND returned_at IS NULL
     RETURNING send_id`,
    [sendId, kind, userId, at],
  );
  return rows.length > 0;
};

export interface KindCounts { kind: string; sent: number; returned: number; posted24h: number }

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per kind, for sends since `since`: how many went out, how many brought the
 * person back signed in, and how many of those posted within 24h of coming
 * back, in the email's pod (any pod for the digest). A post is a message the
 * recipient wrote, whatever its type. Two plain reads and the join in code:
 * this runs for an operator now and then, not on a request path.
 */
export const countsSince = async (since: Date): Promise<KindCounts[]> => {
  const pool = loadPool();
  if (!pool) return [];
  const sends = (await pool.query(
    'SELECT kind, recipient_user_id, pod_id, returned_at FROM email_sends WHERE sent_at >= $1',
    [since],
  )).rows;
  const back = sends.filter((row) => row.returned_at);
  const recipients = [...new Set(back.map((row) => String(row.recipient_user_id)))];
  const posts = recipients.length ? (await pool.query(
    'SELECT user_id, pod_id, created_at FROM messages WHERE user_id = ANY($1) AND created_at >= $2',
    [recipients, since],
  )).rows : [];
  const byKind = new Map<string, KindCounts>();
  for (const row of sends) {
    const kind = String(row.kind);
    const counts = byKind.get(kind) || { kind, sent: 0, returned: 0, posted24h: 0 };
    counts.sent += 1;
    if (row.returned_at) {
      counts.returned += 1;
      const from = new Date(row.returned_at).getTime();
      const posted = posts.some((post) => String(post.user_id) === String(row.recipient_user_id)
        && (!row.pod_id || String(post.pod_id) === String(row.pod_id))
        && new Date(post.created_at).getTime() >= from
        && new Date(post.created_at).getTime() < from + DAY_MS);
      if (posted) counts.posted24h += 1;
    }
    byKind.set(kind, counts);
  }
  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
};

export default { isAvailable, recordSend, recordReturn, countsSince };
module.exports = { isAvailable, recordSend, recordReturn, countsSince };
