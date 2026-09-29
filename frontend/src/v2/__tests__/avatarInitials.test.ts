import { initialsFor } from '../utils/avatars';

/**
 * Initials are the identity on every avatar without an uploaded photo, which is
 * nearly all of them. Getting them wrong is not a cosmetic issue — it mislabels
 * who spoke.
 */
describe('initialsFor', () => {
  test('a parenthetical qualifier never becomes an initial', () => {
    // Shipped state: Your Team rendered "F(", "C(", "S(" and "C(" — the bracket
    // was being taken as the second word.
    expect(initialsFor('Fable (lead)')).toBe('FA');
    expect(initialsFor('Critic (Codex)')).toBe('CR');
    expect(initialsFor('Strategist (Claude)')).toBe('ST');
    expect(initialsFor('Codex (impl)')).toBe('CO');
  });

  test('two agents whose bracketed suffix differs are not labelled the same', () => {
    // The real defect behind the cosmetic one: "Critic (Codex)" and
    // "Codex (impl)" both rendered "C(", so two different agents carried an
    // identical avatar label. Same failure family as the displayName
    // collisions that needed a dedup migration.
    expect(initialsFor('Critic (Codex)')).not.toBe(initialsFor('Codex (impl)'));
  });

  test('ordinary two-word names are unchanged', () => {
    expect(initialsFor('Sprint Review')).toBe('SR');
    expect(initialsFor('Sprint Impl')).toBe('SI');
    expect(initialsFor('UX Lead')).toBe('UL');
    expect(initialsFor('Pod Architect')).toBe('PA');
  });

  test('single words take two letters', () => {
    expect(initialsFor('scout')).toBe('SC');
    expect(initialsFor('Nova')).toBe('NO');
  });

  test('a CJK display name keeps its characters instead of collapsing to "?"', () => {
    // The punctuation strip is Unicode-aware for this reason; a naive [^A-Za-z]
    // filter would empty the token and fall through to the "?" placeholder.
    expect(initialsFor('奶龙')).toBe('奶龙');
  });

  test('an astral character is taken whole, never cut in half', () => {
    // A JS string indexes UTF-16 units, so a name starting with an astral
    // character used to yield the high surrogate ALONE — "\ud801", which is not
    // a character and renders as a replacement box or nothing at all. Deseret
    // capital 𐐀 is U+10400, two units.
    expect(initialsFor('𐐀lpha Beta')).toBe('𐐀B');
    expect(initialsFor('Deseret 𐐀team')).toBe('D𐐀');
    // The one-word branch cuts after TWO characters, so here the second code
    // point is the one at risk: 'A𝔘' is three units, and slice(0, 2) was "A"
    // plus half of 𝔘.
    expect(initialsFor('A𝔘')).toBe('A𝔘');
  });

  test('no result is ever a lone surrogate', () => {
    // The class, not the three instances above: a lone surrogate is a single
    // UTF-16 unit inside the surrogate range, whereas a whole astral character
    // iterates as a two-unit string. Names with no letters at all reach the
    // fallback branch, so an emoji-only name is the input that pins THAT read.
    //
    // '—😀' is the shape that makes the fallback read visible to THIS assertion
    // rather than only to its own test, and it is the only shape that does both
    // of the two things the fallback needs. Reaching the fallback takes a name
    // with no letter or digit token at all; splitting a pair there takes the
    // second code point to sit across the cut. '😀😀' does the first and not the
    // second, so with its read reverted it comes back as '😀' — a truncation, and
    // zero lone surrogates, which is a green class assertion over a regression.
    // Measured: fixed gives '—😀', reverted gives '—' + '\ud83d'.
    const loneSurrogates = (s: string) =>
      Array.from(s).filter((ch) => ch.length === 1 && ch >= '\uD800' && ch <= '\uDFFF');
    const names = [
      '𐐀lpha Beta', 'Deseret 𐐀team', 'A𝔘', '𝔘', '😀😀', '😀 Launch', '—😀',
      '奶龙', 'Sprint Review', 'Fable (lead)', '(lead)', '—', '', 'A—𝔘',
    ];
    for (const name of names) {
      expect({ name, lone: loneSurrogates(initialsFor(name)) }).toEqual({ name, lone: [] });
    }
  });

  test('a name with nothing strippable left still reads two whole characters', () => {
    // The third UTF-16 read was the fallback: a slice(0, 2) of the raw string.
    // An emoji-only name has no letter or digit token, so it lands here, and
    // the slice used to take one emoji where two were meant.
    expect(initialsFor('😀😀')).toBe('😀😀');
    expect(initialsFor('😀')).toBe('😀');
  });

  test('empty and punctuation-only names fall back rather than throwing', () => {
    expect(initialsFor('')).toBe('?');
    expect(initialsFor(null)).toBe('?');
    expect(initialsFor(undefined)).toBe('?');
    // A name that is ONLY a parenthetical falls back to the raw string, which
    // then has its punctuation stripped — so "LE", never "(L".
    expect(initialsFor('(lead)')).toBe('LE');
  });

  test('the whole roster stays distinct', () => {
    const roster = [
      'Fable (lead)', 'Critic (Codex)', 'Strategist (Claude)', 'Codex (impl)',
      'Sprint Review', 'Sprint Impl', 'UX Lead', 'Pod Architect',
      'Commonly Bot', 'Commonly Support', 'scout', 'Nova', 'Theo', 'Pixel',
    ];
    const seen = new Set(roster.map(initialsFor));
    expect(seen.size).toBe(roster.length);
  });
});
