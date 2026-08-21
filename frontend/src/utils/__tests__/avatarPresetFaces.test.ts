import {
  FACE_PRESET_PREFIX, getAvatarSrc, isFacePresetId, presetFaceOptions, avatarOptions,
} from '../avatarUtils';

/**
 * The picked-face scheme (Sam, 2026-08-20): users select from generated
 * presets, stored as 'bigsmile:<seed>' and regenerated locally everywhere.
 * These pin the properties that make a picker trustworthy.
 */
describe('preset face avatars', () => {
  test('the grid is personal and never reshuffles between visits', () => {
    // A picker whose options change reads as broken — and "the face I picked
    // last month" must still be in the grid when the user returns.
    const a = presetFaceOptions('sam');
    const b = presetFaceOptions('sam');
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    expect(a.map((f) => f.src)).toEqual(b.map((f) => f.src));
    expect(a).toHaveLength(8);
  });

  test('different users see different grids', () => {
    const sam = presetFaceOptions('sam').map((f) => f.src);
    const lily = presetFaceOptions('lily').map((f) => f.src);
    expect(sam).not.toEqual(lily);
  });

  test('a stored pick round-trips through getAvatarSrc to the exact same face', () => {
    const picked = presetFaceOptions('sam')[2];
    // What the profile stores is the id; what every renderer shows must be the
    // identical face the user chose in the picker.
    expect(getAvatarSrc(picked.id)).toBe(picked.src);
    expect(getAvatarSrc(picked.id)).toMatch(/^data:image\/svg\+xml/);
  });

  test('the scheme cannot collide with legacy color ids or real URLs', () => {
    expect(isFacePresetId(`${FACE_PRESET_PREFIX}x`)).toBe(true);
    expect(isFacePresetId('default')).toBe(false);
    expect(isFacePresetId('https://example.com/a.png')).toBe(false);
    // Legacy color ids still resolve to null (initials/tint path) — existing
    // users' stored values keep rendering even though the picker no longer
    // offers colors.
    for (const opt of avatarOptions) {
      expect(getAvatarSrc(opt.id)).toBeNull();
    }
  });
});
