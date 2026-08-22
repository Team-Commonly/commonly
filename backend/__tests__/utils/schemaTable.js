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

module.exports = { createTableFor, SCHEMA_PATH };
