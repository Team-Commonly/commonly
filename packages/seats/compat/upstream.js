/**
 * Known upstream bugs and what we do about each, as data
 * (compat/upstream.json): `{ id, cli, versions, bug, status, workaround:
 * { name, ref, where, tests[] }, matrix?: { target, check }, references[] }`.
 *
 * We do not wait on upstream. Every row is either "worked around" or "open",
 * and the rule is enforced here, not trusted from the file: a row reads as
 * worked around only when its workaround names the pushed commit it lives on
 * (`ref`, a full sha) and at least one test there that proves it. Anything less is open, with the planned workaround named.
 * An upstream issue is a reference, never the fix, so a link alone changes
 * nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isLimitRow } from './render.js';

export const UPSTREAM_STATUSES = Object.freeze(['worked around', 'open']);

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const SHA = /^[0-9a-f]{40}$/;

/** "worked around" only with a commit and a test; otherwise "open". */
export const upstreamStatusOf = (row) => {
  const workaround = row?.workaround || {};
  const proven = SHA.test(text(workaround.ref)) && Array.isArray(workaround.tests) && workaround.tests.some((t) => text(t));
  return row?.status === 'worked around' && proven ? 'worked around' : 'open';
};

/**
 * Normalise rows for the results document. A row that claims "worked around"
 * without the proof is downgraded and says why, so the page never repeats an
 * unproven claim.
 */
export const normaliseUpstream = (rows) => (Array.isArray(rows) ? rows : []).map((row) => {
  const status = upstreamStatusOf(row);
  const workaround = row?.workaround || {};
  return {
    id: text(row?.id),
    cli: text(row?.cli),
    versions: text(row?.versions),
    bug: text(row?.bug),
    status,
    ...(row?.status === 'worked around' && status === 'open'
      ? { downgraded: 'listed as worked around, but names no commit or no test that proves it' } : {}),
    workaround: {
      name: text(workaround.name),
      ref: text(workaround.ref),
      where: text(workaround.where),
      tests: (Array.isArray(workaround.tests) ? workaround.tests : []).map(text).filter(Boolean),
    },
    ...(row?.matrix?.target && row?.matrix?.check ? { matrix: { target: text(row.matrix.target), check: text(row.matrix.check) } } : {}),
    references: (Array.isArray(row?.references) ? row.references : []).map(text).filter(Boolean),
  };
});

/**
 * What the matrix saw for the check a row points at, so a "worked around"
 * claim sits next to this run's evidence: pass, fail, limit, skip, or
 * "not run" when no row matches.
 */
export const observedOf = (pointer, rows) => {
  if (!pointer) return null;
  const row = (Array.isArray(rows) ? rows : []).find((r) => r.target === pointer.target && r.check === pointer.check);
  if (!row) return 'not run';
  return isLimitRow(row) ? 'limit' : row.status;
};

export const upstreamForResults = (rows, matrixRows) => normaliseUpstream(rows)
  .map((row) => (row.matrix ? { ...row, matrix: { ...row.matrix, observed: observedOf(row.matrix, matrixRows) } } : row));

/** Validate the file; the rows are normalised when they join a results document. */
export const loadUpstream = (path) => {
  if (!path || !existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path} must hold an array of upstream rows`);
  for (const row of parsed) {
    if (!row?.id || !row?.cli || !row?.bug || !row?.workaround?.name) {
      throw new Error(`every upstream row needs id, cli, bug and workaround.name: ${JSON.stringify(row)}`);
    }
    if (!UPSTREAM_STATUSES.includes(row.status)) throw new Error(`upstream row ${row.id} has status ${JSON.stringify(row.status)}; use "worked around" or "open"`);
  }
  return parsed;
};
