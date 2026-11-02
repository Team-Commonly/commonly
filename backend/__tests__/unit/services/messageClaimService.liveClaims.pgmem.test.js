/**
 * liveClaimsHeldBy, EXECUTED against pg-mem (stickiness Phase 1b).
 *
 * Attention asks it "is this agent answering P right now?": an agent posting
 * while it holds a live claim on P's message opens no needs-you row for P. The
 * SQL is the contract, so these cases run the shipped query: only a LIVE lease
 * held by THIS agent instance in THIS pod counts. A lapsed, released, declined
 * or someone else's lease answers nobody, and then the row is recorded.
 */
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');
const { applyTable } = require('../../utils/schemaTable');

const mockDb = newDb();
const realPool = new (mockDb.adapters.createPg().Pool)();
// The service issues no DDL; the table is migration 0003's, applied below from
// the shipped file. Every statement, including the query under test, runs for real.
const mockPool = realPool;
const MIGRATION_0003 = path.join(__dirname, '../../../config/migrations/0003_self_created_tables.sql');

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
  await realPool.query(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY, pod_id TEXT NOT NULL, thread_root_id INTEGER
  )`);
  // 0003 also retrofits 0001's tool_calls, so that table goes in first. pg-mem
  // cannot parse 0001 whole, hence the one table rather than the runner.
  await applyTable(realPool, 'tool_calls');
  await realPool.query(fs.readFileSync(MIGRATION_0003, 'utf8'));
});

beforeEach(async () => {
  await realPool.query('DELETE FROM message_claims');
  await realPool.query('DELETE FROM messages');
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

describe('liveClaimantsInThread', () => {
  test('finds only active claims on this thread in this pod', async () => {
    await realPool.query('INSERT INTO messages (id, pod_id, thread_root_id) VALUES (900, $1, NULL), (901, $1, 900), (902, $1, 900), (903, $2, 900)', [POD, OTHER_POD]);
    await lease('901', { claimedBy: 'Scout' });
    await lease('902', { claimedBy: 'flint', state: 'completed' });
    await lease('903', { claimedBy: 'other', podId: OTHER_POD });
    await expect(MessageClaimService.liveClaimantsInThread(POD, 900))
      .resolves.toEqual(new Set(['scout:u1']));
  });
});
