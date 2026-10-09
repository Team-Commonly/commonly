/**
 * Would mongoose KEEP a `$set` path? Declared, or silently dropped?
 *
 * `config` on `Integration` is a strict subdocument: a `$set` naming a path the
 * schema does not declare is dropped with no error, so a write can report
 * success while the row keeps nothing (measured on a real mongod 2026-09-28:
 * six unprefixed `config.*` fields on the hosted-MCP callback all vanished).
 * An arm that reads back a mock cannot see this — the mock records what it was
 * handed, not what the schema kept.
 *
 * A nested OBJECT is declared by its leaves rather than by its own name:
 * `schema.path('config.pendingAuth')` is false while
 * `schema.path('config.pendingAuth.state')` is true, and the object persists.
 */
const declaresPath = (schema, path) => Boolean(
  schema.path(path)
  || Object.keys(schema.paths || {}).some((declared) => declared === path || declared.startsWith(`${path}.`)),
);

/** The subset of `paths` the schema would drop. Empty is the only acceptable answer for a write. */
const undeclaredPaths = (schema, paths) => paths.filter((path) => !declaresPath(schema, path));

module.exports = { declaresPath, undeclaredPaths };
