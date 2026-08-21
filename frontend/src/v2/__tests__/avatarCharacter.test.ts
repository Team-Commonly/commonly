import { characterAvatarFor, PICKER_SKIN_TONES } from '../utils/avatars';

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

  test('the 8 picker cells span the full skin-tone range, every grid, every user', () => {
    // Sam's rule (2026-08-21): the grid is deliberately diverse, not rolled —
    // 8 random rolls can hand a user 8 similar faces and nothing that looks
    // like them. Cell i pins tone i, so every user's grid covers lightest to
    // deepest. The tone must appear in the rendered SVG itself; if dicebear
    // ever renames its skinColor enum this fails loudly instead of silently
    // rolling random tones again.
    for (const base of ['sam', 'someone-else']) {
      PICKER_SKIN_TONES.forEach((tone, i) => {
        const uri = characterAvatarFor(`${base}-v${i + 1}`, 'human');
        expect(uri).not.toBeNull();
        expect(decodeURIComponent(String(uri))).toContain(tone);
      });
    }
  });

  test('non-picker seeds (identity defaults) still render without pinned traits', () => {
    // The -v suffix is the picker contract; a bare identity seed must not
    // accidentally match it.
    expect(characterAvatarFor('fable-lead:default', 'agent')).not.toBeNull();
    expect(characterAvatarFor('user-v9000', 'human')).not.toBeNull();
  });
});
