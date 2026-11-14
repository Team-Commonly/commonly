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

export interface PodVisit { openedAt: Date | null; closedAt: Date | null }

const toDate = (value: unknown): Date | null => (value ? new Date(value as string) : null);

export const isAvailable = (): boolean => Boolean(loadPool());

// Both stamps only move forward, so a late write never rewinds a newer one.
export const stampOpened = async (userId: string, podId: string, at: Date): Promise<void> => {
  const pool = loadPool();
  if (!pool) return;
  await pool.query(
    `INSERT INTO pod_visits (user_id, pod_id, opened_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, pod_id) DO UPDATE SET opened_at = CASE
       WHEN pod_visits.opened_at IS NULL OR pod_visits.opened_at < EXCLUDED.opened_at THEN EXCLUDED.opened_at
       ELSE pod_visits.opened_at END`,
    [userId, podId, at],
  );
};

export const stampClosed = async (userId: string, podId: string, at: Date): Promise<void> => {
  const pool = loadPool();
  if (!pool) return;
  await pool.query(
    `INSERT INTO pod_visits (user_id, pod_id, closed_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, pod_id) DO UPDATE SET closed_at = CASE
       WHEN pod_visits.closed_at IS NULL OR pod_visits.closed_at < EXCLUDED.closed_at THEN EXCLUDED.closed_at
       ELSE pod_visits.closed_at END`,
    [userId, podId, at],
  );
};

export const getVisit = async (userId: string, podId: string): Promise<PodVisit | null> => {
  const pool = loadPool();
  if (!pool) return null;
  const { rows } = await pool.query(
    'SELECT opened_at, closed_at FROM pod_visits WHERE user_id = $1 AND pod_id = $2',
    [userId, podId],
  );
  return rows[0] ? { openedAt: toDate(rows[0].opened_at), closedAt: toDate(rows[0].closed_at) } : null;
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

export default { isAvailable, stampOpened, stampClosed, getVisit, firstVisitAt, claimWindow, releaseWindow };
module.exports = { isAvailable, stampOpened, stampClosed, getVisit, firstVisitAt, claimWindow, releaseWindow };
