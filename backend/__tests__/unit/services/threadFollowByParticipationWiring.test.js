/**
 * Keep the comment and the code-base agreeing about followByParticipation.
 *
 * @sprint-review's third blocker on 3/4 (57306) caught a doc-vs-reality gap:
 * threadWakeScopeService said a mention wrote the row, while nothing called
 * this method. The implementation is intentionally at agentMentionService's
 * successful-delivery choke point, not at one of its four resolution branches.
 *
 * This exists so the comment cannot drift from that call graph in either
 * direction. Behaviour is asserted at the delivery consumer in
 * agentMentionService.threadScoping.test.js; this test protects the human
 * contract and its one designated production writer.
 */

const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '../../..');
const SCOPE_SERVICE = path.join(BACKEND, 'services/threadWakeScopeService.ts');

/** Production source only: no tests, no node_modules, and not the model that defines it. */
const productionCallers = () => {
  const hits = [];
  const skipDir = new Set(['node_modules', '__tests__', 'dist', 'coverage', '.git']);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDir.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(ts|js)$/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      // The model DEFINES it; the scope service only mentions it in prose.
      if (full.endsWith('models/pg/ThreadUserState.ts')) continue;
      if (full === SCOPE_SERVICE) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (src.includes('followByParticipation')) hits.push(path.relative(BACKEND, full));
    }
  };
  walk(BACKEND);
  return hits;
};

/**
 * The two states the header is allowed to be in, matched against FLATTENED
 * source, per @sprint-review (57311): the unwired marker currently ends a
 * line, so one reflow would split it across a newline and turn a true claim
 * false. That is the matcher-spanning-a-line-break trap from earlier today.
 *
 * Collapsing `\s+` alone is NOT enough and the first attempt here did exactly
 * that — a reflow inside a block comment leaves the ` * ` gutter sitting in
 * the middle of the phrase, so `NOTHING\n * CALLS IT` flattens to
 * `NOTHING * CALLS IT` and still misses. The probe caught it: the scenario
 * this normalisation existed for was the one scenario still failing. Strip
 * the gutter first, then collapse.
 */
const flatten = (src) => src.replace(/^[ \t]*\*[ \t]?/gm, ' ').replace(/\s+/g, ' ');

const UNWIRED = 'NOTHING CALLS IT';
const WIRED = 'THE MENTION PATH CALLS IT';

describe('followByParticipation: the comment and the call graph agree', () => {
  const header = flatten(fs.readFileSync(SCOPE_SERVICE, 'utf8'));
  const claimsUnwired = header.includes(UNWIRED);
  const claimsWired = header.includes(WIRED);

  test('the header makes exactly one of the two checkable claims', () => {
    // NOT "the unwired marker must be present" — that was the first version,
    // and @sprint-review caught that it made the wired branch below
    // unreachable, so the guard only ever ran in one direction while I
    // described it as running in two.
    //
    // Requiring exactly one marker is what makes both branches live: whoever
    // closes TASK-045 swaps UNWIRED for WIRED, and the second branch then
    // runs for real. Softening to unstructured prose ("may not be wired")
    // matches neither and fails here, so vagueness is not a pass.
    expect([claimsUnwired, claimsWired].filter(Boolean)).toHaveLength(1);
  });

  test('and the call graph matches whichever claim it makes', () => {
    const callers = productionCallers();
    if (claimsUnwired) {
      expect(callers).toEqual([]);
    } else {
      // A non-empty list would let a second, unreviewed writer appear. The
      // mention-delivery choke point is deliberately the only caller.
      expect(callers).toEqual(['services/agentMentionService.ts']);
    }
  });
});
