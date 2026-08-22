/**
 * thread_root_id derivation, EXECUTED at the unit tier (W-T, TASK-029, 1/4).
 *
 * BEFORE YOU RUN THE MUTATION THIS SUITE EXISTS FOR, read this.
 *
 * `COALESCE(parent.thread_root_id, parent.id)` appears TWICE in Message.ts:
 * once inside the comment that explains the rule, once inside the SELECT that
 * implements it — the comment occurrence comes FIRST. A text-based mutation
 * without /g, or any first-match edit, rewrites the comment and leaves the
 * behaviour untouched.
 *
 * (Described by position-in-the-file rather than by line number. @sprint-review
 * (57333): citing `:110`/`:124` inside a warning about fragile text anchors is
 * the joke writing itself — those drift on the next reflow. The structure is
 * pinned executably instead, in twoOccurrencesInMessageTs below.)
 *
 * The result is not a silent no-op — it is worse. The suite passes 5/5, which
 * reads as "these tests cannot detect the thing they were built to detect",
 * and the honest-looking response is to strengthen tests that were already
 * fine. @sprint-review identified the mechanism (56937); both runs measured
 * against main afterwards:
 *
 *   first-match mutation (hits the comment) -> 5 passed  [MEANINGLESS]
 *   code-targeted mutation (hits the SQL)   -> 3 failed  [THE REAL KILL]
 *
 * Those two numbers are the DERIVATION tests alone, which is how they were
 * measured before this file grew a structural guard. Run the code mutation
 * today and the suite reports FOUR failures: the three below, plus
 * "appears exactly twice", because replacing the expression drops the count
 * to one. Expected, and stated here so the extra red is not mistaken for
 * drift by whoever next runs it.
 *
 * So the derivation IS covered — sprint-review's A/B/C case, depth 7, and
 * two-chains-in-one-pod all die when the code actually changes.
 *
 * THREE IS THE EXPECTED NUMBER, NOT PARTIAL COVERAGE. @sprint-review (56953):
 * the two survivors are the depth-1 and depth-2 cases, and under
 * `COALESCE(parent.id, parent.id)` they give the identical answer BY
 * CONSTRUCTION — a root has no parent to consult, and a direct reply's parent
 * is itself a root whose thread_root_id is NULL, so both spellings return the
 * parent's id. They cannot go red, and a test that cannot go red under a
 * mutation is not a weak test; it is a test of a different depth.
 *
 * The inversion is the useful half: **five red would be the bad result.** It
 * would mean the depth-1 and depth-2 fixtures had stopped being depth-1 and
 * depth-2 — that the suite had quietly deepened and lost its shallow cases.
 * So do not "improve" this to a full kill. The depth-2 fixture asserts its
 * own parent is a root (below) precisely so that stays true. Anchor the
 * mutation to the SQL line, then assert the file changed where you meant it
 * to, before reading the test result. A probe that cannot show it hit its
 * target is measuring nothing, and it will tell you so in the voice of a
 * passing suite.
 *
 * @sprint-review (56787): the depth claim was asserted by grepping for the
 * COALESCE substring that implements it — assertion and thing asserted are the
 * same text, so it cannot discriminate. They proposed pg-mem: insert A, B→A,
 * C→B, assert C's root is A; mutate COALESCE to `parent.id` and it must go red.
 *
 * They were right and my first answer was too broad. I had probed pg-mem,
 * found `WITH RECURSIVE` unsupported, and generalised that to "pg-mem cannot
 * run this". The write-path derivation runs fine once the scalar subquery is
 * cast (pg-mem otherwise types it as `integer[]`). The production query now
 * carries those casts, which are inert in Postgres, so what runs below is the
 * REAL string.
 *
 * OF WHAT THIS CODEBASE NEEDS, the recursive CTE is the piece pg-mem cannot
 * run. Scoped deliberately rather than "only X is unsupported" — that is a
 * claim about pg-mem, and I know of at least one more limitation without
 * having surveyed them: `WITH ... INSERT` also fails ("nested statement with
 * query type 'insert'"), found while probing workarounds. Nothing shipped uses
 * it, which is exactly why a completeness claim would have been untested.
 *
 * This is the fast tier and it runs in plain `npm test`. The tier-1 suite
 * (__tests__/service/threading.derivation.test.js) exists for the recursive
 * CTE and for running against a real server end to end.
 *
 * It is NOT needed for foreign keys or ON DELETE CASCADE, which an earlier
 * version of this comment claimed. pg-mem enforces both — see
 * threadFollowByParticipation's "the constraints are the SHIPPED ones,
 * enforced" block, which rejects a phantom root and observes a CASCADE. That
 * line would have sent a reader to the slow tier for something the fast one
 * already covers.
 */

