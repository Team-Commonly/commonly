import { firstNewSinceId } from '../utils/newSince';

const msg = (id: string, user: string, at: string, type = 'text') => ({
  kind: 'message' as const,
  message: { id, user_id: user, created_at: at, message_type: type, content: id } as never,
});

const view = [
  msg('1', 'mate', '2026-11-14T10:00:00Z'),
  msg('2', 'me', '2026-11-14T11:00:00Z'),
  msg('3', 'agent', '2026-11-14T11:30:00Z', 'system'),
  msg('4', 'mate', '2026-11-14T12:00:00Z'),
  msg('5', 'mate', '2026-11-14T13:00:00Z'),
];

describe('firstNewSinceId', () => {
  it('is the first message someone else wrote after the read point', () => {
    expect(firstNewSinceId(view, 'me', '2026-11-14T10:30:00Z')).toBe('4');
  });
  it('skips the viewer\'s own words and system lines', () => {
    expect(firstNewSinceId(view, 'me', '2026-11-14T10:30:00Z')).not.toBe('2');
    expect(firstNewSinceId(view, 'me', '2026-11-14T10:30:00Z')).not.toBe('3');
  });
  it('is none with no read point, or when nothing is newer', () => {
    expect(firstNewSinceId(view, 'me', null)).toBeNull();
    expect(firstNewSinceId(view, 'me', '2026-11-14T13:00:00Z')).toBeNull();
    expect(firstNewSinceId(view, null, '2026-11-14T10:30:00Z')).toBeNull();
  });
  it('ignores thread cards and claim groups', () => {
    const withCard = [{ kind: 'card', rootId: '9', replyCount: 2, participants: [], lastActivityAt: null, replies: [] } as never, ...view];
    expect(firstNewSinceId(withCard, 'me', '2026-11-14T10:30:00Z')).toBe('4');
  });
});
