import {
  defaultPaperAvatarPresetFor,
  nextPaperAvatarPreset,
  PAPER_AVATAR_LOOK_COUNT,
  paperAvatarPresetFor,
} from '../utils/avatarPresets';

describe('Paper avatar profile presets', () => {
  test('regenerate advances past the unpicked default and visits all 24 looks once', () => {
    const userId = 'paper-user-234';
    const initial = defaultPaperAvatarPresetFor(userId);
    let current = nextPaperAvatarPreset(userId, 'default');
    const selections = [current];

    expect(current).not.toBe(initial);
    for (let i = 1; i < PAPER_AVATAR_LOOK_COUNT; i += 1) {
      current = nextPaperAvatarPreset(userId, current);
      selections.push(current);
    }

    expect(new Set(selections).size).toBe(PAPER_AVATAR_LOOK_COUNT);
    expect(nextPaperAvatarPreset(userId, current)).toBe(selections[0]);
  });

  test('regenerate advances from a stored Paper cell and wraps after the last look', () => {
    expect(nextPaperAvatarPreset('paper-user-234', paperAvatarPresetFor('paper-user-234', 23)))
      .toBe(paperAvatarPresetFor('paper-user-234', 0));
  });

  test('photos and older Cut picks are replaced by a Paper seed', () => {
    expect(nextPaperAvatarPreset('paper-user-234', '/api/uploads/avatar.png'))
      .toMatch(/^paper:paper-user-234-v(?:[0-9]|1[0-9]|2[0-3])$/);
    expect(nextPaperAvatarPreset('paper-user-234', 'bigsmile:paper-user-234-v7'))
      .toMatch(/^paper:paper-user-234-v(?:[0-9]|1[0-9]|2[0-3])$/);
  });

  test('preset helper rejects indices outside the exact 0-based range', () => {
    expect(() => paperAvatarPresetFor('paper-user-234', -1)).toThrow();
    expect(() => paperAvatarPresetFor('paper-user-234', 24)).toThrow();
    expect(() => paperAvatarPresetFor('paper-user-234', 1.5)).toThrow();
  });

  test.each(['v01', 'v0x1', 'v24'])('treats a non-canonical stored marker %s as the current default', (suffix) => {
    const userId = 'paper-user-234';
    const initial = defaultPaperAvatarPresetFor(userId);
    const defaultIndex = Number(initial.slice(initial.lastIndexOf('-v') + 2));
    const nextIndex = (defaultIndex + 1) % PAPER_AVATAR_LOOK_COUNT;

    expect(nextPaperAvatarPreset(userId, `paper:${userId}-${suffix}`))
      .toBe(paperAvatarPresetFor(userId, nextIndex));
  });
});
