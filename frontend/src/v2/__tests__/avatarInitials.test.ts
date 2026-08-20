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
