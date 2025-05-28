import { getAvatarColor } from './avatarUtils';

describe('getAvatarColor', () => {
  test('returns specific color for known id', () => {
    expect(getAvatarColor('red')).toBe('#e53935');
  });

  test('falls back to default color for unknown id', () => {
    expect(getAvatarColor('unknown')).toBe('primary.main');
  });
});
