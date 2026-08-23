/**
 * A reply edge can only be created where the root is derived.
 *
 * The whole threading feature rests on "every reply carries a thread_root_id".
 * Derivation-on-write gives that for new messages and the backfill gave it for
 * history — but only while every path that can SET `reply_to_message_id` is
 * the path that derives the root in the same statement.
 *
 * @sprint-review (57137) checked the cutoff could not move and found "exactly
 * one production INSERT INTO messages, and it derives thread_root_id inline."
 * True of the instance. This is the class, for the same reason #1138 exists:
 * a sweep is a fact about today, and the thing that breaks it is a second
 * write path added later by someone who never read the sweep.
 *
 * TWO conditions, because one is not enough:
 *   1. every INSERT that can carry a reply edge also derives the root, and
 *   2. nothing UPDATEs `reply_to_message_id` at all — an edge added after the
 *      insert would never pass through the derivation, and the row would sit
 *      un-rooted forever with no error anywhere.
 *
 * (2) is the one a reader is least likely to think of. TASK-040's Mongo
 * write-fallback is the live reminder that a second path to the same data is
 * not hypothetical here.
 */
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '../../..');
const SKIP = new Set(['node_modules', '__tests__', 'dist', 'coverage', '.git']);

const productionFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue; }
      if (/\.(ts|js|sql)$/.test(e.name)) out.push(full);
    }
  };
  walk(BACKEND);
  return out;
};

const rel = (p) => path.relative(BACKEND, p);

describe('a reply edge is only ever created where the root is derived', () => {
  const files = productionFiles().map((f) => ({ path: rel(f), src: fs.readFileSync(f, 'utf8') }));

  test('CONTROL: the scan reaches the model that owns the insert', () => {
    // Without this, an empty file list makes every assertion below vacuous —
    // which is the failure mode this suite is written in the style of.
    expect(files.map((f) => f.path)).toContain('models/pg/Message.ts');
    expect(files.length).toBeGreaterThan(50);
  });

  test('every INSERT carrying a reply edge derives thread_root_id in the same statement', () => {
    const offenders = [];
    for (const f of files) {
      for (const m of f.src.matchAll(/INSERT INTO messages\s*\(([^)]*)\)/gi)) {
        const cols = m[1];
        if (!/reply_to_message_id/i.test(cols)) continue; // cannot create an edge
        if (!/thread_root_id/i.test(cols)) offenders.push(`${f.path}: ${cols.replace(/\s+/g, ' ').trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('nothing UPDATEs reply_to_message_id — an edge cannot appear after the insert', () => {
    // Deliberately broad: any `SET ... reply_to_message_id` in production.
    // A narrow pattern here would be the third instance today of a check whose
    // scope was smaller than its claim.
    const offenders = files
      .filter((f) => /\bSET\b[\s\S]{0,200}?reply_to_message_id\s*=/i.test(f.src))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('CONTROL: the UPDATE detector fires on a real one', () => {
    // Proves the negative above is a measurement and not a silent no-match.
    const sample = "await pool.query('UPDATE messages SET reply_to_message_id = $1 WHERE id = $2')";
    expect(/\bSET\b[\s\S]{0,200}?reply_to_message_id\s*=/i.test(sample)).toBe(true);
  });

  test('CONTROL: the INSERT detector fires on an edge-without-root insert', () => {
    const sample = 'INSERT INTO messages (pod_id, user_id, content, reply_to_message_id)';
    const m = [...sample.matchAll(/INSERT INTO messages\s*\(([^)]*)\)/gi)];
    expect(m).toHaveLength(1);
    expect(/reply_to_message_id/i.test(m[0][1])).toBe(true);
    expect(/thread_root_id/i.test(m[0][1])).toBe(false);
  });
});
