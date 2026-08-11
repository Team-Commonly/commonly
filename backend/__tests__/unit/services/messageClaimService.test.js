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

const CAS = /INSERT INTO message_claims[\s\S]*ON CONFLICT \(message_id\) DO UPDATE[\s\S]*WHERE message_claims\.expires_at < NOW\(\)/;

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
