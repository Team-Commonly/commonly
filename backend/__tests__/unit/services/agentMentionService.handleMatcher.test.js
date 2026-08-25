/**
 * @handle → Mongo matcher: escaped, not interpolated raw.
 *
 * @sprint-review's finding on #1157: `new RegExp(`^${username}$`, 'i')` was
 * injection-safe only because `extractMentions` constrains handles to
 * `[a-z0-9_-]` — and that same commit widened the character class the safety
 * rested on. The precondition lives ~850 lines from the call site that relies
 * on it.
 *
 * These cases deliberately feed metacharacters that `extractMentions` cannot
 * currently produce. That is the point: a test restricted to today's reachable
 * inputs passes identically before and after the fix, and would keep passing
 * through the widening that breaks it. The property under test is the matcher's
 * own contract, not the composition.
 */

const { handleMatcher } = require('../../../services/agentMentionService');

describe('handleMatcher escapes the handle', () => {
  it('anchors, so a prefix does not match a longer username', () => {
    expect(handleMatcher('casey').test('casey-admin')).toBe(false);
    expect(handleMatcher('casey').test('casey')).toBe(true);
  });

  it('is case-insensitive, because usernames are not normalized at write time', () => {
    expect(handleMatcher('casey_dev').test('Casey_Dev')).toBe(true);
  });

  it('treats the characters extractMentions allows today as literals', () => {
    expect(handleMatcher('a_b-c').test('a_b-c')).toBe(true);
    expect(handleMatcher('a_b-c').test('aXbYc')).toBe(false);
  });

  // The four below are unreachable through extractMentions today. Each one
  // fails against the raw-interpolation form and passes against the escaped
  // one — they are the regression guard for the next time the class widens.
  it('treats a dot as a literal, not as any-character', () => {
    expect(handleMatcher('a.c').test('abc')).toBe(false);
    expect(handleMatcher('a.c').test('a.c')).toBe(true);
  });

  it('treats an alternation as a literal', () => {
    expect(handleMatcher('a|b').test('a')).toBe(false);
    expect(handleMatcher('a|b').test('a|b')).toBe(true);
  });

  it('treats a quantifier as a literal', () => {
    expect(handleMatcher('ab+').test('abbb')).toBe(false);
    expect(handleMatcher('ab+').test('ab+')).toBe(true);
  });

  it('does not throw on an unbalanced bracket', () => {
    expect(() => handleMatcher('a[b')).not.toThrow();
    expect(handleMatcher('a[b').test('a[b')).toBe(true);
  });

  it('does not let a wildcard handle match every username', () => {
    expect(handleMatcher('.*').test('someone-else')).toBe(false);
    expect(handleMatcher('.*').test('.*')).toBe(true);
  });
});
