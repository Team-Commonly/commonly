/**
 * Pull a CREATE TABLE statement out of the SHIPPED schema.sql.
 *
 * @sprint-review (56811): "a UNIQUE constraint present in schema.sql and one
 * the database enforces are different claims — only the second is worth a
 * test." Correct, and it landed on my own suites: they hand-wrote their
 * pg-mem tables, so every constraint they exercised was one I had typed into
 * the test. `ON CONFLICT` firing proved my fixture had a unique index. It
 * proved nothing about the DDL that ships.
 *
 * Using this instead means a constraint dropped from schema.sql breaks the
 * tests that depend on it, which is the only arrangement where the test is
 * evidence about production.
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '../../config/schema.sql');

/**
 * Returns the `CREATE TABLE IF NOT EXISTS <name> ( ... );` statement verbatim.
 * Throws if absent — a silently-missing table would show up as a confusing
 * "relation does not exist" much later, which is the failure mode this whole
 * exercise is about.
 */
function createTableFor(name) {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${name}\\s*\\([\\s\\S]*?\\n\\);`, 'i');
  const m = sql.match(re);
  if (!m) throw new Error(`schema.sql has no CREATE TABLE for "${name}"`);
  return m[0];
}

/**
 * The `ALTER TABLE <name> ADD COLUMN IF NOT EXISTS ...` retrofits for a table.
 *
 * `createTableFor` alone is not the table. Late columns are added by ALTER, not
 * inside the CREATE — that is the two-declaration rule this repo learned the
 * hard way, and it applies to fixtures too. A suite that only ran the CREATE
 * got a `messages` with no `payload` and no `thread_root_id`, which fails as
 * "column does not exist" a long way from the cause.
 */
function retrofitsFor(name) {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const re = new RegExp(`ALTER TABLE ${name}\\s+ADD COLUMN IF NOT EXISTS[^;]*;`, 'gi');
  return sql.match(re) || [];
}

/** The whole table as it exists after boot DDL: CREATE plus its retrofits. */
async function applyTable(pool, name) {
  await pool.query(createTableFor(name));
  for (const stmt of retrofitsFor(name)) {
    // eslint-disable-next-line no-await-in-loop
    await pool.query(stmt.replace(/\s+/g, ' '));
  }
}

module.exports = { createTableFor, retrofitsFor, applyTable, SCHEMA_PATH };
