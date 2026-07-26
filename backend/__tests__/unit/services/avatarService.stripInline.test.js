/**
 * #758 — no inline base64 avatars in agent-bound payloads.
 *
 * Avatars are stored as `data:` URIs on the user row, so every message carries
 * its author's full image bytes and the same avatar repeats on every message
 * that author sent. Measured on a real pod, a 20-message agent read returned
 * 230,170 characters of which 71% was image data — an agent asked to read a
 * busy room exhausts its context on profile pictures before reaching the
 * conversation.
 *
 * The rule is "no base64 in an agent payload", NOT "no avatars": a URL costs
 * nothing and stays useful, so it survives.
 */

const { stripInlineAvatars } = require('../../../services/avatarService');

const DATA_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD';

describe('stripInlineAvatars', () => {
  test('drops a data: avatar under either spelling', () => {
    const out = stripInlineAvatars({
      userId: { _id: 'u1', username: 'sam', profilePicture: DATA_URI },
      profile_picture: DATA_URI,
      content: 'hello',
    });

    expect(out.userId).not.toHaveProperty('profilePicture');
    expect(out).not.toHaveProperty('profile_picture');
    expect(out.content).toBe('hello');
    expect(out.userId.username).toBe('sam');
  });

  test('keeps a URL avatar — the rule is no base64, not no avatars', () => {
    const out = stripInlineAvatars({
      userId: { profilePicture: '/api/uploads/abc.png' },
      profile_picture: 'https://example.com/a.png',
    });

    expect(out.userId.profilePicture).toBe('/api/uploads/abc.png');
    expect(out.profile_picture).toBe('https://example.com/a.png');
  });

  test('reaches into arrays and nested members (the create-pod member list)', () => {
    const out = stripInlineAvatars({
      pod: {
        createdBy: { username: 'sam', profilePicture: DATA_URI },
        members: [
          { user: { username: 'a', profilePicture: DATA_URI } },
          { user: { username: 'b', profilePicture: '/api/uploads/b.png' } },
        ],
      },
    });

    expect(JSON.stringify(out)).not.toContain('data:');
    expect(out.pod.members[1].user.profilePicture).toBe('/api/uploads/b.png');
    expect(out.pod.members.map((m) => m.user.username)).toEqual(['a', 'b']);
  });

  test('does NOT mutate the input — the same object feeds the human socket broadcast', () => {
    const original = { userId: { profilePicture: DATA_URI }, content: 'x' };
    stripInlineAvatars(original);

    // The Socket.io newMessage frame reuses this object and the UI renders
    // that avatar; stripping in place would blank it for every human viewer.
    expect(original.userId.profilePicture).toBe(DATA_URI);
  });

  test('passes non-plain objects (Date, ObjectId-like) through untouched', () => {
    const when = new Date('2026-07-26T00:00:00Z');
    const oid = { toHexString: () => 'abc' };
    Object.setPrototypeOf(oid, { custom: true });

    const out = stripInlineAvatars({ createdAt: when, _id: oid });

    expect(out.createdAt).toBe(when);
    expect(out._id).toBe(oid);
  });

  test('survives a self-referential payload without recursing forever', () => {
    const node = { username: 'a', profilePicture: DATA_URI };
    node.self = node;

    const out = stripInlineAvatars({ node });

    expect(out.node).not.toHaveProperty('profilePicture');
    expect(out.node.self).toBe(out.node);
  });

  test('leaves primitives and null alone', () => {
    expect(stripInlineAvatars(null)).toBeNull();
    expect(stripInlineAvatars('x')).toBe('x');
    expect(stripInlineAvatars(3)).toBe(3);
  });
});
