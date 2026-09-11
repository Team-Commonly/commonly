// The page's three numbers are COUNT(*) by outcome on the trail (tools plan
// §6): run the GROUP BY on pg-mem's real adapter, the way the budget test does.
jest.mock('../../../config/db-pg', () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return { pool: new Pool() };
});

// eslint-disable-next-line import/no-unresolved, import/extensions
const ToolCall = require('../../../models/ToolCall');

const row = (over) => ({
  callId: `call-${Math.random().toString(36).slice(2)}`, grantId: 'grant-1', agentUserId: 'agent-a',
  tool: 'github.list_issues', argsDigest: 'a'.repeat(64), outcome: 'ok', ...over,
});

describe('ToolCall.countsForGrant', () => {
  it('counts every outcome for the grant and nothing from other grants', async () => {
    await ToolCall.create(row({}));
    await ToolCall.create(row({ outcome: 'ok' }));
    await ToolCall.create(row({ outcome: 'refused', reason: 'not_in_audience' }));
    await ToolCall.create(row({ outcome: 'pending_approval', approvalId: 'appr-1' }));
    await ToolCall.create(row({ grantId: 'grant-2', outcome: 'failed' }));
    await expect(ToolCall.countsForGrant('grant-1')).resolves.toEqual({ total: 4, ok: 2, refused: 1, pending_approval: 1, failed: 0 });
    await expect(ToolCall.countsForGrant('grant-none')).resolves.toEqual({ total: 0, ok: 0, refused: 0, pending_approval: 0, failed: 0 });
  });
});
