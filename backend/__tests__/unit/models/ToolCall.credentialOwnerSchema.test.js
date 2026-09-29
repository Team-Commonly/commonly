// Plan §8 / §10 step 5, the third place.
//
// `tool_calls` is declared TWICE — `backend/config/schema.sql` (which is what
// `init-pg-db.ts` executes to build a fresh database) and the DDL constant in
// `models/ToolCall.ts` (which builds the table for the Tier-0 harness and
// self-bootstraps a deployment that predates it) — and the INSERT in the model
// names the columns a third time. A column added to some copies but not all
// passes every test on an EXISTING database, where the table is already built,
// and is only wrong on a fresh one, where it is built from whichever copy runs
// first. So this arm asserts the two CREATEs declare the SAME column set and
// that the INSERT names nothing outside it — not merely that today's new column
// is present in both, which would let the next column repeat the mistake.
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const fs = require('fs');
const path = require('path');
// eslint-disable-next-line import/no-unresolved, import/extensions
const { pool } = require('../../../config/db-pg');
// eslint-disable-next-line import/no-unresolved, import/extensions
const ToolCall = require('../../../models/ToolCall');

const SCHEMA = fs.readFileSync(path.join(__dirname, '../../../config/schema.sql'), 'utf8');
const MODEL = fs.readFileSync(path.join(__dirname, '../../../models/ToolCall.ts'), 'utf8');

const CONSTRAINT_WORDS = ['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT', 'CREATE', 'INDEX'];

/** The `CREATE TABLE ... ( ... );` block for one table, or '' if absent. */
const createBlock = (sql, table) => {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start === -1) return '';
  const end = sql.indexOf('\n);', start);
  return sql.slice(start, end === -1 ? sql.length : end);
};

/** Column names declared by a CREATE block: first token of each non-comment line. */
const columnsOf = (block) => block
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('--') && !line.startsWith('CREATE TABLE'))
  .map((line) => (/^([A-Za-z_][A-Za-z0-9_]*)\s/.exec(line) || [])[1])
  .filter((name) => name && !CONSTRAINT_WORDS.includes(name.toUpperCase()));

describe('the trail schema exists in three places that must agree', () => {
  const shipped = createBlock(SCHEMA, 'tool_calls');
  const model = createBlock(MODEL, 'tool_calls');

  it('declares the same columns in schema.sql and the model DDL', () => {
    expect(shipped).not.toBe('');
    expect(model).not.toBe('');
    const shippedColumns = columnsOf(shipped);
    const modelColumns = columnsOf(model);
    expect(shippedColumns.length).toBeGreaterThan(5);
    // Sorted comparison, so a reordering is not a failure and a missing column is.
    expect([...modelColumns].sort()).toEqual([...shippedColumns].sort());
    expect(shippedColumns).toContain('credential_owner_id');
  });

  it('names no column in the INSERT that the shipped table does not declare', async () => {
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

    const insert = pool.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => /INSERT INTO tool_calls/.test(sql));
    const listed = (/\(([^)]*)\)\s*VALUES/.exec(insert) || [])[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    expect(listed.length).toBeGreaterThan(5);
    expect(listed.filter((name) => !columnsOf(shipped).includes(name))).toEqual([]);
  });
});
