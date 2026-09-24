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
// A refusal reason is a label, not a transcript. The ROUTE validates it against
// the driver enum (upstream-refused / cascade-cap / delivery-refused) and 400s
// anything else; the bound here is the second layer, for a caller that reaches
// the service directly. Truncated rather than rejected — a reason that is too
// long must never turn a release into a 500.
const MAX_REFUSAL_REASON = 256;
// The upstream HTTP status, for `upstream-refused` only: the enum names the
// class, this names the instance, and "how many 429s" is the question the
// record exists to answer. Same range the adapters classify by.
const MIN_UPSTREAM_STATUS = 400;
const MAX_UPSTREAM_STATUS = 599;

interface ClaimResult {
  claimed: boolean;
  claimedBy?: string;
  instanceId?: string;
  expiresAt?: Date;
  state?: 'claimed' | 'declined' | 'completed' | 'refused';
  declinedBy?: string[];
  reason?: string;
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
  // TASK-099: the named half of a released refusal. Nullable by design —
  // every pre-existing row, and every non-refused outcome, has no reason.
  await pool.query(
    'ALTER TABLE message_claims ADD COLUMN IF NOT EXISTS refusal_reason TEXT',
  );
  await pool.query(
    'ALTER TABLE message_claims ADD COLUMN IF NOT EXISTS refusal_status INTEGER',
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

/**
 * `messages.id` is SERIAL, i.e. int4: 2147483647 is the largest value that can
 * name a row, and one past it is an out-of-range ERROR rather than an absent
 * row (see messageExists). Named rather than inlined so the bound is one
 * reviewable fact and the tests that pin it cite the same number.
 */
const MESSAGE_ID_MAX = 2147483647;

/**
 * Ids reaching this predicate do NOT all come from one namespace, and the
 * predicate is a total split over them rather than a filter that happens to
 * accept digits:
 *
 *   chat id     digits, 1..2147483647   verified against Postgres below
 *   comment id  24 hex, canonical case  verified against Mongo (existence only)
 *   anything else                       refused, no query
 *
 * A post-thread comment enters the mention and wake path as a Mongo ObjectId:
 * `postController.ts:295` enqueues with `_id: comment._id`, and every payload
 * builder stringifies that into `messageId` (`message?._id || message?.id`,
 * agentMentionService.ts:1417/1481/1674/1722/1793/1861/2145). The wake race
 * dedupes BY that id — several seats are woken for one comment, the first
 * lease wins, the rest stand down — so refusing the shape does not fail closed,
 * it fails open: `enforcement.js:414` catches the throw and returns
 * `{failOpen: true}`, and every woken seat proceeds unguarded. That is the
 * regression this arm exists to prevent (connector-ops 71952, vera 71956,
 * wren's ruling 71961).
 *
 * THE POD CANNOT BE CHECKED HERE; THE ID NOW CAN (TASK-122). Until TASK-122
 * this arm passed the id through unverified, so a fabricated 24-hex id minted a
 * permanent, un-renewable, un-completable phantom lease — permanent because the
 * prune collects terminal states only. It is now checked against the comment's
 * own store, which is `Post.comments[]`, not `messages`.
 *
 * What the check is NOT is pod-scoped, and that is a property of the wake path
 * rather than a shortcut: the pod for a comment wake cannot be verified here by
 * construction, because the enqueue resolves it through `resolveMentionPod`,
 * which may return the request's pod or a fallback — so refusing on a pod
 * mismatch could refuse a wake that is real. Existence is what this arm can
 * buy; the pod half stays the route's installation check.
 *
 * A STORE FAILURE PASSES THE ID THROUGH rather than refusing it, and the
 * direction carries the arm's own reasoning: a refusal for a 24-hex id does not
 * fail closed — the CLI's claim path (`cli/src/lib/enforcement.js:414`) turns
 * the route's non-2xx into `{failOpen: true}` — so an outage that refused would
 * unguard every woken seat and stop the race deduping. An unconfirmed id
 * therefore degrades to the
 * pre-TASK-122 behaviour (dedupe holds, a phantom is possible) and says so on
 * one line, rather than reverting the hardening in silence.
 *
 * The lookup is a collection scan: no index covers `comments._id` (models/Post
 * declares none), so a MISS — the fabricated-id case this arm exists to refuse —
 * examines every document. Measured on the live instance 2026-09-24 rather than
 * estimated: 715 posts, 5,455 comments, 2.4 MB; a miss examines 715 and costs
 * ~50 ms including the round trip. The cost thus falls on the fabricated-id
 * request rather than the real one, and it is spent only behind a valid runtime
 * token plus `phase4RateLimit`: if the route ever loses either, this index stops
 * being a follow-on that day. Revisit when posts pass ~10k or when a miss
 * doubles, whichever comes first — the latency trigger catches growing comment
 * density, which a document count would not.
 *
 * Canonical case only. `String(objectId)` is lowercase in every driver we
 * send, so an uppercase spelling is refused with the digits arm's 404 — which
 * fails open for that spelling rather than minting a second claim key for one
 * comment. No producer emits one; if one ever does, this is the line to revisit.
 *
 * The arms are tested IN THIS ORDER, and the order is load-bearing for one
 * input: '123456789012345678901234' is 24 hex digits, hence a legal ObjectId,
 * and far outside int4. Checked digits-first it fails the range test and — in
 * the natural rewrite, where the digits arm returns false — is 404'd, costing
 * a real wake its dedupe. The all-digit test below is the witness that kills
 * that shape.
 */
const MONGO_OBJECT_ID = /^[0-9a-f]{24}$/;

function isChatMessageId(id: string): boolean {
  if (!/^\d+$/.test(id)) return false;
  const n = Number(id);
  // Number.isInteger alone is not a bound: 100-digit inputs are integers too,
  // and `n <= MESSAGE_ID_MAX` is what rejects them.
  return Number.isInteger(n) && n >= 1 && n <= MESSAGE_ID_MAX;
}

/**
 * The comment namespace's store, loaded lazily.
 *
 * `Post.comments[]` is a subdocument array (models/Post.ts), so a comment's
 * `_id` cannot be answered by the Postgres query below.
 *
 * Resolved on first use rather than at module scope, and the honest reason is
 * the test seam rather than process hygiene: model registration is idempotent
 * and `postController.ts` already loads Post in every backend process, so a
 * module-level require would cost nothing. Keeping it in this one function makes
 * it the service's only dependency on the Post model — which is exactly the
 * thing a unit suite has to replace.
 */
let commentsStore: { exists: (filter: Record<string, unknown>) => Promise<unknown> } | null = null;

function commentStore() {
  if (!commentsStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    commentsStore = require('../models/Post');
  }
  return commentsStore as { exists: (filter: Record<string, unknown>) => Promise<unknown> };
}

/**
 * Does this comment exist? (TASK-122)
 *
 * The id goes to mongoose as a STRING and is cast to ObjectId by the path, so
 * nothing here needs to construct one; the caller has already proven the 24-hex
 * canonical shape, so the cast cannot fail on any input this predicate admits.
 *
 * The catch returns TRUE, not false, and that is the whole design: see
 * MONGO_OBJECT_ID. A store that cannot answer must not unguard the fleet, and
 * refusing an unconfirmed comment id is exactly what would do that.
 */
async function commentExists(objectId: string): Promise<boolean> {
  try {
    const found = await commentStore().exists({ 'comments._id': objectId });
    return Boolean(found);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[claims] comment existence check failed (${message}) — passing ${objectId} through, `
      + 'so the wake race keeps deduping',
    );
    return true;
  }
}

class MessageClaimService {
  /**
   * Does this message exist, in this pod?
   *
   * The claim table carries no foreign key to `messages` — deliberately: the
   * ADR-018 sketch said "claim state lives with the message row", and this
   * service keys a dedicated table instead precisely so the busiest table in
   * the system takes no retrofit DDL (see the header note). The cost of that
   * choice is that the CAS will mint a lease for an id that names nothing.
   * Measured 2026-09-23 against the live instance: POST
   * /api/agents/runtime/messages/999999999999/claim → 200 `claimed: true` for
   * an id that has no row anywhere. Such a lease is un-renewable, can never be
   * completed, and — because the prune collects terminal states only — is
   * permanent storage. Hence this predicate, before the CAS:
   *
   * `messages.id` is SERIAL (config/schema.sql:43), so a non-numeric id cannot
   * name a row, and answering it WITHOUT a query is the point rather than an
   * optimisation: handing 'TASK-110' to Postgres raises `invalid input syntax
   * for type integer`, which the route's catch turns into a 500 — the same
   * wrong answer in new clothes (vera's gate, 71873).
 *
 * DIGITS ALONE ARE NOT THE SHAPE — SERIAL is int4. '999999999999' passes a
 * `/^\d+$/` test and is not a syntax error either: Postgres raises `22003
 * value "999999999999" is out of range for type integer`, the catch turns that
 * into a 500, and that id is this predicate's own headline reproduction
 * (vera's gate, 71928, measured read-only against the live DB: '999999999999'
 * and '2147483648' throw, '5' and '00000000005' are simply absent). The bound
 * is therefore part of the shape test, not decoration — hence MESSAGE_ID_MAX
 * and the two tests pinning the first out-of-range value and this one to
 * no-query-false.
 *
 * The LOWER bound is a different kind of clause and is not asserted as if it
 * were the same thing: '0' is merely absent, so `n >= 1` saves one pointless
 * query and changes no answer (vera 71951). It stays because it is free, and it
 * is deliberately NOT given a no-query test — a test named after safety that
 * actually pins an optimisation teaches the next reader the wrong reason for
 * the bound's existence. What the upper bound buys is a 500 averted; what the
 * lower bound buys is a query not sent.
 *
 * Pod-scoped on purpose. Existence alone would let a seat installed in pod A
 * lease a message in pod B; the route checks installation separately, and
 * this is the message half. Both are required, so both are read here — and
 * each namespace is read from its OWN store: chat ids from Postgres, comment
 * ids from Mongo. One place answers "does this message exist", which is the
 * property worth keeping; a second copy of the split in the route is how two
 * answers drift apart.
 */
  static async messageExists(messageId: unknown, podId: unknown): Promise<boolean> {
    const id = String(messageId ?? '');
    const pod = String(podId ?? '');
    if (!pod) return false;
    // Comment namespace: it exists in Mongo, not in Postgres, so it is the
    // other store that answers it — and since TASK-122 it does, existence-only
    // (commentExists names the direction a store failure takes, and why).
    if (MONGO_OBJECT_ID.test(id)) return commentExists(id);
    if (!isChatMessageId(id)) return false;
    const found = await pool.query(
      'SELECT 1 FROM messages WHERE id = $1 AND pod_id = $2 LIMIT 1',
      [id, pod],
    );
    return found.rows.length > 0;
  }

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
      "DELETE FROM message_claims WHERE state IN ('completed', 'declined', 'refused') AND expires_at < NOW()",
    );
    const lease = clampLease(options.leaseSeconds);

    // A re-claim is a NEW TURN, so the previous seat's refusal class does not
    // outlive it (wren 71322). Without this, the row from A refuses 429 ->
    // handoff re-offers -> B declines reads `state='declined'` while still
    // carrying `refusal_reason='upstream-refused'`, and that class then
    // attributes A's dead route to B's decision — the same "answered vs never
    // ran" confusion one column over. The release branches all run from a live
    // lease, so this CAS is the one place. The own-holder renewal shares this
    // SET; clearing is a no-op there because a claimed row never carries a
    // class (nothing else can set one without a lease).
    const win = await pool.query(
      `INSERT INTO message_claims (message_id, pod_id, claimed_by, instance_id, expires_at, state)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5), 'claimed')
       ON CONFLICT (message_id) DO UPDATE
         SET claimed_by = EXCLUDED.claimed_by,
             instance_id = EXCLUDED.instance_id,
             expires_at = EXCLUDED.expires_at,
             state = 'claimed',
             refusal_reason = NULL,
             refusal_status = NULL,
             created_at = NOW()
         WHERE message_claims.state = 'declined'
            OR message_claims.state = 'refused'
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
    outcome?: 'declined' | 'completed' | 'refused';
    /** Only read for outcome 'refused' — see that branch below. */
    reason?: string;
    /** Only read for outcome 'refused' with an upstream class. */
    status?: number;
  }): Promise<{
    released: boolean;
    podId?: string;
    state?: 'declined' | 'completed' | 'refused';
    declinedBy?: string[];
    reason?: string;
    status?: number;
  }> {
    const { messageId, agentName, instanceId = 'default' } = options;
    if (!messageId || !agentName) throw new Error('messageId and agentName are required');
    await ensureTable();
    const canonicalAgentName = agentName.toLowerCase();
    const outcome = options.outcome;
    // Every write below is reachable only from a LIVE LEASE (`state='claimed'`).
    // A terminal state must never be reachable from another terminal state: a
    // seat can flip its own tombstone by replaying a release — an ack retry
    // that lands a second outcome — and because a refused row is immediately
    // re-claimable, that would make an already-answered human message
    // re-offerable to a second seat. Losing the race is not an error: the
    // caller gets `released: false` and the handoff (which itself requires
    // `released`) queues nothing.
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
           AND state = 'claimed'
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
    if (outcome === 'refused') {
      // A refusal is NAMED, and on a human wake it is a HANDOFF rather than a
      // close (TASK-099, corrected ruling 71194/71195/71210). The driver held
      // the lease and could not deliver — an upstream 429/502/401 for this
      // seat, or the server refusing the post — so nothing about the agent's
      // CHOICE happened. A per-seat failure must not make the human's message
      // disappear: the row stays claimable exactly like a decline, and the
      // handoff service re-offers the original wake to one remaining listener.
      // The route decides human-vs-agent by whether such a wake exists (the
      // handoff's own `senderIsHuman` filter), not by a second definition here.
      //
      // What this branch adds over `declined` is the RECORD. `completed`
      // DELETEs the row, which leaves "answered" and "never ran"
      // indistinguishable in the one place a kernel-side reader can look; a
      // refusal keeps a tombstone carrying the class and, for an upstream
      // refusal, the HTTP status — on the same retention clock as decline
      // history, history rather than storage.
      const reason = typeof options.reason === 'string'
        ? options.reason.slice(0, MAX_REFUSAL_REASON)
        : null;
      const status = Number.isInteger(options.status)
        && Number(options.status) >= MIN_UPSTREAM_STATUS
        && Number(options.status) <= MAX_UPSTREAM_STATUS
        ? Number(options.status)
        : null;
      const refused = await pool.query(
        `UPDATE message_claims
         SET state = 'refused',
             expires_at = NOW() + make_interval(secs => $4),
             refusal_reason = $5,
             refusal_status = $6,
             declined_by = CASE
               WHEN NOT ($7 = ANY(declined_by))
                 THEN array_append(declined_by, $7)
               ELSE declined_by
             END
         WHERE message_id = $1 AND claimed_by = $2 AND instance_id = $3
           AND state = 'claimed'
         RETURNING message_id, pod_id, state, refusal_reason, refusal_status, declined_by`,
        [
          String(messageId), canonicalAgentName, instanceId, HANDOFF_HISTORY_RETENTION_SECONDS,
          reason, status, `${canonicalAgentName}:${instanceId}`,
        ],
      );
      return refused.rows.length > 0
        ? {
          released: true,
          podId: refused.rows[0].pod_id,
          state: refused.rows[0].state,
          reason: refused.rows[0].refusal_reason || undefined,
          status: refused.rows[0].refusal_status ?? undefined,
          // The refuser is recorded as having had its turn, which is what
          // keeps the re-offer chain finite: without it the handoff would
          // hand the same message straight back to the seat that refused it.
          declinedBy: refused.rows[0].declined_by || [],
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
           AND state = 'claimed'
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
         AND state = 'claimed'
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
