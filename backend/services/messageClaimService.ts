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

interface ClaimResult {
  claimed: boolean;
  claimedBy?: string;
  instanceId?: string;
  expiresAt?: Date;
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Expired rows are dead weight; the CAS treats them as absent. A small
  // index makes the pod-scoped sweep cheap if one is ever added.
  await pool.query('CREATE INDEX IF NOT EXISTS idx_message_claims_pod ON message_claims (pod_id)');
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
    const lease = clampLease(options.leaseSeconds);

    const win = await pool.query(
      `INSERT INTO message_claims (message_id, pod_id, claimed_by, instance_id, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))
       ON CONFLICT (message_id) DO UPDATE
         SET claimed_by = EXCLUDED.claimed_by,
             instance_id = EXCLUDED.instance_id,
             expires_at = EXCLUDED.expires_at,
             created_at = NOW()
         WHERE message_claims.expires_at < NOW()
            OR (message_claims.claimed_by = EXCLUDED.claimed_by
                AND message_claims.instance_id = EXCLUDED.instance_id)
       RETURNING claimed_by, instance_id, expires_at`,
      [String(messageId), String(podId), agentName.toLowerCase(), instanceId, lease],
    );
    if (win.rows.length > 0) {
      const r = win.rows[0];
      return {
        claimed: true, claimedBy: r.claimed_by, instanceId: r.instance_id, expiresAt: r.expires_at,
      };
    }

    // Lost: report the live holder. (A race where the holder expires between
    // the CAS and this read just looks like a nearly-expired claim — harmless,
    // the caller's next attempt will win.)
    const holder = await pool.query(
      'SELECT claimed_by, instance_id, expires_at FROM message_claims WHERE message_id = $1',
      [String(messageId)],
    );
    const h = holder.rows[0];
    return h
      ? {
        claimed: false, claimedBy: h.claimed_by, instanceId: h.instance_id, expiresAt: h.expires_at,
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
    messageId: string; agentName: string; instanceId?: string;
  }): Promise<{ released: boolean; podId?: string }> {
    const { messageId, agentName, instanceId = 'default' } = options;
    if (!messageId || !agentName) throw new Error('messageId and agentName are required');
    await ensureTable();
    // pod_id rides back so the route can clear the D7 typing indicator —
    // the DELETE takes no podId (holder-only delete is the guard), and the
    // claim row is the only place the pod is recorded.
    const res = await pool.query(
      `DELETE FROM message_claims
       WHERE message_id = $1 AND claimed_by = $2 AND instance_id = $3
       RETURNING message_id, pod_id`,
      [String(messageId), agentName.toLowerCase(), instanceId],
    );
    return res.rows.length > 0
      ? { released: true, podId: res.rows[0].pod_id }
      : { released: false };
  }

  /** Who holds a message right now? Expired leases read as unheld. */
  static async holder(messageId: string): Promise<ClaimResult> {
    await ensureTable();
    const res = await pool.query(
      `SELECT claimed_by, instance_id, expires_at FROM message_claims
       WHERE message_id = $1 AND expires_at >= NOW()`,
      [String(messageId)],
    );
    const h = res.rows[0];
    return h
      ? {
        claimed: true, claimedBy: h.claimed_by, instanceId: h.instance_id, expiresAt: h.expires_at,
      }
      : { claimed: false };
  }
}

module.exports = MessageClaimService;
export {};
