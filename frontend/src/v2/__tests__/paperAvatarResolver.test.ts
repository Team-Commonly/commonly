import { getAvatarSrc } from '../../utils/avatarUtils';
import { PAPER_AVATAR_LOOK_COUNT, paperAvatarFor } from '../utils/avatars';
import {
  defaultPaperAvatarPresetFor,
  paperAvatarPresetFor,
} from '../utils/avatarPresets';

describe('stored Paper avatar resolver', () => {
  test('resolves every exact 0-based marker to its corresponding Paper look', () => {
    const userId = 'paper-user-234';
    const resolved = Array.from({ length: PAPER_AVATAR_LOOK_COUNT }, (_, lookIndex) => {
      const marker = paperAvatarPresetFor(userId, lookIndex);
      return getAvatarSrc(marker);
    });

    expect(resolved.every((src) => typeof src === 'string' && src.startsWith('data:image/svg+xml;utf8,')))
      .toBe(true);
    expect(resolved).toEqual(
      Array.from({ length: PAPER_AVATAR_LOOK_COUNT }, (_, lookIndex) => paperAvatarFor(userId, lookIndex)),
    );
    expect(new Set(resolved).size).toBe(PAPER_AVATAR_LOOK_COUNT);
  });

  test('the saved default marker renders the same look as the unpicked fallback', () => {
    const userId = 'paper-user-234';
    expect(getAvatarSrc(defaultPaperAvatarPresetFor(userId))).toBe(paperAvatarFor(userId));
  });

  test.each([-1, PAPER_AVATAR_LOOK_COUNT, 1.5])(
    'rejects Paper look indices outside the exact 0-based range: %s',
    (lookIndex) => {
      expect(paperAvatarFor('paper-user-234', lookIndex)).toBeNull();
    },
  );

  test.each([
    'paper:user-v24',
    'paper:user-v01',
    'paper:user-v0x1',
    'paper:user-v-1',
    'paper:user-v',
    'paper:-v0',
  ])('rejects malformed or out-of-range marker %s', (marker) => {
    expect(getAvatarSrc(marker)).toBeNull();
  });
});
