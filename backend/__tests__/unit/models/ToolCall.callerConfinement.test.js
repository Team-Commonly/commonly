jest.mock('../../../config/db-pg', () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return { pool: new Pool() };
});

// eslint-disable-next-line import/no-unresolved, import/extensions
const ToolCall = require('../../../models/ToolCall');
// eslint-disable-next-line import/no-unresolved, import/extensions
const { pool } = require('../../../config/db-pg');
const { applyTable } = require('../../utils/schemaTable');

// The column comes from migration 0007 (F94), applied the way boot applies it.
beforeAll(async () => {
  await applyTable(pool, 'tool_call_budgets');
  await applyTable(pool, 'tool_calls');
});

it('keeps the caller\'s confinement on the trail, and leaves it empty when none was judged', async () => {
  await ToolCall.create({
    callId: 'named-1', grantId: 'grant-byo', agentUserId: 'agent-a', tool: 'linear.list_issues',
    argsDigest: 'a'.repeat(64), outcome: 'ok', callerConfinement: 'named_unconfined',
  });
  await ToolCall.create({
    callId: 'old-1', grantId: 'grant-byo', agentUserId: 'agent-b', tool: 'linear.list_issues',
    argsDigest: 'b'.repeat(64), outcome: 'refused', reason: 'grant_not_found',
  });
  const lines = await ToolCall.listForGrant('grant-byo');
  expect(lines.find((line) => line.callId === 'named-1').callerConfinement).toBe('named_unconfined');
  expect(lines.find((line) => line.callId === 'old-1').callerConfinement).toBeUndefined();
});
