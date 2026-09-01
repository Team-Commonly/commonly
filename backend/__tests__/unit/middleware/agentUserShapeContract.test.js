/**
 * `req.agentUser` must carry the whole User row, not a projection.
 *
 * THIS IS A SOURCE ASSERTION ON PURPOSE — reviewer-checklist rule 18. The
 * property is structural, not behavioural: the claim is "no path projects
 * these queries", and absence of code cannot be demonstrated by execution.
 * A behavioural test cannot catch the regression either, because every suite
 * that touches an agent-authenticated route constructs its own `req.agentUser`
 * (or mocks `agentRuntimeAuth` to a bare `next()`), so a `.select()` added to
 * the real middleware would empty `username` in production with the whole
 * suite still green. That is the exact failure #1127 fixed — see rule 17.
 *
 * @sprint-review (57620) raised the gap: `agentRuntimeAuth.ts` documents the
 * downstream contract as `req.agentUser?._id` only, while #1127 shipped a
 * consumer reading `username`. Nothing enforced the widened contract.
 *
 * Positive control included, per rule 18's second rider: a grep that matches
 * nothing because the pattern is wrong is indistinguishable from one that
 * matches nothing because the code is gone.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../../middleware/agentRuntimeAuth.ts');
const source = fs.readFileSync(SRC, 'utf8');

// Comments are stripped before counting, because this file TALKS about
// `.select()` in prose and would otherwise count its own documentation.
// Deliberately crude — it is not a parser, and the assertions below are
// designed so that it does not need to be one.
const codeOnly = () => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1');

const selectCallCount = () => (codeOnly().match(/\.select\s*\(/g) || []).length;

/** Statement starting at `User.findOne(`, up to the terminating semicolon. */
const userFindOneStatements = () => {
  const out = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('User.findOne(', from);
    if (start === -1) return out;
    const end = source.indexOf(';', start);
    out.push(source.slice(start, end === -1 ? source.length : end));
    from = start + 1;
  }
};

describe('the middleware reads the full User row', () => {
  it('finds both User.findOne call sites', () => {
    // Binds the rest of the suite to a known population. If this number
    // changes, the new call site needs the same check, not a bumped constant.
    expect(userFindOneStatements()).toHaveLength(2);
  });

  it('the file contains exactly the two reviewed projections', () => {
    // THE LOAD-BEARING ASSERTION, and it fails CLOSED. @sprint-review found
    // the statement-scoping below fails OPEN on the most likely edit: it ends
    // a statement at the first `;` after `User.findOne(`, which is not the end
    // of the statement whenever a semicolon appears inside it. The comment a
    // developer writes when adding a projection is exactly that case —
    //
    //   const botUser = await User.findOne({
    //     // legacy path; only the id is needed here
    //     ...
    //   }).select('_id');
    //
    // — and the pre-fix suite returned 7/7 green against it. Reproduced here
    // before this rewrite. A semicolon inside a string value does the same.
    // The guard was strongest against a bare projection and weakest against a
    // projection someone bothered to explain, inverting the risk ordering.
    //
    // So do not ask "does this statement project?", which needs a parser this
    // is not. Enumerate the permitted projections instead: ANY new `.select(`
    // anywhere in the file trips this, and the author re-certifies it
    // consciously. A guard that must parse correctly to fail is not a guard.
    //
    // The AgentCredential parent lookup is intentionally narrow: revocation
    // only needs its status. It is not a User lookup and must stay distinct
    // from the full-row invariant below.
    expect(selectCallCount()).toBe(2);
    expect(codeOnly()).toMatch(/Pod\.find\([\s\S]{0,200}?\.select\('_id'\)/);
    expect(codeOnly()).toMatch(/AgentCredential\.findById\([\s\S]{0,200}?\.select\('status'\)/);
  });

  it('projects neither User.findOne', () => {
    // Kept as the specific statement of the property, but it is no longer
    // what defends it. Asserts its own population: iterating an empty array
    // passes, so without this line the test is vacuous whenever the extractor
    // finds nothing — and it used to borrow its non-vacuity from a DIFFERENT
    // test, so weakening that one silently gutted this one.
    const statements = userFindOneStatements();
    expect(statements).toHaveLength(2);
    for (const stmt of statements) {
      expect(stmt).not.toMatch(/\.select\s*\(/);
    }
  });

  it('control: the probe DOES detect a projection when one is present', () => {
    // Without this, a `.select(` regex that silently stopped matching would
    // read exactly like a middleware that never projects.
    const rigged = 'const x = await User.findOne({ a: 1 }).select(\'_id\').lean();';
    const stmt = rigged.slice(rigged.indexOf('User.findOne('), rigged.indexOf(';'));
    expect(stmt).toMatch(/\.select\s*\(/);
  });

  it('control: the projection count DOES move when a projection is added', () => {
    // Same rider as the probe control below, applied to the counter: a
    // `selectCallCount` that silently stopped matching would read exactly
    // like a middleware that projects once. Also pins the comment-stripper,
    // which is the one part that could quietly zero the count — this file's
    // own prose mentions `.select()` three times and must not be counted.
    const rigged = `${codeOnly()}\nawait User.findOne({ a: 1 }).select('_id');`;
    expect((rigged.match(/\.select\s*\(/g) || []).length).toBe(selectCallCount() + 1);
    expect(codeOnly()).not.toMatch(/Adding a `\.select\(\)`/);
  });

  it('control: the interleaved Pod.find projection is NOT attributed to a User query', () => {
    // The near-miss this file exists to prevent. `.select('_id')` at :98
    // belongs to the DM-pod `Pod.find`, thirty-seven lines above the second
    // `User.findOne`. If the statement-scoping above regressed to a
    // proximity grep, this assertion is what would catch it.
    expect(source).toMatch(/Pod\.find\([\s\S]{0,200}?\.select\('_id'\)/);
    expect(userFindOneStatements().join('\n')).not.toMatch(/Pod\.find/);
  });
});

describe('the fields a future .select() author would be dropping', () => {
  // Not a behavioural assertion — a named inventory, so the reason this file
  // exists is legible without a git blame. Each entry is grepped for the
  // actual `agentUser` access in the file that depends on it, so the list
  // cannot rot into decoration or pass on an unrelated mention of the word.
  const consumers = [
    ['username', 'routes/tasksApi.ts', /req\.agentUser\?\.username/],
    ['username', 'routes/agentsRuntime.ts', /agentUser\?\.username/],
    ['botMetadata', 'routes/agentsRuntime.ts', /agentUser\?\.botMetadata/],
  ];
  it.each(consumers)('%s is read off req.agentUser in %s', (field, rel, pattern) => {
    const file = path.join(__dirname, '../../../', rel);
    expect(fs.readFileSync(file, 'utf8')).toMatch(pattern);
  });
});