const { newDb } = require('pg-mem');

// `mock`-prefixed so jest's hoisted factory below may reference it — the
// factory runs before ordinary module scope, and jest only exempts names it
// can see are mocks.
const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();

// The model reads its pool from here. Pointing that at pg-mem is what makes
// this exercise the shipped code path rather than a re-typed copy of its SQL.
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../models/pg/Message');

const POD = 'pod-1';
const insert = (content, replyTo = null) => PGMessage.create(POD, 'user-1', content, 'text', replyTo);

beforeAll(async () => {
  // Only the columns the derivation touches. No FKs to pods/users: those are
  // real and are covered by the tier-1 suite, and adding them here would make
  // this a slower copy of that instead of a fast complement to it.
  await mockPool.query(`CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    pod_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    content TEXT,
    message_type VARCHAR(50) DEFAULT 'text',
    payload JSONB,
    reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    thread_root_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`);
  await mockPool.query(`CREATE TABLE pods (
    id VARCHAR(255) PRIMARY KEY, updated_at TIMESTAMP WITH TIME ZONE
  )`);
  await mockPool.query("INSERT INTO pods (id) VALUES ('pod-1')");
});

describe('the two-target hazard this suite warns about is still real', () => {
  // The header tells the next person that a first-match mutation hits the
  // comment. That instruction is only useful while it is TRUE, and prose
  // cannot notice when it stops being. @sprint-review (57333) made the point
  // against line numbers; it applies to the claim itself.
  const EXPR = 'COALESCE(parent.thread_root_id, parent.id)';
  const src = require('fs')
    .readFileSync(require('path').join(__dirname, '../../../models/pg/Message.ts'), 'utf8');
  const lines = src.split('\n').filter((l) => l.includes(EXPR));
  const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);

  test('the expression appears exactly twice — one comment, one code', () => {
    // A third occurrence, or a deduped comment, changes which target a
    // first-match edit lands on. Either way the header would be giving
    // directions to somewhere that no longer exists.
    expect(lines).toHaveLength(2);
    expect(lines.filter(isComment)).toHaveLength(1);
    expect(lines.filter((l) => !isComment(l))).toHaveLength(1);
  });

  test('and the COMMENT one comes first, which is why the hazard exists', () => {
    // If the order ever flips, a first-match mutation starts hitting the real
    // SQL and the warning above becomes actively misleading rather than stale.
    expect(isComment(lines[0])).toBe(true);
  });
});

describe('the derivation runs, and depth is the thing it proves', () => {
  test('a root gets NULL, not itself', async () => {
    const root = await insert('root');
    expect(root.thread_root_id).toBeNull();
  });

  test('a direct reply inherits the root id', async () => {
    const root = await insert('root');
    const reply = await insert('reply', root.id);
    // Depth 2 ON PURPOSE, and pinned: the parent must be a ROOT. That is what
    // makes this case identical under COALESCE(parent.thread_root_id,
    // parent.id) and under COALESCE(parent.id, parent.id), and therefore what
    // makes it one of the two tests expected to SURVIVE the mutation probe.
    // Deepen this fixture and the documented 3-of-5 kill count silently
    // becomes wrong.
    expect(root.thread_root_id).toBeNull();
    expect(reply.thread_root_id).toBe(root.id);
  });

  test("sprint-review's case: A, B→A, C→B — C's root is A, not B", async () => {
    const a = await insert('A');
    const b = await insert('B', a.id);
    const c = await insert('C', b.id);
    expect(b.thread_root_id).toBe(a.id);
    expect(c.thread_root_id).toBe(a.id);
    // The discriminating half. With `parent.id` instead of COALESCE, C's root
    // would be B — which is also C's reply edge, so the two columns would
    // collapse and the whole design would be redundant.
    expect(c.thread_root_id).not.toBe(c.reply_to_message_id);
  });

  test('depth 7 — the deepest chain on live data — still resolves to one root', async () => {
    const root = await insert('depth 1');
    let prev = root;
    const chain = [];
    for (let i = 2; i <= 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      prev = await insert(`depth ${i}`, prev.id);
      chain.push(prev);
    }
    for (const row of chain) expect(row.thread_root_id).toBe(root.id);
  });

  test('two chains in one pod stay separate', async () => {
    const a = await insert('root A');
    const b = await insert('root B');
    const deepA = await insert('a2', (await insert('a1', a.id)).id);
    const deepB = await insert('b2', (await insert('b1', b.id)).id);
    expect(deepA.thread_root_id).toBe(a.id);
    expect(deepB.thread_root_id).toBe(b.id);
  });
});
