// Plan §8 / §10 step 5, the retrofit half. `tool_calls` self-bootstraps, so an
// instance that created the table before `credential_owner_id` existed never
// gains the column from `CREATE TABLE IF NOT EXISTS` — the ALTER is the only
// thing that adds it, and a statement nothing asserts is a statement someone
// deletes.
//
// Why this is a structural arm and not a behavioural one: pg-mem cannot run
// `CREATE TABLE IF NOT EXISTS` against a table that already exists — it throws
// "Not supported: the query ran generated an AST which parts have not been read
// by the query planner" before evaluating the clause (measured on pg-mem
// 3.x, 2026-09-29). So the retrofit's Postgres behaviour is not representable in
// the Tier-0 harness, and this arm witnesses the statement the model issues
// instead. ToolCall.credentialOwner.test.js holds the behavioural half.
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const { pool } = require('../../../config/db-pg');
// eslint-disable-next-line import/no-unresolved, import/extensions
const ToolCall = require('../../../models/ToolCall');

describe('the trail schema retrofit', () => {
  it('issues the ALTER that adds the column, because CREATE TABLE IF NOT EXISTS never adds one', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await ToolCall.create({
      callId: 'call-owner',
      grantId: 'grant-owner',
      agentUserId: 'agent-a',
      tool: 'github.list_issues',
      argsDigest: 'a'.repeat(64),
      outcome: 'ok',
      credentialOwnerId: 'owner-1',
    });

    const statements = pool.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => /ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS credential_owner_id/.test(sql)))
      .toBe(true);
    const insert = statements.find((sql) => /INSERT INTO tool_calls/.test(sql));
    expect(insert).toMatch(/credential_owner_id/);
    // The value is bound, not interpolated: an owner id is data.
    const insertCall = pool.query.mock.calls.find(([sql]) => /INSERT INTO tool_calls/.test(String(sql)));
    expect(insertCall[1]).toContain('owner-1');
  });
});
