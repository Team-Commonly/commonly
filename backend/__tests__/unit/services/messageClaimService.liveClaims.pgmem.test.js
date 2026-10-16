/**
 * liveClaimsHeldBy, EXECUTED against pg-mem (stickiness Phase 1b).
 *
 * Attention asks it "is this agent answering P right now?": an agent posting
 * while it holds a live claim on P's message opens no needs-you row for P. The
 * SQL is the contract, so these cases run the shipped query: only a LIVE lease
 * held by THIS agent instance in THIS pod counts. A lapsed, released, declined
 * or someone else's lease answers nobody, and then the row is recorded.
 */
const { newDb } = require('pg-mem');

const mockDb = newDb();
const realPool = new (mockDb.adapters.createPg().Pool)();
// The service bootstraps its table with an array-column default pg-mem cannot
// parse (the same limit messageClaimHandoff.test.js names). That DDL is skipped
// here, the table is created below without it, and every other statement,
// including the query under test, runs for real.
const BOOTSTRAP_DDL = /^\s*(CREATE TABLE IF NOT EXISTS message_claims|ALTER TABLE message_claims|CREATE INDEX IF NOT EXISTS idx_message_claims)/;
const mockPool = {
  query: (sql, params) => (BOOTSTRAP_DDL.test(sql) ? Promise.resolve({ rows: [] }) : realPool.query(sql, params)),
};

jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const MessageClaimService = require('../../../services/messageClaimService');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OTHER_POD = 'aaaaaaaaaaaaaaaaaaaaaa02';

const lease = (messageId, {
  podId = POD, claimedBy = 'scout', instanceId = 'u1', state = 'claimed', expiresIn = '60 seconds',
} = {}) => realPool.query(
  `INSERT INTO message_claims (message_id, pod_id, claimed_by, instance_id, state, expires_at)
   VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${expiresIn}')`,
  [messageId, podId, claimedBy, instanceId, state],
);

beforeAll(async () => {
  await realPool.query(`CREATE TABLE message_claims (
    message_id TEXT PRIMARY KEY,
    pod_id TEXT NOT NULL,
    claimed_by TEXT NOT NULL,
    instance_id TEXT NOT NULL DEFAULT 'default',
    expires_at TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL DEFAULT 'claimed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
});

beforeEach(async () => {
  await realPool.query('DELETE FROM message_claims');
});

const held = () => MessageClaimService.liveClaimsHeldBy({ podId: POD, agentName: 'Scout', instanceId: 'u1' });

describe('liveClaimsHeldBy', () => {
  test('returns the message this agent instance holds a live lease on in this pod', async () => {
    await lease('900');
    await expect(held()).resolves.toEqual(['900']);
  });

  test('matches the agent name in any case: a claim stored as written still counts', async () => {
    await lease('900', { claimedBy: 'Scout' });
    await expect(MessageClaimService.liveClaimsHeldBy({ podId: POD, agentName: 'scout', instanceId: 'u1' }))
      .resolves.toEqual(['900']);
  });

  test('a lapsed lease answers nobody', async () => {
    await lease('900', { expiresIn: '-1 seconds' });
    await expect(held()).resolves.toEqual([]);
  });

  test('a released (completed) or declined lease answers nobody', async () => {
    await lease('900', { state: 'completed' });
    await lease('901', { state: 'declined' });
    await expect(held()).resolves.toEqual([]);
  });

  test("another agent's lease, another instance's, or another pod's answers nobody", async () => {
    await lease('900', { claimedBy: 'forge' });
    await lease('901', { instanceId: 'u2' });
    await lease('902', { podId: OTHER_POD });
    await expect(held()).resolves.toEqual([]);
  });
});
