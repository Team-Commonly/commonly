import {
  POD_VISITS_KEY, podInitials, readPodVisits, recordPodVisit, relativeTime,
} from '../lib/podRecency';

describe('podRecency', () => {
  beforeEach(() => localStorage.clear());

  test('relativeTime is one number and one unit, never a date', () => {
    const now = Date.parse('2026-09-06T12:00:00.000Z');
    expect(relativeTime('2026-09-06T11:59:40.000Z', now)).toBe('now');
    expect(relativeTime('2026-09-06T11:51:00.000Z', now)).toBe('9m');
    expect(relativeTime('2026-09-06T09:00:00.000Z', now)).toBe('3h');
    expect(relativeTime('2026-09-04T12:00:00.000Z', now)).toBe('2d');
    expect(relativeTime('2026-08-20T12:00:00.000Z', now)).toBe('2w');
    expect(relativeTime('2026-07-07T12:00:00.000Z', now)).toBe('2mo');
    expect(relativeTime('2024-09-06T12:00:00.000Z', now)).toBe('2y');
    expect(relativeTime(null, now)).toBe('');
    expect(relativeTime('not a date', now)).toBe('');
  });

  test('a future timestamp reads as now, not as a negative age', () => {
    const now = Date.parse('2026-09-06T12:00:00.000Z');
    expect(relativeTime('2026-09-06T12:05:00.000Z', now)).toBe('now');
  });

  test('the visit log survives a round trip and ignores garbage', () => {
    expect(readPodVisits()).toEqual({});
    recordPodVisit('a', 10);
    recordPodVisit('b', 20);
    expect(readPodVisits()).toEqual({ a: 10, b: 20 });
    localStorage.setItem(POD_VISITS_KEY, '{"a": "ten", "c": 30, "d": null}');
    expect(readPodVisits()).toEqual({ c: 30 });
    localStorage.setItem(POD_VISITS_KEY, 'not json');
    expect(readPodVisits()).toEqual({});
  });

  test('podInitials takes two words, or two letters of one', () => {
    expect(podInitials('Connectors v2')).toBe('CV');
    expect(podInitials('Sharpen')).toBe('SH');
    expect(podInitials('')).toBe('·');
  });

  test('podInitials separates on punctuation and dashes instead of taking them as initials', () => {
    expect(podInitials('  Payments — memory demo ')).toBe('PM');
    expect(podInitials('Sharpen — pod model')).toBe('SP');
    expect(podInitials('Team-Commonly')).toBe('TC');
    expect(podInitials('—')).toBe('·');
  });

  test('podInitials shows one glyph when a CJK glyph is picked', () => {
    expect(podInitials('设计评审')).toBe('设');
    expect(podInitials('Growth 团队')).toBe('G');
    // Stated scope rather than an oversight: the predicate is a script list and
    // JS \p{…} cannot express East_Asian_Width, so fullwidth Latin shows two.
    expect(podInitials('ＡＢＣ')).toBe('ＡＢ');
  });

  test('podInitials drops an emoji the way it drops punctuation', () => {
    expect(podInitials('🚀 Launch')).toBe('LA');
  });

  test('podInitials slices by code point, so a surrogate pair is never cut in half', () => {
    // Synthetic on purpose: a two-unit slice of 'A𝔘' ends between the halves of
    // 𝔘 and returns a replacement character, which no real pod name would show.
    expect(podInitials('A𝔘')).toBe('A𝔘');
  });

  test('podInitials reads the first code point of each of two words', () => {
    // Pins the two-word branch's own code-point read. 'A𝔘' above is a single
    // token, so it only exercises the one-word slice; a UTF-16 read here would
    // cut 𐐀 in half and return a replacement character.
    expect(podInitials('𐐀lpha Beta')).toBe('𐐀B');
  });
});
