import { characterAvatarFor } from '../utils/avatars';

/**
 * The character tier: humans render bigSmile faces, agents render bottts
 * robots (Sam's ruling, 2026-08-20). Everything here defends the properties
 * that make it shippable at all — determinism, distinctness, and a fallback
 * that cannot strand a render.
 */
describe('characterAvatarFor', () => {
  test('is deterministic — same identity, same face, forever', () => {
    expect(characterAvatarFor('scout:default', 'agent'))
      .toBe(characterAvatarFor('scout:default', 'agent'));
    expect(characterAvatarFor('user-123', 'human'))
      .toBe(characterAvatarFor('user-123', 'human'));
  });

  test('kinds render different species from the same seed', () => {
    // A human and an agent must never be confusable by avatar even if their
    // seeds collide — the species IS the badge.
    const robot = characterAvatarFor('same-seed', 'agent');
    const face = characterAvatarFor('same-seed', 'human');
    expect(robot).not.toBeNull();
    expect(face).not.toBeNull();
    expect(robot).not.toBe(face);
  });

  test('distinct agents get distinct robots across the real roster', () => {
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
});
