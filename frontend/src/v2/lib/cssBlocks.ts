/**
 * Brace-matched CSS block reads, shared by the v2 stylesheet guards.
 *
 * This lives outside `__tests__/` on purpose: jest's default `testMatch`
 * collects every `.ts` under a `__tests__` directory as a suite, and a helper
 * module with no tests in it fails the run. It is test scaffolding — no
 * production module imports it.
 *
 * A copy that stops at the next `}` reads a base rule after the block as part
 * of it, and three hand-rolled copies is how the fourth one drifts: TASK-203
 * collapsed the copies inside `v2-layout-invariants.test.ts`, and TASK-221
 * brought the last one in (it threw at module scope, so a renamed marker lost
 * its assertions from the total instead of failing them).
 */

// The block that opens at the first `{` at or after `from`, brace-matched to
// its own closing brace — or '' when nothing opens there. This is THE walk.
export const blockAt = (css: string, from: number): string => {
  const open = css.indexOf('{', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(from, i + 1); }
  }
  return '';
};

// The first block introduced by `marker` whose OWN text carries `needle`. A
// scope with a start and no end is not a scope, so both ends come from
// `blockAt` and a later block can never answer for this one. Returns '' when
// nothing matches, so a caller asserts the miss instead of throwing during
// collection.
export const blockContaining = (css: string, marker: string, needle: string): string => {
  for (let at = css.indexOf(marker); at !== -1; at = css.indexOf(marker, at + 1)) {
    const block = blockAt(css, at);
    if (block.includes(needle)) return block;
  }
  return '';
};
