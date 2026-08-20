import { colorFor, gradientFor, initialsFor } from '../utils/avatars';

/**
 * The avatar's job is to say WHO spoke, and to look deliberate while doing it.
 * These pin the properties that make it fail at that quietly.
 */
describe('avatar tints', () => {
  test('an empty seed is brand blue, never a random hue', () => {
    // The prior palette defaulted un-seeded avatars to purple, which made the
    // whole app read purple. The default is the accent on purpose.
    expect(colorFor('')).toBe('#2f6feb');
    expect(colorFor(null)).toBe('#2f6feb');
    expect(gradientFor('')).toContain('#2f6feb');
  });

  test('gradientFor emits valid two-stop CSS', () => {
    const g = gradientFor('Fable (lead)');
    expect(g).toMatch(/^linear-gradient\(\d+deg, #[0-9a-f]{6} 0%, #[0-9a-f]{6} 100%\)$/);
  });

  test('the gradient agrees with colorFor, so a solid accent never clashes', () => {
    // colorFor remains the single source of the hue for borders/keys elsewhere.
    for (const seed of ['Sprint Review', 'UX Lead', 'Nova', 'Sam']) {
      expect(gradientFor(seed)).toContain(colorFor(seed));
    }
  });

  test('the same seed always renders the same avatar', () => {
    expect(gradientFor('Pod Architect')).toBe(gradientFor('Pod Architect'));
  });

  test('no two roster members are indistinguishable (tint AND initials)', () => {
    // Tint alone collides — 8 tints cannot separate 17 names, and that is fine:
    // the avatar also renders initials, so "Sprint Review" (SR) and
    // "Sprint Impl" (SI) read as different people on the same steel blue.
    // What must never happen is a shared tint AND shared initials, which is a
    // genuine attribution failure of the kind displayName collisions caused
    // before.
    const roster = [
      'Fable (lead)', 'Sprint Review', 'Pod Architect', 'Sprint Impl', 'UX Lead',
      'Critic (Codex)', 'Strategist (Claude)', 'Commonly Support', 'Scout',
      'Nova', 'Theo', 'Pixel', 'Aria', 'Cody', 'Nia', 'newshound',
    ];
    const seen = new Map<string, string>();
    for (const name of roster) {
      const key = `${colorFor(name)}|${initialsFor(name)}`;
      expect(seen.has(key)).toBe(false);
      seen.set(key, name);
    }
  });

  test('initials take first and last word, so "Sprint Review" is SR not SP', () => {
    expect(initialsFor('Sprint Review')).toBe('SR');
    expect(initialsFor('Sprint Impl')).toBe('SI');
    expect(initialsFor('scout')).toBe('SC');
    expect(initialsFor('')).toBe('?');
  });
});
