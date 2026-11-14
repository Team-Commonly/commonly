/**
 * F512 stores: pod visits and the mention-email window (0012_mention_email.sql).
 * Domain operations only, returning plain values; callers never see SQL.
 * Without PG_HOST there is no pool: stamps are no-ops and the window reads as
 * unavailable, so the mention email simply does not run.
 */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */

interface PgPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

const loadPool = (): PgPool | null => (require('../config/db-pg') as { pool: PgPool | null }).pool;

export interface PodVisit { readAt: Date | null; openedAt: Date | null; closedAt: Date | null }

const toDate = (value: unknown): Date | null => (value ? new Date(value as string) : null);

export const isAvailable = (): boolean => Boolean(loadPool());

// Each stamp only moves forward, so a late write never rewinds a newer one.
// `column` is one of three literals chosen below, never caller input.
const stamp = async (column: 'read_at' | 'opened_at' | 'closed_at', userId: string, podId: string, at: Date) => {
  const pool = loadPool();
  if (!pool) return;
  await pool.query(
    `INSERT INTO pod_visits (user_id, pod_id, ${column}) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, pod_id) DO UPDATE SET ${column} = CASE
       WHEN pod_visits.${column} IS NULL OR pod_visits.${column} < EXCLUDED.${column} THEN EXCLUDED.${column}
       ELSE pod_visits.${column} END`,
    [userId, podId, at],
  );
};

// A message read over HTTP: a one-time visit, never an open session.
export const stampRead = (userId: string, podId: string, at: Date) => stamp('read_at', userId, podId, at);
// A live socket session's start and end.
export const stampOpened = (userId: string, podId: string, at: Date) => stamp('opened_at', userId, podId, at);
export const stampClosed = (userId: string, podId: string, at: Date) => stamp('closed_at', userId, podId, at);

export const getVisit = async (userId: string, podId: string): Promise<PodVisit | null> => {
  const pool = loadPool();
  if (!pool) return null;
  const { rows } = await pool.query(
    'SELECT read_at, opened_at, closed_at FROM pod_visits WHERE user_id = $1 AND pod_id = $2',
    [userId, podId],
  );
  if (!rows[0]) return null;
  return { readAt: toDate(rows[0].read_at), openedAt: toDate(rows[0].opened_at), closedAt: toDate(rows[0].closed_at) };
};

// When stamping began: the oldest visit row. Null before any visit.
export const firstVisitAt = async (): Promise<Date | null> => {
  const pool = loadPool();
  if (!pool) return null;
  const { rows } = await pool.query('SELECT MIN(created_at) AS first FROM pod_visits');
  return toDate(rows[0]?.first);
};

/**
 * Claim the recipient's 6h window for this pod. Returns null when the window
 * is already used, else what it was before (null on a first email), which a
 * refused send hands back to releaseWindow. The guarded UPDATE is the claim:
 * Postgres re-checks its WHERE on the locked row, so two passes cannot both
 * win. (Not ON CONFLICT DO UPDATE ... WHERE, which pg-mem ignores, so its
 * tests would prove nothing.)
 */
export const claimWindow = async (
  recipientUserId: string, podId: string, attentionItemId: string, now: Date, windowStart: Date,
): Promise<{ previous: Date | null } | null> => {
  const pool = loadPool();
  if (!pool) return null;
  await pool.query(
    `INSERT INTO mention_email_state (recipient_user_id, pod_id) VALUES ($1, $2)
     ON CONFLICT (recipient_user_id, pod_id) DO NOTHING`,
    [recipientUserId, podId],
  );
  const { rows } = await pool.query(
    `UPDATE mention_email_state
     SET prev_email_at = last_email_at, last_email_at = $3, attention_item_id = $4
     WHERE recipient_user_id = $1 AND pod_id = $2 AND (last_email_at IS NULL OR last_email_at <= $5)
     RETURNING prev_email_at`,
    [recipientUserId, podId, now, attentionItemId, windowStart],
  );
  if (!rows[0]) return null;
  return { previous: toDate(rows[0].prev_email_at) };
};

// Give a claimed window back, only if it is still the one this pass claimed.
export const releaseWindow = async (
  recipientUserId: string, podId: string, claimedAt: Date, previous: Date | null,
): Promise<void> => {
  const pool = loadPool();
  if (!pool) return;
  await pool.query(
    `UPDATE mention_email_state SET last_email_at = $4, prev_email_at = NULL
     WHERE recipient_user_id = $1 AND pod_id = $2 AND last_email_at = $3`,
    [recipientUserId, podId, claimedAt, previous],
  );
};

export default { isAvailable, stampRead, stampOpened, stampClosed, getVisit, firstVisitAt, claimWindow, releaseWindow };
module.exports = { isAvailable, stampRead, stampOpened, stampClosed, getVisit, firstVisitAt, claimWindow, releaseWindow };
