import { buildThreadView } from '../utils/threadView';
import { V2ThreadState } from '../hooks/useV2ThreadState';

const msg = (id: number, opts: Partial<any> = {}) => ({
  id: String(id),
  pod_id: 'pod-1',
  user_id: opts.user_id || 'u1',
  content: `m${id}`,
  message_type: 'text',
  created_at: opts.created_at || `2026-08-22T10:0${id % 10}:00Z`,
  thread_root_id: opts.thread_root_id ?? null,
  user: opts.user,
} as any);

const state = (ids: number[]): Map<string, V2ThreadState> => new Map(
  ids.map((i) => [String(i), { threadRootId: i, following: null, collapsed: true }]),
);

describe('replies fold under their root', () => {
  test('a root with replies yields the root then a card', () => {
    const items = buildThreadView([msg(1), msg(2, { thread_root_id: 1 })], state([1]));
    expect(items.map((i) => i.kind)).toEqual(['message', 'card']);
    expect(items[0]).toMatchObject({ message: { id: '1' } });
    expect(items[1]).toMatchObject({ rootId: '1', replyCount: 1 });
  });

  test('replies do not also appear flat', () => {
    const items = buildThreadView([msg(1), msg(2, { thread_root_id: 1 })], state([1]));
    const flat = items.filter((i) => i.kind === 'message').map((i: any) => i.message.id);
    expect(flat).toEqual(['1']);
  });

  test('a message with no replies gets no card', () => {
    const items = buildThreadView([msg(1), msg(9)], state([]));
    expect(items.map((i) => i.kind)).toEqual(['message', 'message']);
  });

  test('two threads stay separate and keep root order', () => {
    const items = buildThreadView(
      [msg(1), msg(2), msg(3, { thread_root_id: 1 }), msg(4, { thread_root_id: 2 })],
      state([1, 2]),
    );
    const cards = items.filter((i) => i.kind === 'card') as any[];
    expect(cards.map((c) => c.rootId)).toEqual(['1', '2']);
    expect(cards[0].replies.map((r: any) => r.id)).toEqual(['3']);
    expect(cards[1].replies.map((r: any) => r.id)).toEqual(['4']);
  });
});

describe('a reply whose root is not in the page is not lost', () => {
  test('it renders flat rather than disappearing', () => {
    // Paged out, or the root was deleted. Hiding it would be the one outcome
    // worse than showing it in the wrong place.
    const items = buildThreadView([msg(5, { thread_root_id: 999 })], state([]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'message', message: { id: '5' } });
  });
});

describe('card metadata', () => {
  test('participants are deduped, in first-appearance order, root author first', () => {
    const items = buildThreadView(
      [
        msg(1, { user_id: 'root-author' }),
        msg(2, { thread_root_id: 1, user_id: 'b' }),
        msg(3, { thread_root_id: 1, user_id: 'root-author' }),
        msg(4, { thread_root_id: 1, user_id: 'c' }),
      ],
      state([1]),
    );
    const card = items.find((i) => i.kind === 'card') as any;
    expect(card.participants.map((p: any) => p.userId)).toEqual(['root-author', 'b', 'c']);
  });

  test('lastActivityAt is the newest reply, not the root', () => {
    const items = buildThreadView(
      [
        msg(1, { created_at: '2026-08-22T10:00:00Z' }),
        msg(2, { thread_root_id: 1, created_at: '2026-08-22T11:00:00Z' }),
        msg(3, { thread_root_id: 1, created_at: '2026-08-22T10:30:00Z' }),
      ],
      state([1]),
    );
    const card = items.find((i) => i.kind === 'card') as any;
    expect(card.lastActivityAt).toBe('2026-08-22T11:00:00Z');
  });

  test('replyCount counts replies, not the root', () => {
    const items = buildThreadView(
      [msg(1), msg(2, { thread_root_id: 1 }), msg(3, { thread_root_id: 1 })],
      state([1]),
    );
    expect((items.find((i) => i.kind === 'card') as any).replyCount).toBe(2);
  });

  test('bot-ness is carried through for the avatar tier', () => {
    const items = buildThreadView(
      [msg(1, { user_id: 'bot', user: { username: 'Recorder', isBot: true } }), msg(2, { thread_root_id: 1 })],
      state([1]),
    );
    const card = items.find((i) => i.kind === 'card') as any;
    expect(card.participants[0]).toMatchObject({ name: 'Recorder', isBot: true });
  });
});
