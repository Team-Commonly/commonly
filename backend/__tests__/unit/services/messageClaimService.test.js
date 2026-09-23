/**
 * messageClaimService — ADR-018 kernel CAS.
 *
 * The property under test is the one the whole design hangs on: exactly one
 * winner, losers informed, renewal-by-winning, expiry-as-absence. Tested at
 * the SQL boundary with a scripted pool, same pattern as the retention tests.
 */

jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const { pool } = require('../../../config/db-pg');
const MessageClaimService = require('../../../services/messageClaimService');

const CAS = /INSERT INTO message_claims[\s\S]*ON CONFLICT \(message_id\) DO UPDATE[\s\S]*message_claims\.state = 'declined'[\s\S]*message_claims\.expires_at < NOW\(\)/;

describe('messageClaimService', () => {
  beforeEach(() => {
    pool.query.mockReset();
    // ensureTable() is module-level-latched; feed CREATE/INDEX generously.
    pool.query.mockResolvedValue({ rows: [] });
  });

  test('a won claim returns the lease from a single CAS statement', async () => {
    pool.query.mockImplementation((sql) => {
      if (/INSERT INTO message_claims/.test(sql)) {
        return Promise.resolve({ rows: [{ claimed_by: 'ux-lead', instance_id: 'default', expires_at: new Date() }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await MessageClaimService.claim({ messageId: '52907', podId: 'p1', agentName: 'UX-Lead' });
    expect(r.claimed).toBe(true);
    expect(r.claimedBy).toBe('ux-lead'); // lowercased — one identity casing, learned the hard way (#804)
    const cas = pool.query.mock.calls.find(([sql]) => /INSERT INTO message_claims/.test(sql));
    expect(cas[0]).toMatch(CAS);
    expect(pool.query.mock.calls.some(([sql]) => /ADD COLUMN IF NOT EXISTS state/.test(sql))).toBe(true);
    expect(pool.query.mock.calls.some(([sql]) => /ADD COLUMN IF NOT EXISTS declined_by/.test(sql))).toBe(true);
  });

  test('prunes expired completed, abandoned-decline and refusal history', async () => {
    pool.query.mockImplementation((sql) => {
      if (/DELETE FROM message_claims/.test(sql)) {
        // `refused` joins the prune list with its own retention clock: a
        // tombstone is history, and history that never expires is storage.
        expect(sql).toContain("state IN ('completed', 'declined', 'refused')");
      }
      if (/INSERT INTO message_claims/.test(sql)) {
        return Promise.resolve({ rows: [{ claimed_by: 'ux-lead', instance_id: 'default', expires_at: new Date() }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await MessageClaimService.claim({ messageId: 'prune-me', podId: 'p1', agentName: 'ux-lead' });
    expect(pool.query.mock.calls.some(([sql]) => /DELETE FROM message_claims/.test(sql))).toBe(true);
  });

  test('the CAS also lets the current holder win — renewal is the same call', async () => {
    const cas = pool.query.mock.calls; // shape assertion below
    pool.query.mockImplementation((sql) => {
      if (/INSERT INTO message_claims/.test(sql)) {
        expect(sql).toMatch(/claimed_by = EXCLUDED\.claimed_by/);
        return Promise.resolve({ rows: [{ claimed_by: 'ux-lead', instance_id: 'default', expires_at: new Date() }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await MessageClaimService.claim({ messageId: '52907', podId: 'p1', agentName: 'ux-lead' });
    expect(r.claimed).toBe(true);
  });

  test('a lost claim reports the live holder, so drivers stand down informed', async () => {
    pool.query.mockImplementation((sql) => {
      if (/INSERT INTO message_claims/.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT claimed_by/.test(sql)) {
        return Promise.resolve({ rows: [{ claimed_by: 'pod-architect', instance_id: 'default', expires_at: new Date(Date.now() + 60000) }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await MessageClaimService.claim({ messageId: '52907', podId: 'p1', agentName: 'sprint-review' });
    expect(r.claimed).toBe(false);
    expect(r.claimedBy).toBe('pod-architect');
  });

  test('lease length is clamped — no parking a claim for an hour', async () => {
    pool.query.mockImplementation((sql, params) => {
      if (/INSERT INTO message_claims/.test(sql)) {
        expect(params[4]).toBe(600); // MAX_LEASE_SECONDS
        return Promise.resolve({ rows: [{ claimed_by: 'a', instance_id: 'default', expires_at: new Date() }] });
      }
      return Promise.resolve({ rows: [] });
    });
    await MessageClaimService.claim({
      messageId: 'm', podId: 'p', agentName: 'a', leaseSeconds: 99999,
    });
  });

  test('release only deletes the caller\'s own claim, and a miss is not an error', async () => {
    pool.query.mockImplementation((sql) => {
      if (/DELETE FROM message_claims/.test(sql)) {
        expect(sql).toMatch(/claimed_by = \$2 AND instance_id = \$3/);
        return Promise.resolve({ rows: [] }); // someone else re-won after our lease expired
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await MessageClaimService.release({ messageId: 'm', agentName: 'a' });
    expect(r.released).toBe(false); // reported, not thrown — claim-then-decline is a normal path (D6)
  });

  test('a decline preserves a bounded handoff record instead of deleting the claim', async () => {
    pool.query.mockImplementation((sql, params) => {
      if (/UPDATE message_claims/.test(sql)) {
        expect(sql).toMatch(/SET state = 'declined'/);
        expect(sql).toMatch(/expires_at = NOW\(\) \+ make_interval\(secs => \$5\)/);
        expect(sql).toMatch(/array_append\(declined_by, \$4\)/);
        expect(params).toEqual(['m', 'seat-a', 'default', 'seat-a:default', 3600]);
        return Promise.resolve({
          rows: [{ pod_id: 'p1', state: 'declined', declined_by: ['seat-a:default'] }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const r = await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a', outcome: 'declined',
    });

    expect(r).toEqual({
      released: true, podId: 'p1', state: 'declined', declinedBy: ['seat-a:default'],
    });
  });

  test('a refusal keeps a named tombstone with its class, status and refuser', async () => {
    // TASK-099: the whole point of the third outcome is that the kernel can
    // still tell "answered" from "never ran" after the turn closed. A DELETE
    // erases that difference, so the refusal must retain the row — carrying the
    // CLASS (countable), the upstream status where there is one, and the
    // refusing seat, which is what keeps the re-offer chain finite.
    pool.query.mockImplementation((sql, params) => {
      if (/UPDATE message_claims/.test(sql)) {
        expect(sql).toMatch(/SET state = 'refused'/);
        expect(sql).toMatch(/refusal_reason = \$5/);
        expect(sql).toMatch(/refusal_status = \$6/);
        expect(sql).toMatch(/array_append\(declined_by, \$7\)/);
        expect(params).toEqual([
          'm', 'seat-a', 'default', 3600, 'upstream-refused', 429, 'seat-a:default',
        ]);
        return Promise.resolve({
          rows: [{
            pod_id: 'p1', state: 'refused', refusal_reason: 'upstream-refused',
            refusal_status: 429, declined_by: ['seat-a:default'],
          }],
        });
      }
      expect(sql).not.toMatch(/DELETE FROM message_claims/);
      return Promise.resolve({ rows: [] });
    });

    const r = await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a', outcome: 'refused',
      reason: 'upstream-refused', status: 429,
    });

    expect(r).toEqual({
      released: true,
      podId: 'p1',
      state: 'refused',
      reason: 'upstream-refused',
      status: 429,
      declinedBy: ['seat-a:default'],
    });
    expect(pool.query.mock.calls.some(([sql]) => /DELETE FROM message_claims/.test(sql))).toBe(false);
  });

  test('a refused claim is immediately claimable by another seat', async () => {
    // The kernel half of the corrected ruling: a refusal on a human wake hands
    // the message on. If the CAS did not admit `refused`, the re-offered seat
    // would be told the row is held and stand down — the human's message would
    // disappear silently, which is the exact failure this outcome exists to
    // prevent.
    pool.query.mockImplementation((sql) => {
      if (/INSERT INTO message_claims/.test(sql)) {
        expect(sql).toMatch(/message_claims\.state = 'refused'/);
        return Promise.resolve({
          rows: [{
            claimed_by: 'seat-b', instance_id: 'default', expires_at: new Date(),
            state: 'claimed', declined_by: ['seat-a:default'],
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const r = await MessageClaimService.claim({ messageId: 'm', podId: 'p1', agentName: 'seat-b' });
    expect(r).toMatchObject({ claimed: true, claimedBy: 'seat-b' });
  });

  test('a re-claim is a new turn: the previous seat\'s refusal class does not outlive it', async () => {
    // connector-ops 71316, ruled by wren 71322. The PR's own headline path:
    // A refuses upstream-refused/429 -> the handoff re-offers -> B claims and
    // declines. The row is B's turn now, so it must not still read
    // `refusal_reason='upstream-refused'`; that would attribute A's dead route
    // to B's decision, which is the "answered vs never ran" confusion one
    // column over. The release branches only run from a live lease, so the CAS
    // is the single place the class can be reset.
    //
    // The fake assigns the columns the statement actually assigns: deleting the
    // reset from the CAS leaves the class behind and this test fails on the
    // intermediate assertion, not on a string match.
    const row = {
      claimed_by: null,
      instance_id: 'default',
      expires_at: new Date(),
      state: null,
      declined_by: [],
      refusal_reason: null,
      refusal_status: null,
    };
    pool.query.mockImplementation((sql, params) => {
      const claimant = String(params?.[2] || 'seat-a');
      if (/INSERT INTO message_claims/.test(sql)) {
        row.claimed_by = claimant;
        row.state = 'claimed';
        // Each column is assigned only if the CAS assigns it: a fake that
        // clears both whenever either appears cannot tell a half-reset from a
        // full one, which is how a surviving mutation hides.
        if (/refusal_reason = NULL/.test(sql)) row.refusal_reason = null;
        if (/refusal_status = NULL/.test(sql)) row.refusal_status = null;
        return Promise.resolve({ rows: [{ ...row }] });
      }
      if (/SET state = 'refused'/.test(sql)) {
        row.state = 'refused';
        row.refusal_reason = params[4];
        row.refusal_status = params[5];
        row.declined_by = [params[6]];
        return Promise.resolve({ rows: [{ message_id: 'm', pod_id: 'p1', ...row }] });
      }
      if (/SET state = 'declined'/.test(sql)) {
        row.state = 'declined';
        row.declined_by = [...row.declined_by, params[3]];
        return Promise.resolve({ rows: [{ message_id: 'm', pod_id: 'p1', ...row }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await MessageClaimService.claim({ messageId: 'm', podId: 'p1', agentName: 'seat-a' });
    await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a', outcome: 'refused', reason: 'upstream-refused', status: 429,
    });
    expect(row.refusal_reason).toBe('upstream-refused');
    expect(row.refusal_status).toBe(429);

    const reClaim = await MessageClaimService.claim({ messageId: 'm', podId: 'p1', agentName: 'seat-b' });
    expect(reClaim).toMatchObject({ claimed: true, claimedBy: 'seat-b' });
    expect(row.refusal_reason).toBeNull();
    expect(row.refusal_status).toBeNull();

    const declined = await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-b', outcome: 'declined',
    });
    expect(declined).toMatchObject({ released: true, state: 'declined' });
    expect(row).toMatchObject({
      state: 'declined', refusal_reason: null, refusal_status: null,
      declined_by: ['seat-a:default', 'seat-b:default'],
    });
  });

  test('a refusal reason is bounded, and an absent or unusable one stays absent', async () => {
    // Truncation, not rejection: a reason that is too long must never be able
    // to fail its own release. A missing reason must not become the string
    // "undefined" either — absence is the honest record. Same for a status
    // that is not an HTTP 4xx/5xx integer: the column stays NULL rather than
    // recording a number a reader would take for a real upstream answer.
    const calls = [];
    pool.query.mockImplementation((sql, params) => {
      if (/UPDATE message_claims/.test(sql)) {
        calls.push(params);
        return Promise.resolve({ rows: [{ pod_id: 'p1', state: 'refused', refusal_reason: params[4] }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a', outcome: 'refused', reason: 'x'.repeat(400),
    });
    await MessageClaimService.release({ messageId: 'm', agentName: 'seat-a', outcome: 'refused' });
    await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a', outcome: 'refused', reason: 42, status: '429',
    });
    await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a', outcome: 'refused', reason: 'upstream-refused', status: 200,
    });
    await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a', outcome: 'refused', reason: 'upstream-refused', status: 429,
    });

    expect(calls[0][4]).toHaveLength(256);
    expect(calls[1][4]).toBeNull();
    expect(calls[2][4]).toBeNull();
    expect(calls[3][4]).toBe('upstream-refused');
    expect(calls[3][5]).toBeNull(); // 200 is not a refusal status
    expect(calls[4][5]).toBe(429);
  });

  test('a completion with no handoff history still deletes the claim', async () => {
    // The paired control for the refusal above: the retention is a property of
    // a refusal, not of the outcome argument. An ordinary answered message must
    // not start accumulating tombstones.
    pool.query.mockImplementation((sql) => {
      if (/UPDATE message_claims/.test(sql)) {
        expect(sql).toMatch(/state = 'completed'/);
        return Promise.resolve({ rows: [] }); // no declined_by → falls through
      }
      if (/DELETE FROM message_claims/.test(sql)) {
        return Promise.resolve({ rows: [{ message_id: 'm', pod_id: 'p1' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const r = await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a', outcome: 'completed',
    });

    expect(r).toEqual({ released: true, podId: 'p1' });
    expect(pool.query.mock.calls.some(([sql]) => /DELETE FROM message_claims/.test(sql))).toBe(true);
  });

  test('a terminal row cannot be re-released: no outcome flips a tombstone', async () => {
    // Wren's ruling at 02:28Z: `AND state = 'claimed'` on all four write paths
    // — a terminal state must only be reachable from a live lease. The trigger
    // is an ack retry that lands a second outcome, and it matters because a
    // refused row is immediately re-claimable: flipping a `completed` tombstone
    // to `refused` makes an already-answered human message re-offerable, and
    // the handoff wakes it at a second seat.
    //
    // The fake below is a one-row table that HONOURS the guard the SQL carries,
    // rather than being told the answer. That is what makes it able to fail:
    // drop the guard from any branch and the fake reports the write as matched,
    // the outcome as released, and the tombstone as overwritten.
    const row = { state: 'claimed', declined_by: ['seat-a:default'] };
    const guardMissing = [];
    const applyWrite = (sql) => {
      const guarded = /state = 'claimed'/.test(sql);
      if (!guarded) guardMissing.push(sql.match(/(UPDATE|DELETE) FROM message_claims/)[1]);
      if (row.state !== 'claimed' && guarded) return { rows: [] };
      if (/SET state = 'declined'/.test(sql)) row.state = 'declined';
      if (/SET state = 'refused'/.test(sql)) row.state = 'refused';
      if (/SET state = 'completed'/.test(sql)) row.state = 'completed';
      if (/DELETE FROM message_claims/.test(sql)) row.state = 'deleted';
      return { rows: [{ message_id: 'm', pod_id: 'p1', state: row.state, declined_by: row.declined_by }] };
    };
    pool.query.mockImplementation((sql) => {
      if (/UPDATE message_claims/.test(sql) || /DELETE FROM message_claims/.test(sql)) {
        return Promise.resolve(applyWrite(sql));
      }
      return Promise.resolve({ rows: [] });
    });

    // A live lease completes and keeps its handoff history as a tombstone.
    const first = await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a', outcome: 'completed',
    });
    expect(first).toMatchObject({ released: true, state: 'completed' });

    // Every later release from the same seat is now a no-op, whatever it asks
    // for. `completed -> refused` is the one that would re-offer the message.
    const flipToRefused = await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a', outcome: 'refused', reason: 'upstream-refused', status: 429,
    });
    expect(flipToRefused).toEqual({ released: false });
    expect(row.state).toBe('completed');

    const flipToDeclined = await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a', outcome: 'declined',
    });
    expect(flipToDeclined).toEqual({ released: false });
    expect(row.state).toBe('completed');

    // The legacy no-outcome DELETE is the fourth path, and it must not remove a
    // tombstone either — that would erase the record instead of flipping it.
    const legacyDelete = await MessageClaimService.release({
      messageId: 'm', agentName: 'seat-a',
    });
    expect(legacyDelete).toEqual({ released: false });
    expect(row.state).toBe('completed');

    expect(guardMissing).toEqual([]);
  });

  test('a completed claim remains terminal: a later seat cannot take it', async () => {
    pool.query.mockImplementation((sql) => {
      if (/INSERT INTO message_claims/.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT claimed_by/.test(sql)) {
        return Promise.resolve({
          rows: [{
            claimed_by: 'seat-a', instance_id: 'default', expires_at: new Date(), state: 'completed', declined_by: [],
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const r = await MessageClaimService.claim({ messageId: 'm', podId: 'p1', agentName: 'seat-b' });
    expect(r).toMatchObject({ claimed: false, state: 'completed', claimedBy: 'seat-a' });
  });

  test('an expired lease reads as unheld', async () => {
    pool.query.mockImplementation((sql) => {
      if (/SELECT claimed_by/.test(sql)) {
        expect(sql).toMatch(/expires_at >= NOW\(\)/);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await MessageClaimService.holder('m');
    expect(r.claimed).toBe(false);
  });
});

/**
 * messageExists — the claim route's precondition (TASK-118).
 *
 * Two of these are about the SHAPE of the answer rather than its value, because
 * vera's gate (71873) named both traps and neither is a data question:
 *
 *  - `messages.id` is SERIAL in the shipped schema but VARCHAR(24) in the unit
 *    harness (`__tests__/utils/testUtils.js:159`), so a test that runs here can
 *    pass on a value production rejects. The first test therefore asserts the
 *    shipped DDL still says SERIAL — that is what makes the numeric guard
 *    correct, and it reddens if anyone changes the id type — instead of
 *    pretending the in-memory column is the real one.
 *  - The guard's whole job is to keep a malformed id away from Postgres, so the
 *    assertion is that NO query was issued, not that the result was false.
 *    A false-from-the-database would still be a 500 in production when the
 *    column is an integer.
 */
describe('messageExists', () => {
  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [] });
  });

  test('the numeric guard rests on a SERIAL id — the shipped schema still says so', () => {
    const fs = require('fs');
    const path = require('path');
    const schema = fs.readFileSync(path.resolve(__dirname, '../../../config/schema.sql'), 'utf8');
    // Scoped to the messages block, and that scoping is the point: slicing to
    // the end of the file left a LATER table's `id SERIAL PRIMARY KEY` matching
    // this regex, so the assertion stayed green when messages.id was mutated to
    // UUID. Found by the mutation ledger, not by review.
    const start = schema.indexOf('CREATE TABLE IF NOT EXISTS messages');
    const messages = schema.slice(start, schema.indexOf('CREATE TABLE', start + 10));
    expect(messages).toMatch(/id SERIAL PRIMARY KEY/);
  });

  test('a non-numeric id never reaches the database — the 500 that would become', async () => {
    await expect(MessageClaimService.messageExists('TASK-110', 'p1')).resolves.toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('an empty id or pod is answered without a query too', async () => {
    await expect(MessageClaimService.messageExists('', 'p1')).resolves.toBe(false);
    await expect(MessageClaimService.messageExists('42', '')).resolves.toBe(false);
    await expect(MessageClaimService.messageExists(undefined, undefined)).resolves.toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('existence is scoped to the pod — the id alone is not the question', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    await expect(MessageClaimService.messageExists('52907', 'p1')).resolves.toBe(true);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/FROM messages WHERE id = \$1 AND pod_id = \$2/);
    expect(params).toEqual(['52907', 'p1']);
  });

  test('a numeric id with no row in that pod is false, not an error', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(MessageClaimService.messageExists('52907', 'other-pod')).resolves.toBe(false);
  });

  // The digits test is not the shape test: SERIAL is int4, so an id above
  // 2147483647 is `22003 out of range`, which the route's catch turns into a
  // 500 — the same wrong answer as 'TASK-110', reached by a different error.
  test('an id past int4 is answered without a query — 22003, not an absent row', async () => {
    await expect(MessageClaimService.messageExists('2147483648', 'p1')).resolves.toBe(false);
    await expect(MessageClaimService.messageExists('999999999999', 'p1')).resolves.toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('the bound is inclusive and a longer input is not an escape', async () => {
    // 2147483647 is a legitimate id, so the database IS asked — this is what
    // makes the upper bound load-bearing in both directions.
    await expect(MessageClaimService.messageExists('2147483647', 'p1')).resolves.toBe(false);
    expect(pool.query.mock.calls[0][1]).toEqual(['2147483647', 'p1']);
    // 100 digits are digits, and Number(...) calls it an integer; only the
    // bound rejects it.
    pool.query.mockClear();
    await expect(MessageClaimService.messageExists('9'.repeat(100), 'p1')).resolves.toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
