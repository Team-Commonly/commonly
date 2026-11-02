// Plan §8 / §10 step 5, the retrofit half. An instance that created
// `tool_calls` before `credential_owner_id` (and the vendor diagnostics) existed
// never gains those columns from `CREATE TABLE IF NOT EXISTS` — 0001's CREATE is
// a no-op there — so migration 0003's ALTERs are the only thing that adds them,
// and a statement nothing asserts is a statement someone deletes.
//
// Why this is a structural arm and not a behavioural one: pg-mem cannot run
// `CREATE TABLE IF NOT EXISTS` against a table that already exists — it throws
// "Not supported: the query ran generated an AST which parts have not been read
// by the query planner" before evaluating the clause (measured on pg-mem
// 3.x, 2026-09-29). The behavioural half runs on real PostgreSQL in
// __tests__/service/pgMigrations.test.js. This arm pins that each ALTER exists
// and declares the column exactly as 0001's CREATE does, so a fresh install
// and a retrofitted one end with the same column.
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '../../../config/migrations');
const BASELINE = fs.readFileSync(path.join(MIGRATIONS, '0001_legacy_schema.sql'), 'utf8');
const RETROFIT = fs.readFileSync(path.join(MIGRATIONS, '0003_self_created_tables.sql'), 'utf8');

/** `<type…>` after `<column>` inside 0001's tool_calls CREATE, without the trailing comma. */
const declaredInBaseline = (column) => {
  const start = BASELINE.indexOf('CREATE TABLE IF NOT EXISTS tool_calls (');
  const block = BASELINE.slice(start, BASELINE.indexOf('\n);', start));
  const m = new RegExp(`^\\s*${column}\\s+([^\\n]*?),?$`, 'm').exec(block);
  return m && m[1];
};

describe('the trail schema retrofit', () => {
  it.each(['credential_owner_id', 'vendor_status', 'vendor_error'])(
    '0003 adds %s with the type 0001 declares, because CREATE TABLE IF NOT EXISTS never adds one',
    (column) => {
      const type = declaredInBaseline(column);
      expect(type).toBeTruthy();
      expect(RETROFIT).toContain(`ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS ${column} ${type};`);
    },
  );
});
