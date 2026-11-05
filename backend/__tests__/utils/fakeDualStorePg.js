/**
 * ADR-034 D3: an in-memory stand-in for pgTableAdapter that keeps the SQL's
 * version guard and lets a test delay or fail any call. Shared by the
 * dual-store unit tests.
 */
/** Mirrors pgTableAdapter's SQL: an upsert applies only above the stored version. */
const fakePg = () => {
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
    /** Rows after `afterId` in id order, as pgTableAdapter.list returns them. */
    list: (afterId, limit) => run('list', () => [...rows.keys()].sort()
      .filter((id) => afterId == null || id > afterId).slice(0, limit)
      .map((id) => ({ row: { ...rows.get(id).row }, version: rows.get(id).version }))),
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
