/**
 * `ToolCall.findApprovedRun`, executed against pg-mem. The sweep trusts this
 * row to say what happened to an approved call whose process died, so its
 * filters are the contract: this grant's approval only, never the parked row, and the
 * newest row when more than one exists. The approval suites mock the model and
 * prove none of that. The real-Postgres arm is in grantRecord.realPg.test.js.
 */
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();

jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const ToolCall = require('../../../models/ToolCall').default;

const insert = (callId, approvalId, outcome, occurredAt, reason = null, grantId = 'grant-1') => mockPool.query(
  `INSERT INTO tool_calls (call_id, grant_id, approval_id, outcome, reason, occurred_at)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  [callId, grantId, approvalId, outcome, reason, occurredAt],
);

beforeAll(async () => {
  await mockPool.query(`CREATE TABLE tool_calls (
    call_id VARCHAR(255) PRIMARY KEY,
    grant_id VARCHAR(255) NOT NULL,
    approval_id VARCHAR(255),
    outcome VARCHAR(32) NOT NULL,
    reason VARCHAR(255),
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL
  )`);
});

beforeEach(async () => {
  await mockPool.query('DELETE FROM tool_calls');
});

describe('ToolCall.findApprovedRun', () => {
  test('null when the approval has only its parked row', async () => {
    await insert('parked', 'approval-1', 'pending_approval', new Date('2026-11-05T10:00:00Z'));
    await expect(ToolCall.findApprovedRun('grant-1', 'approval-1')).resolves.toBeNull();
  });

  test('the resolved row, with its reason', async () => {
    await insert('parked', 'approval-1', 'pending_approval', new Date('2026-11-05T10:00:00Z'));
    await insert('ran', 'approval-1', 'failed', new Date('2026-11-05T10:01:00Z'), 'upstream_tool_error');
    await expect(ToolCall.findApprovedRun('grant-1', 'approval-1')).resolves.toEqual({
      callId: 'ran', outcome: 'failed', reason: 'upstream_tool_error', at: new Date('2026-11-05T10:01:00Z'),
    });
  });

  test("another approval's row is not this one's", async () => {
    await insert('other', 'approval-2', 'ok', new Date('2026-11-05T10:01:00Z'));
    await expect(ToolCall.findApprovedRun('grant-1', 'approval-1')).resolves.toBeNull();
  });

  test("another grant's row is not this one's", async () => {
    await insert('other', 'approval-1', 'ok', new Date('2026-11-05T10:01:00Z'), null, 'grant-2');
    await expect(ToolCall.findApprovedRun('grant-1', 'approval-1')).resolves.toBeNull();
  });

  test('the newest of several resolved rows wins', async () => {
    await insert('older', 'approval-1', 'failed', new Date('2026-11-05T10:01:00Z'), 'broker_error');
    await insert('newer', 'approval-1', 'ok', new Date('2026-11-05T10:02:00Z'));
    await expect(ToolCall.findApprovedRun('grant-1', 'approval-1')).resolves.toMatchObject({ callId: 'newer' });
  });
});
