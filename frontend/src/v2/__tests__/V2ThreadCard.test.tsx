// The thread chip. Direction C (ux-lead 64476 (3)) made it faces + count +
// last and nothing else; ruling D278 (2026-11-09) made it preview its latest
// reply: the replier's face and name, one line of what they said, the count,
// and what this person hasn't read. Reply in thread and Follow still live in
// the expanded band's foot (V2ThreadRestyle.test), and there is no chevron.
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import V2ThreadCard from '../components/V2ThreadCard';

const people = [
  { userId: 'u1', name: 'Ada', isBot: false },
  { userId: 'u2', name: 'Grace', isBot: false },
  { userId: 'u3', name: 'Recorder', isBot: true },
  { userId: 'u4', name: 'Fourth', isBot: false },
];

const latest = {
  userId: 'u3', name: 'Recorder', isBot: true, text: 'Here is the plan for the launch', isCard: false,
};

const setup = (over: Partial<React.ComponentProps<typeof V2ThreadCard>> = {}) => {
  const onToggleCollapsed = jest.fn();
  const utils = render(
    <V2ThreadCard
      replyCount={3}
      participants={people.slice(0, 2)}
      collapsed
      onToggleCollapsed={onToggleCollapsed}
      {...over}
    />,
  );
  return { ...utils, onToggleCollapsed };
};

describe('the chip previews its latest reply (D278)', () => {
  test('one line: the replier\'s face and name, the reply text, then the count', () => {
    const { container } = setup({ latestReply: latest });
    const chip = screen.getByRole('button');
    expect(chip.querySelector('.v2-thread-card__name')).toHaveTextContent('Recorder');
    expect(chip.querySelector('.v2-thread-card__preview')).toHaveTextContent('Here is the plan for the launch');
    expect(screen.getByText('3 replies')).toBeInTheDocument();
    // In reading order: face, name, preview, separator, count.
    const order = Array.from(chip.children).map((el) => el.className);
    expect(order).toEqual([
      'v2-thread-card__faces',
      'v2-thread-card__name',
      'v2-thread-card__preview',
      'v2-thread-card__sep',
      'v2-thread-card__count',
    ]);
    // One 16px face now, the replier's, flat two-tone.
    const faces = container.querySelectorAll('.v2-thread-card__faces .v2-avatar');
    expect(faces).toHaveLength(1);
    expect(faces[0]).toHaveClass('v2-avatar--flat-agent');
  });

  test('one reply is singular', () => {
    setup({ replyCount: 1, latestReply: latest });
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });

  test('a card with no summary says it sent a card', () => {
    setup({ latestReply: { ...latest, text: '', isCard: true } });
    expect(document.querySelector('.v2-thread-card__preview')).toHaveTextContent('sent a card');
  });

  test('without a latest reply (an older caller), one face and the count', () => {
    const { container } = setup({ participants: people });
    expect(container.querySelectorAll('.v2-thread-card__faces .v2-avatar')).toHaveLength(1);
    expect(container.querySelector('.v2-thread-card__preview')).toBeNull();
    expect(screen.getByText('3 replies')).toBeInTheDocument();
  });

  test('still no chevron and no reply or follow controls', () => {
    const { container } = setup({ latestReply: latest });
    expect(container.querySelector('.v2-thread-card__chevron')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /reply in thread/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /follow/i })).not.toBeInTheDocument();
  });
});

describe('the unread mark', () => {
  test('a chip with nothing unread carries no mark and no accent', () => {
    const { container } = setup({ latestReply: latest });
    expect(container.querySelector('.v2-thread-card__unread')).toBeNull();
    expect(container.querySelector('.v2-thread-card--unread')).toBeNull();
    expect(container.querySelector('.v2-thread-card__dot')).toBeNull();
  });

  test('unread replies show the count of new ones after the reply count, with the dot', () => {
    const { container } = setup({ latestReply: latest, unreadCount: 2 });
    const mark = container.querySelector('.v2-thread-card__unread');
    expect(mark).toHaveTextContent('2 new');
    expect(mark?.querySelector('.v2-thread-card__dot')).not.toBeNull();
    expect(container.querySelector('.v2-thread-card--unread')).not.toBeNull();
    const chip = screen.getByRole('button');
    expect(chip.lastElementChild).toBe(mark);
  });

  test('an addressed thread still gets its modifier and dot on the count', () => {
    const { container } = setup({ addressed: true });
    expect(container.querySelector('.v2-thread-card--addressed')).not.toBeNull();
    expect(container.querySelector('.v2-thread-card__count .v2-thread-card__dot')).not.toBeNull();
  });
});

describe('the chip opens the thread', () => {
  test('its accessible name carries the state, the replier, the count and the unread count', () => {
    const { onToggleCollapsed } = setup({ latestReply: latest, unreadCount: 2 });
    const chip = screen.getByRole('button', { name: 'Expand thread, 3 replies, latest from Recorder, 2 new' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip).toHaveClass('v2-msg__thread-chip');
    fireEvent.click(chip);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  test('with nothing unread the name leaves the unread part out', () => {
    setup({ latestReply: latest });
    expect(screen.getByRole('button', { name: 'Expand thread, 3 replies, latest from Recorder' })).toBeInTheDocument();
  });

  test('an older caller with no latest reply keeps the plain name', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Expand thread, 3 replies' })).toBeInTheDocument();
  });
});

describe('zh-CN', () => {
  beforeAll(async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
  });
  afterAll(async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  test('count, unread mark and accessible name render in Chinese, with none of the English', () => {
    const { container } = setup({ replyCount: 1, latestReply: latest, unreadCount: 1 });
    expect(screen.getByText('1条回复')).toBeInTheDocument();
    expect(container.querySelector('.v2-thread-card__unread')).toHaveTextContent('1条未读');
    const chip = screen.getByRole('button', { name: '展开话题，1条回复，最新回复来自 Recorder，1条未读' });
    // The reply text and the replier's name are content, not chrome: they stay as written.
    const chrome = `${chip.querySelector('.v2-thread-card__count')?.textContent} ${chip.querySelector('.v2-thread-card__unread')?.textContent} ${chip.getAttribute('aria-label')}`;
    expect(chrome).not.toMatch(/\b(reply|replies|new|latest|from|Expand|Collapse|thread)\b/i);
  });

  test('plural counts, expanded, and a card with no summary', () => {
    setup({ replyCount: 3, collapsed: false, latestReply: { ...latest, text: '', isCard: true } });
    expect(screen.getByText('3条回复')).toBeInTheDocument();
    expect(document.querySelector('.v2-thread-card__preview')).toHaveTextContent('[卡片]');
    expect(screen.getByRole('button', { name: '收起话题，3条回复，最新回复来自 Recorder' })).toBeInTheDocument();
  });
});
