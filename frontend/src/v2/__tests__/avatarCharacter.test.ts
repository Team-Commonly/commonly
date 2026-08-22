import { characterAvatarFor, PICKER_ARCHETYPES, PICKER_CELL_COUNT } from '../utils/avatars';

/**
 * The character tier: bigSmile faces for BOTH species (Sam's 2026-08-21
 * revision — the robots were rejected on looks), with species carried by
 * disjoint background families instead of art style. Everything here defends
 * the properties that make it shippable at all — determinism, distinctness,
 * species legibility, and a fallback that cannot strand a render.
 */
describe('characterAvatarFor', () => {
  test('is deterministic — same identity, same face, forever', () => {
    expect(characterAvatarFor('scout:default', 'agent'))
      .toBe(characterAvatarFor('scout:default', 'agent'));
    expect(characterAvatarFor('user-123', 'human'))
      .toBe(characterAvatarFor('user-123', 'human'));
  });

  test('same seed still renders differently across kinds', () => {
    // The species signal moved from art style to background family, but the
    // rule is unchanged: a human and an agent must never be confusable by
    // avatar even if their seeds collide. Disjoint palettes guarantee it.
    const agent = characterAvatarFor('same-seed', 'agent');
    const human = characterAvatarFor('same-seed', 'human');
    expect(agent).not.toBeNull();
    expect(human).not.toBeNull();
    expect(agent).not.toBe(human);
  });

  test('distinct agents get distinct characters across the real roster', () => {
    const roster = [
      'fable-lead:default', 'sprint-review:default', 'pod-architect:default',
      'sprint-impl:default', 'ux-lead:default', 'scout:default',
      'scout:u0da521ab41', 'scout:ucc4035c51b',
    ];
    const seen = new Set(roster.map((s) => characterAvatarFor(s, 'agent')));
    expect(seen.size).toBe(roster.length);
  });

  test('an empty seed yields null so the caller falls back to initials', () => {
    expect(characterAvatarFor('', 'agent')).toBeNull();
    expect(characterAvatarFor(null, 'human')).toBeNull();
    expect(characterAvatarFor(undefined, 'agent')).toBeNull();
  });

  test('output is a self-contained data URI, never a network fetch', () => {
    // The whole point over generated art: local, deterministic, CSP-safe.
    const uri = characterAvatarFor('scout:default', 'agent');
    expect(uri).toMatch(/^data:image\/svg\+xml/);
  });

  test('every archetype cell renders its own skin tone, every user', () => {
    // Sam's rule (2026-08-21): explicit representation, not a rolled
    // gradient. Each of the 24 cells is a curated combination; the cell's
    // tone must appear in the RENDERED SVG itself, so a dicebear enum rename
    // fails loudly instead of silently rolling random faces again.
    expect(PICKER_ARCHETYPES).toHaveLength(24);
    for (const base of ['sam', 'someone-else']) {
      PICKER_ARCHETYPES.forEach((cell, i) => {
        const uri = characterAvatarFor(`${base}-v${i + 1}`, 'human');
        expect(uri).not.toBeNull();
        const svg = decodeURIComponent(String(uri));
        expect(cell.skin.some((tone) => svg.includes(tone))).toBe(true);
      });
    }
  });

  test('the archetype table stays representation-complete', () => {
    // The four ethnic rows and both gender presentations must survive edits:
    // all 8 bigSmile skin tones appear somewhere, and both accessory shapes
    // (mustache-bearing male-leaning, mustache-free female-leaning) exist.
    expect(PICKER_CELL_COUNT).toBe(PICKER_ARCHETYPES.length);
    const tones = new Set(PICKER_ARCHETYPES.flatMap((c) => c.skin));
    for (const tone of ['ffe4c0', 'f5d7b1', 'efcc9f', 'e2ba87', 'c99c62', 'a47539', '8c5a2b', '643d19']) {
      expect(tones.has(tone)).toBe(true);
    }
    expect(PICKER_ARCHETYPES.some((c) => c.acc.includes('mustache'))).toBe(true);
    expect(PICKER_ARCHETYPES.some((c) => !c.acc.includes('mustache'))).toBe(true);
  });

  test('non-picker seeds (identity defaults) still render without pinned traits', () => {
    // The -v suffix is the picker contract; a bare identity seed must not
    // accidentally match it.
    expect(characterAvatarFor('fable-lead:default', 'agent')).not.toBeNull();
    expect(characterAvatarFor('user-v9000', 'human')).not.toBeNull();
  });
});
