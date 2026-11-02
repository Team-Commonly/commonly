// Plan §8 / §10 step 5, the third place.
//
// `tool_calls` is declared by the numbered migrations — `0001_legacy_schema.sql`
// (aliased as `config/schema.sql`) creates it with every column, and `0003`
// retrofits the late columns onto a table that predates them — and the INSERT
// in the model names the columns again. The model used to carry a third copy of
// the DDL and run it on first use; that copy is gone, so this arm asserts the
// model issues no DDL at all and that the INSERT names nothing outside the
// shipped table — not merely that today's new column is present, which would
// let the next column repeat the mistake.
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const fs = require('fs');
const path = require('path');
// eslint-disable-next-line import/no-unresolved, import/extensions
const { pool } = require('../../../config/db-pg');
// eslint-disable-next-line import/no-unresolved, import/extensions
const ToolCall = require('../../../models/ToolCall');

const SCHEMA = fs.readFileSync(path.join(__dirname, '../../../config/schema.sql'), 'utf8');
// schema.sql is the frozen 0001 baseline; a fresh database also runs every
// later migration, so a column a migration adds is part of the shipped table.
const MIGRATIONS = path.join(__dirname, '../../../config/migrations');
const migratedColumns = (table) => fs.readdirSync(MIGRATIONS)
  .filter((name) => /^\d{4}_.*\.sql$/.test(name) && !name.startsWith('0001_'))
  .sort()
  .flatMap((name) => [...fs.readFileSync(path.join(MIGRATIONS, name), 'utf8')
    .matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)`, 'g'))]
    .map(([, column]) => column));

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

const create = () => ToolCall.create({
  callId: 'call-owner',
  grantId: 'grant-owner',
  agentUserId: 'agent-a',
  tool: 'github.list_issues',
  argsDigest: 'a'.repeat(64),
  outcome: 'ok',
  credentialOwnerId: 'owner-1',
});

describe('the trail schema has one source: the migrations', () => {
  const shipped = createBlock(SCHEMA, 'tool_calls');

  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('issues no DDL of its own: the tables are created by migration, not on first use', async () => {
    await create();
    await ToolCall.listForGrant('grant-owner');
    await ToolCall.countsForGrant('grant-owner');
    const statements = pool.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((sql) => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql))).toEqual([]);
  });

  it('names no column in the INSERT that the shipped table does not declare', async () => {
    expect(shipped).not.toBe('');
    expect(columnsOf(shipped)).toContain('credential_owner_id');
    await create();

    const insert = pool.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => /INSERT INTO tool_calls/.test(sql));
    const listed = (/\(([^)]*)\)\s*VALUES/.exec(insert) || [])[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    expect(listed.length).toBeGreaterThan(5);
    const shippedColumns = [...columnsOf(shipped), ...migratedColumns('tool_calls')];
    expect(listed.filter((name) => !shippedColumns.includes(name))).toEqual([]);
    expect(listed).toContain('credential_owner_id');
    // The value is bound, not interpolated: an owner id is data.
    const insertCall = pool.query.mock.calls.find(([sql]) => /INSERT INTO tool_calls/.test(String(sql)));
    expect(insertCall[1]).toContain('owner-1');
  });
});
