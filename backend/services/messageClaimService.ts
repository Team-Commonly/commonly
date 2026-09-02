/**
 * messageClaimService — ADR-018 D1–D5: the kernel half of attention claims.
 *
 * One table, one CAS statement. A claim is a LEASE (D4): it expires on its
 * own, because the fleet is laptop-hosted wrappers and dying mid-turn is what
 * happens when a lid closes. A claim with no expiry is the bug task claims
 * have today (claimedBy with no deadline — dead claimant holds forever).
 *
 * Deviation from ADR-018's sketch, recorded: the ADR says "claim state lives
 * with the message row". It lives in a dedicated table KEYED by message id
 * instead — the messages table is hot, has no in-repo DDL to migrate, and
 * vectorSearchService already sets the self-bootstrapping-table precedent.
 * Same ownership semantics, no ALTER on the busiest table in the system.
 *
 * The CAS is the whole design: INSERT … ON CONFLICT DO UPDATE … WHERE the
 * existing lease is expired, RETURNING. Exactly one caller gets a row back;
 * everyone else gets nothing. No read-then-write window, no advisory locks,
 * no second round trip.
 *
 * The kernel NEVER refuses an unclaimed post (D3). This service only answers
 * "who holds the lease?" — enforcement is the driver's job, and only for
 * drivers we ship. "Forgot to claim" must not become "agent is silent".
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pool } = require('../config/db-pg');

const DEFAULT_LEASE_SECONDS = 90; // D4's number — a rationale, not a measurement; reviewers asked to attack it.
const MAX_LEASE_SECONDS = 600; // Nobody gets to park a claim for an hour by passing a big number.
// A re-offered event can requeue three times at ten-minute intervals. Keep
// handoff history for double that window: a delayed child still needs its
// prior declines and completion tombstone, but an exhausted or abandoned
// chain must not become permanent claim-table storage. Ordinary successful
// claims still DELETE immediately.
const HANDOFF_HISTORY_RETENTION_SECONDS = 60 * 60;

interface ClaimResult {
  claimed: boolean;
  claimedBy?: string;
  instanceId?: string;
  expiresAt?: Date;
  state?: 'claimed' | 'declined' | 'completed';
  declinedBy?: string[];
}

let bootstrapped = false;

async function ensureTable(): Promise<void> {
  if (bootstrapped) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_claims (
      message_id TEXT PRIMARY KEY,
      pod_id TEXT NOT NULL,
      claimed_by TEXT NOT NULL,
      instance_id TEXT NOT NULL DEFAULT 'default',
      expires_at TIMESTAMPTZ NOT NULL,
      state TEXT NOT NULL DEFAULT 'claimed',
      declined_by TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The table self-bootstraps rather than being part of schema.sql, so this
  // retrofit is required for instances that created it before decline
  // handoff existed. CREATE TABLE IF NOT EXISTS alone never adds columns.
  await pool.query(
    "ALTER TABLE message_claims ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'claimed'",
  );
  await pool.query(
    'ALTER TABLE message_claims ADD COLUMN IF NOT EXISTS declined_by TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]',
  );
  // Expired rows are dead weight; the CAS treats them as absent. A small
  // index makes the pod-scoped sweep cheap if one is ever added.
  await pool.query('CREATE INDEX IF NOT EXISTS idx_message_claims_pod ON message_claims (pod_id)');
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_message_claims_terminal_expiry ON message_claims (state, expires_at)',
  );
  bootstrapped = true;
}

function clampLease(seconds: unknown): number {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LEASE_SECONDS;
  return Math.min(Math.trunc(n), MAX_LEASE_SECONDS);
}

class MessageClaimService {
  /**
   * Atomically claim a message, or renew a claim you already hold (the same
   * statement serves both — a holder "wins against itself", which IS renewal,
   * so drivers need one call, not two).
   *
   * Returns { claimed: true, expiresAt } to exactly one concurrent caller.
   * Losers get { claimed: false } plus who holds it and until when, so a
   * driver can decide to stand down informed rather than blind.
   */
  static async claim(options: {
    messageId: string; podId: string; agentName: string;
    instanceId?: string; leaseSeconds?: number;
  }): Promise<ClaimResult> {
    const {
      messageId, podId, agentName, instanceId = 'default',
    } = options;
    if (!messageId || !podId || !agentName) {
      throw new Error('messageId, podId, and agentName are required');
    }
    await ensureTable();
    // Handoff rows are short-lived history, not an ever-growing ledger.
    // Pruning happens on the same claim traffic that creates them; the
    // retention window outlives the requeue cap so attempted-seat history
    // survives every legitimate delayed delivery.
    await pool.query(
      "DELETE FROM message_claims WHERE state IN ('completed', 'declined') AND expires_at < NOW()",
    );
    const lease = clampLease(options.leaseSeconds);

    const win = await pool.query(
      `INSERT INTO message_claims (message_id, pod_id, claimed_by, instance_id, expires_at, state)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5), 'claimed')
       ON CONFLICT (message_id) DO UPDATE
         SET claimed_by = EXCLUDED.claimed_by,
             instance_id = EXCLUDED.instance_id,
             expires_at = EXCLUDED.expires_at,
             state = 'claimed',
             created_at = NOW()
         WHERE message_claims.state = 'declined'
            OR (message_claims.state = 'claimed' AND message_claims.expires_at < NOW())
            OR (message_claims.state = 'claimed'
                AND message_claims.claimed_by = EXCLUDED.claimed_by
                AND message_claims.instance_id = EXCLUDED.instance_id)
       RETURNING claimed_by, instance_id, expires_at, state, declined_by`,
      [String(messageId), String(podId), agentName.toLowerCase(), instanceId, lease],
    );
    if (win.rows.length > 0) {
      const r = win.rows[0];
      return {
        claimed: true,
        claimedBy: r.claimed_by,
        instanceId: r.instance_id,
        expiresAt: r.expires_at,
        state: r.state,
        declinedBy: r.declined_by || [],
      };
    }

    // Lost: report the live holder. (A race where the holder expires between
    // the CAS and this read just looks like a nearly-expired claim — harmless,
    // the caller's next attempt will win.)
    const holder = await pool.query(
      'SELECT claimed_by, instance_id, expires_at, state, declined_by FROM message_claims WHERE message_id = $1',
      [String(messageId)],
    );
    const h = holder.rows[0];
    return h
      ? {
        claimed: false,
        claimedBy: h.claimed_by,
        instanceId: h.instance_id,
        expiresAt: h.expires_at,
        state: h.state,
        declinedBy: h.declined_by || [],
      }
      : { claimed: false };
  }

  /**
   * Release a claim you hold. Only the holder can release (D6 makes
   * claim-then-decline a normal path, so this gets called a lot). Releasing
   * a claim you do not hold is a no-op, not an error — the lease may simply
   * have expired and been re-won while you were deciding.
   */
  static async release(options: {
    messageId: string;
    agentName: string;
    instanceId?: string;
    outcome?: 'declined' | 'completed';
  }): Promise<{
    released: boolean;
    podId?: string;
    state?: 'declined' | 'completed';
    declinedBy?: string[];
  }> {
    const { messageId, agentName, instanceId = 'default' } = options;
    if (!messageId || !agentName) throw new Error('messageId and agentName are required');
    await ensureTable();
    const canonicalAgentName = agentName.toLowerCase();
    const outcome = options.outcome;
    if (outcome === 'declined') {
      // A decline is immediately claimable by the one re-offered seat.
      // Keeping its history on the message, rather than in a driver-local
      // retry loop, bounds a chain to the original wake cohort even across
      // CLI and native runtimes. Its expiry is retention, not availability:
      // the CAS accepts `state = 'declined'` immediately, while an abandoned
      // or exhausted chain reaps after every legitimate requeue has elapsed.
      const res = await pool.query(
        `UPDATE message_claims
         SET state = 'declined',
             expires_at = NOW() + make_interval(secs => $5),
             declined_by = CASE
               WHEN NOT ($4 = ANY(declined_by))
                 THEN array_append(declined_by, $4)
               ELSE declined_by
             END
         WHERE message_id = $1 AND claimed_by = $2 AND instance_id = $3
         RETURNING message_id, pod_id, state, declined_by`,
        [
          String(messageId), canonicalAgentName, instanceId,
          `${canonicalAgentName}:${instanceId}`,
          HANDOFF_HISTORY_RETENTION_SECONDS,
        ],
      );
      return res.rows.length > 0
        ? {
          released: true,
          podId: res.rows[0].pod_id,
          state: res.rows[0].state,
          declinedBy: res.rows[0].declined_by || [],
        }
        : { released: false };
    }
    if (outcome === 'completed') {
      // Only a message that already handed off needs a completion tombstone.
      // Normal claims retain the old DELETE path, otherwise every answered
      // message would become permanent claim-table storage.
      const terminal = await pool.query(
        `UPDATE message_claims
         SET state = 'completed',
             expires_at = NOW() + make_interval(secs => $4)
         WHERE message_id = $1
           AND claimed_by = $2
           AND instance_id = $3
           AND cardinality(declined_by) > 0
         RETURNING message_id, pod_id, state, declined_by`,
        [String(messageId), canonicalAgentName, instanceId, HANDOFF_HISTORY_RETENTION_SECONDS],
      );
      if (terminal.rows.length > 0) {
        return {
          released: true,
          podId: terminal.rows[0].pod_id,
          state: terminal.rows[0].state,
          declinedBy: terminal.rows[0].declined_by || [],
        };
      }
    }
    // pod_id rides back so the route can clear the D7 typing indicator —
    // the DELETE takes no podId (holder-only delete is the guard), and the
    // claim row is the only place the pod is recorded.
    const res = await pool.query(
      `DELETE FROM message_claims
       WHERE message_id = $1 AND claimed_by = $2 AND instance_id = $3
       RETURNING message_id, pod_id`,
      [String(messageId), canonicalAgentName, instanceId],
    );
    return res.rows.length > 0
      ? { released: true, podId: res.rows[0].pod_id }
      : { released: false };
  }

  /** Who holds a message right now? Expired leases read as unheld. */
  static async holder(messageId: string): Promise<ClaimResult> {
    await ensureTable();
    const res = await pool.query(
      `SELECT claimed_by, instance_id, expires_at, state, declined_by FROM message_claims
       WHERE message_id = $1 AND state = 'claimed' AND expires_at >= NOW()`,
      [String(messageId)],
    );
    const h = res.rows[0];
    return h
      ? {
        claimed: true,
        claimedBy: h.claimed_by,
        instanceId: h.instance_id,
        expiresAt: h.expires_at,
        state: h.state,
        declinedBy: h.declined_by || [],
      }
      : { claimed: false };
  }
}

module.exports = MessageClaimService;
export {};
