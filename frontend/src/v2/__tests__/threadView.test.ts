import {
  buildThreadView, freezeOrphanReplyIds, plainPreviewText, threadReadPoint, unreadRepliesOf,
} from '../utils/threadView';
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

  test('an orphan stays flat when its root arrives on a later page', () => {
    const orphan = msg(5, { thread_root_id: 999 });
    const frozen = freezeOrphanReplyIds([orphan]);
    const items = buildThreadView(
      [msg(999), orphan],
      state([999]),
      frozen,
    );
    expect(items.filter((i) => i.kind === 'message').map((i: any) => i.message.id)).toEqual(['999', '5']);
    expect(items.find((i) => i.kind === 'card')).toBeUndefined();
  });

  test('a frozen orphan stays visible beside an unfrozen reply under the same root', () => {
    const orphan = msg(5, { thread_root_id: 999 });
    const liveReply = msg(6, { thread_root_id: 999 });
    const frozen = freezeOrphanReplyIds([orphan]);
    const items = buildThreadView(
      [msg(999), orphan, liveReply],
      state([999]),
      frozen,
    );
    expect(items.filter((i) => i.kind === 'message').map((i: any) => i.message.id)).toEqual(['999', '5']);
    expect((items.find((i) => i.kind === 'card') as any).replies.map((reply: any) => reply.id)).toEqual(['6']);
  });

  test('freezeOrphanReplyIds retains prior freezes and adds new orphans', () => {
    const prior = new Set(['5']);
    const next = freezeOrphanReplyIds([msg(5, { thread_root_id: 999 }), msg(6, { thread_root_id: 1000 })], prior);
    expect([...next]).toEqual(['5', '6']);
    expect(prior).toEqual(new Set(['5']));
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

// D278: what the chip says about the newest reply and what the viewer hasn't read.
describe('read point, unread count and the latest-reply preview', () => {
  const ME = 'me';
  const agent = { username: 'helper', isBot: true };
  const person = { username: 'pat', isBot: false };
  const at = (min: number) => `2026-11-09T10:${String(min).padStart(2, '0')}:00.000Z`;
  // The read-tracking epoch: before it nobody could store a read point.
  const EPOCH = '2026-11-09T09:00:00.000Z';
  const cardOf = (items: any[]) => items.find((i) => i.kind === 'card') as any;
  const view = (
    messages: any[],
    readPoints: Map<string, string> = new Map(),
    viewerId: string | null = ME,
    readTrackingSince: string | null = EPOCH,
  ) => (
    cardOf(buildThreadView(messages, state([1]), new Set(), { viewerId, readPoints, readTrackingSince }))
  );

  test('no read point: a thread I never opened and never posted in shows no unread, but still previews', () => {
    const root = msg(1, { user_id: 'someone', created_at: at(0) });
    const reply = msg(2, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: at(1) });
    expect(threadReadPoint(root, [reply], ME, null)).toBeNull();
    const c = view([root, reply]);
    expect(c.unreadCount).toBe(0);
    expect(c.unreadAgentCount).toBe(0);
    expect(c.latestReply).toMatchObject({ userId: 'bot', name: 'helper', isBot: true, text: 'm2' });
    expect(c.viewerIsRootAuthor).toBe(false);
  });

  test('my own root is a read point: an agent answer after it is unread', () => {
    const c = view([
      msg(1, { user_id: ME, created_at: at(0) }),
      msg(2, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: at(1) }),
    ]);
    expect(c.viewerIsRootAuthor).toBe(true);
    expect(c.unreadCount).toBe(1);
    expect(c.unreadAgentCount).toBe(1);
    expect(c.newestUnreadAgentAt).toBe(Date.parse(at(1)));
  });

  test('the server marker counts, and replies at or before it are read', () => {
    const messages = [
      msg(1, { user_id: 'someone', created_at: at(0) }),
      msg(2, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: at(1) }),
      msg(3, { thread_root_id: 1, user_id: 'p', user: person, created_at: at(2) }),
      msg(4, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: at(3) }),
    ];
    const c = view(messages, new Map([['1', at(2)]]));
    expect(c.unreadCount).toBe(1);
    expect(c.unreadAgentCount).toBe(1);
    // A point read from the state row works the same as one moved this session.
    const fromRow = cardOf(buildThreadView(messages, new Map([['1', {
      threadRootId: 1, following: null, collapsed: true, lastReadAt: at(2),
    }]]), new Set(), { viewerId: ME, readTrackingSince: EPOCH }));
    expect(fromRow.unreadCount).toBe(1);
  });

  test('a stored point still counts when the epoch is unknown; only auto-open needs the epoch', () => {
    const c = view([
      msg(1, { user_id: 'someone', created_at: at(0) }),
      msg(2, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: at(3) }),
    ], new Map([['1', at(1)]]), ME, null);
    expect(c.unreadCount).toBe(1);
    expect(c.unreadAgentCount).toBe(0);
    expect(c.newestUnreadAgentAt).toBeNull();
  });

  test('own-message fallback: my later reply wins over an older server marker', () => {
    const c = view([
      msg(1, { user_id: 'someone', created_at: at(0) }),
      msg(2, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: at(1) }),
      msg(3, { thread_root_id: 1, user_id: ME, created_at: at(4) }),
      msg(4, { thread_root_id: 1, user_id: 'p', user: person, created_at: at(5) }),
    ], new Map([['1', at(0)]]));
    expect(c.unreadCount).toBe(1);
    expect(c.unreadAgentCount).toBe(0);
  });

  // D1 on #3831: on the first load after deploy nobody has a stored point, so
  // the own-message fallback would light up every old thread I ever posted in.
  test('an old thread whose agent reply is before the epoch gets no mark and nothing to auto-open', () => {
    const old = (n: number) => `2026-10-01T10:0${n}:00.000Z`;
    const c = view([
      msg(1, { user_id: ME, created_at: old(0) }),
      msg(2, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: old(1) }),
    ]);
    expect(c.viewerIsRootAuthor).toBe(true);
    expect(c.unreadCount).toBe(0);
    expect(c.unreadAgentCount).toBe(0);
    expect(c.newestUnreadAgentAt).toBeNull();
  });

  test('an old thread whose agent reply is after the epoch gets the mark and is open-worthy', () => {
    const c = view([
      msg(1, { user_id: ME, created_at: '2026-10-01T10:00:00.000Z' }),
      msg(2, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: at(5) }),
    ]);
    expect(c.unreadCount).toBe(1);
    expect(c.unreadAgentCount).toBe(1);
    expect(c.newestUnreadAgentAt).toBe(Date.parse(at(5)));
  });

  test('with no epoch the own-message fallback gives no point at all', () => {
    const root = msg(1, { user_id: ME, created_at: at(0) });
    const reply = msg(2, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: at(1) });
    expect(threadReadPoint(root, [reply], ME, null, null)).toBeNull();
    expect(threadReadPoint(root, [reply], ME, null, EPOCH)).toBe(Date.parse(at(0)));
    const c = view([root, reply], new Map(), ME, null);
    expect(c.unreadCount).toBe(0);
    expect(c.unreadAgentCount).toBe(0);
  });

  test('my own replies are never unread, however new', () => {
    const replies = [
      msg(2, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: at(1) }),
      msg(3, { thread_root_id: 1, user_id: ME, created_at: at(9) }),
    ];
    expect(unreadRepliesOf(replies, ME, Date.parse(at(0))).map((r) => r.id)).toEqual(['2']);
    // In the view, my newest message also moves the point past the agent's reply.
    expect(view([msg(1, { user_id: ME, created_at: at(0) }), ...replies]).unreadCount).toBe(0);
  });

  test('the latest reply is the newest by time, and its text is one plain line', () => {
    const c = view([
      msg(1, { user_id: 'someone', created_at: at(0) }),
      { ...msg(3, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: at(5) }), content: '## Plan\n\n- **Ship** the [fix](https://x.test)\n- then `test` it' },
      msg(2, { thread_root_id: 1, user_id: 'p', user: person, created_at: at(2) }),
    ]);
    expect(c.latestReply.userId).toBe('bot');
    expect(c.latestReply.text).toBe('Plan Ship the fix then test it');
    expect(c.latestReply.isCard).toBe(false);
  });

  test('a card message previews its summary, or leaves the text empty for the chip to say "sent a card"', () => {
    const cardReply = (extra: any = {}) => ({
      ...msg(2, { thread_root_id: 1, user_id: 'bot', user: agent, created_at: at(1) }),
      content: '{"elements":[]}',
      ...extra,
    });
    const withSummary = view([msg(1, { created_at: at(0) }), cardReply({ summary: 'Two options to pick from', payload: { kind: 'ui' } })]);
    expect(withSummary.latestReply).toMatchObject({ isCard: true, text: 'Two options to pick from' });
    const fromPayload = view([msg(1, { created_at: at(0) }), cardReply({ payload: { kind: 'approval-card', summary: 'Approve the deploy' } })]);
    expect(fromPayload.latestReply).toMatchObject({ isCard: true, text: 'Approve the deploy' });
    const bare = view([msg(1, { created_at: at(0) }), cardReply({ payload: { kind: 'ui' } })]);
    expect(bare.latestReply).toMatchObject({ isCard: true, text: '' });
  });

  test('plainPreviewText collapses whitespace and strips marks a preview would show literally', () => {
    expect(plainPreviewText('  one\n\n   two\tthree ')).toBe('one two three');
    expect(plainPreviewText('> quoted *em* and _em_ ~~gone~~')).toBe('quoted em and em gone');
    expect(plainPreviewText('![chart](https://x.test/c.png) see above')).toBe('chart see above');
    expect(plainPreviewText('x'.repeat(500))).toHaveLength(200);
  });
});
