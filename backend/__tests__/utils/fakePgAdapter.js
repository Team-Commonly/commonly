/**
 * ADR-034 D3: an in-memory stand-in for dualStore's PgAdapter. It keeps the
 * SQL's version guards (an upsert applies only above the stored version; a
 * replace or removeAt only at the version read) and lets a test delay or fail
 * any call. Rows are keyed by their `id` column. pg-mem is not used because it
 * ignores the guard's `ON CONFLICT ... DO UPDATE ... WHERE`.
 */
/** Mirrors pgTableAdapter's SQL: an upsert applies only above the stored version. */
const fakePg = ({ presenceColumns = [] } = {}) => {
  const rows = new Map();
  const calls = [];
  const holds = {};
  const fails = {};
  const run = async (method, apply) => {
    calls.push(method);
    if (holds[method]) {
      const hold = holds[method];
      delete holds[method];
      hold.reached();
      await hold.gate;
    }
    if (fails[method] > 0) {
      fails[method] -= 1;
      throw new Error(`fake ${method} failed`);
    }
    return apply();
  };
  return {
    rows,
    calls,
    // The columns the store may test with $exists, as pgTableAdapter declares them.
    presenceColumns,
    upsert: (row, version) => run('upsert', () => {
      const current = rows.get(row.id);
      if (current && current.version >= version) return false;
      rows.set(row.id, { row: { ...row }, version });
      return true;
    }),
    remove: (id, version) => run('remove', () => {
      const current = rows.get(id);
      if (current && current.version < version) rows.delete(id);
    }),
    // pg mode's compare-and-set: applies only to the row still at `version`.
    replace: (row, version) => run('replace', () => {
      const current = rows.get(row.id);
      if (!current || current.version !== version) return false;
      rows.set(row.id, { row: { ...row }, version: version + 1 });
      return true;
    }),
    removeAt: (id, version) => run('removeAt', () => {
      const current = rows.get(id);
      if (!current || current.version !== version) return false;
      rows.delete(id);
      return true;
    }),
    get: (id) => run('get', () => {
      const current = rows.get(id);
      return current ? { row: { ...current.row }, version: current.version } : null;
    }),
    // Keyset paging in id order, like the SQL's COLLATE "C" (ids here are ASCII).
    scan: (after, limit) => run('scan', () => [...rows.keys()]
      .filter((id) => after == null || id > after).sort().slice(0, limit)
      .map((id) => ({ id, row: { ...rows.get(id).row }, version: rows.get(id).version }))),
    // pgTableAdapter's filtered read: equality (null is IS NULL), ranges, $in and $exists,
    // ANDed, in id order. A range never matches NULL, as in SQL. The real
    // adapter's column and operator refusals are tested against its SQL.
    findWhere: (where, limit) => run('findWhere', () => {
      const scalar = (value) => (value instanceof Date ? value.getTime() : value);
      const ranges = {
        $gt: (a, b) => a > b, $gte: (a, b) => a >= b, $lt: (a, b) => a < b, $lte: (a, b) => a <= b,
      };
      const matches = (row) => Object.entries(where).every(([column, condition]) => {
        const stored = row[column] ?? null;
        if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
          // $exists is IS [NOT] NULL; $in never matches NULL, as `= ANY` doesn't.
          if ('$exists' in condition) return (stored !== null) === condition.$exists;
          if ('$in' in condition) {
            return stored !== null && condition.$in.some((value) => scalar(value) === scalar(stored));
          }
          return stored !== null && Object.entries(condition).every(([op, value]) => {
            if (!ranges[op]) throw new Error(`fake findWhere: unsupported operator ${op}`);
            return ranges[op](scalar(stored), scalar(value));
          });
        }
        return condition === null ? stored === null : scalar(stored) === scalar(condition);
      });
      return [...rows.keys()].sort().filter((id) => matches(rows.get(id).row))
        .slice(0, limit ?? Infinity)
        .map((id) => ({ row: { ...rows.get(id).row }, version: rows.get(id).version }));
    }),
    /** The next call to `method` waits until the returned release() runs. */
    hold(method) {
      let release;
      let reached;
      const gate = new Promise((resolve) => { release = resolve; });
      const arrived = new Promise((resolve) => { reached = resolve; });
      holds[method] = { gate, reached };
      return { release, arrived };
    },
    failNext(method, times = 1) { fails[method] = times; },
  };
};

module.exports = { fakePg };
