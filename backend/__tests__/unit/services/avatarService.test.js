const mockFind = jest.fn();

jest.mock('../../../models/User', () => ({
  find: mockFind,
}));

const {
  normalizeAvatarUrl,
  resolveAvatarUrl,
  resolveAvatarUrls,
} = require('../../../services/avatarService');

describe('avatarService', () => {
  beforeEach(() => {
    mockFind.mockReset();
  });

  test.each([
    ['https://api-dev.commonly.me/api/uploads/dev-avatar.png', '/api/uploads/dev-avatar.png'],
    ['https://api.commonly.me/api/uploads/live-avatar.png?old=1', '/api/uploads/live-avatar.png'],
    ['http://localhost:5000/api/uploads/local-avatar.png', '/api/uploads/local-avatar.png'],
    ['/api/uploads/already-relative.png', '/api/uploads/already-relative.png'],
    ['avatar.png', '/api/uploads/avatar.png'],
    ['blue', 'blue'],
    ['legacy-avatar-id', 'legacy-avatar-id'],
    ['data:image/png;base64,abc123', 'data:image/png;base64,abc123'],
    ['  ', null],
    [null, null],
    ['default', null],
  ])('normalizes %p to %p', (raw, expected) => {
    expect(normalizeAvatarUrl(raw)).toBe(expected);
  });

  it('preserves external absolute URLs that have no local upload key', () => {
    expect(normalizeAvatarUrl('https://cdn.example.com/avatars/a.png'))
      .toBe('https://cdn.example.com/avatars/a.png');
  });

  it('resolves one user without inventing a default avatar', () => {
    expect(resolveAvatarUrl({ profilePicture: 'default' })).toBeNull();
    expect(resolveAvatarUrl({ profilePicture: 'blue' })).toBeNull();
    expect(resolveAvatarUrl(undefined)).toBeNull();
  });

  it('batch-resolves users in one query and includes missing ids as null', async () => {
    const lean = jest.fn().mockResolvedValue([
      {
        _id: { toString: () => 'user-1' },
        profilePicture: 'https://api-dev.commonly.me/api/uploads/avatar-1.png',
      },
    ]);
    const select = jest.fn().mockReturnValue({ lean });
    mockFind.mockReturnValue({ select });

    const result = await resolveAvatarUrls(['user-1', 'missing-user']);

    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(mockFind).toHaveBeenCalledWith({
      _id: { $in: ['user-1', 'missing-user'] },
    });
    expect(select).toHaveBeenCalledWith('_id profilePicture');
    expect(result).toEqual(new Map([
      ['user-1', '/api/uploads/avatar-1.png'],
      ['missing-user', null],
    ]));
  });
});
