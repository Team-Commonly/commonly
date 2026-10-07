import { getAvatarSrc } from '../../utils/avatarUtils';
import { paperAvatarFor } from '../utils/avatars';
import {
  defaultPaperAvatarPresetFor,
  PAPER_AVATAR_LOOK_COUNT,
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
