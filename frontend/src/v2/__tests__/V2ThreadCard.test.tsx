// The thread chip (direction C, ux-lead 64476 (3)): faces + count + last —
// and nothing else. Reply in thread and Follow live in the expanded band's
// foot (V2ThreadRestyle.test), the chevron is gone.
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import V2ThreadCard from '../components/V2ThreadCard';

const NOW = new Date('2026-08-22T12:00:00Z');

const people = [
  { userId: 'u1', name: 'Ada', isBot: false },
  { userId: 'u2', name: 'Grace', isBot: false },
  { userId: 'u3', name: 'Recorder', isBot: true },
  { userId: 'u4', name: 'Fourth', isBot: false },
];

const setup = (over: Partial<React.ComponentProps<typeof V2ThreadCard>> = {}) => {
  const onToggleCollapsed = jest.fn();
  const utils = render(
    <V2ThreadCard
      replyCount={3}
      participants={people.slice(0, 2)}
      lastActivityAt={new Date(NOW.getTime() - 2 * 60000).toISOString()}
      collapsed
      onToggleCollapsed={onToggleCollapsed}
      now={NOW}
      {...over}
    />,
  );
  return { ...utils, onToggleCollapsed };
};

describe('content is faces, a count and a time — and nothing else', () => {
  test('renders the count, pluralised, and the `· last` stamp', () => {
    setup();
    expect(screen.getByText('3 replies')).toBeInTheDocument();
    expect(screen.getByText(/^· last 2m$/)).toBeInTheDocument();
  });

  test('one reply is singular', () => {
    setup({ replyCount: 1 });
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });

  test('at most three faces, flat two-tone, however many participants', () => {
    const { container } = setup({ participants: people });
    const faces = container.querySelectorAll('.v2-thread-card__faces .v2-avatar');
    expect(faces).toHaveLength(3);
    expect(faces[0]).toHaveClass('v2-avatar--flat-human');
    expect(faces[2]).toHaveClass('v2-avatar--flat-agent');
  });

  test('no reply bodies, no names, no chevron, no reply or follow controls', () => {
    const { container } = setup({ participants: people });
    expect(screen.queryByText('Ada')).not.toBeInTheDocument();
    expect(screen.queryByText('Grace')).not.toBeInTheDocument();
    expect(container.querySelector('.v2-thread-card__chevron')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /reply in thread/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /follow/i })).not.toBeInTheDocument();
  });
});

describe('accent is reserved for being addressed', () => {
  test('a resting chip carries no accent modifier', () => {
    const { container } = setup();
    expect(container.querySelector('.v2-thread-card--addressed')).toBeNull();
    expect(container.querySelector('.v2-thread-card__dot')).toBeNull();
  });

  test('an addressed thread gets the modifier and the dot', () => {
    const { container } = setup({ addressed: true });
    expect(container.querySelector('.v2-thread-card--addressed')).not.toBeNull();
    expect(container.querySelector('.v2-thread-card__dot')).not.toBeNull();
  });
});

describe('the chip is a door', () => {
  test('its accessible name carries the state and a click asks the caller to open', () => {
    const { onToggleCollapsed } = setup();
    const chip = screen.getByRole('button', { name: 'Expand thread, 3 replies' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip).toHaveClass('v2-msg__thread-chip');
    fireEvent.click(chip);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
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

  test('count, stamp and accessible name render in Chinese, with none of the English', () => {
    const { container } = setup({ replyCount: 1, lastActivityAt: new Date(NOW.getTime() - 25 * 60 * 60000).toISOString() });
    expect(screen.getByText('1条回复')).toBeInTheDocument();
    expect(screen.getByText('· 最近活动 昨天')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开话题，1条回复' })).toBeInTheDocument();
    const text = `${container.textContent} ${screen.getByRole('button').getAttribute('aria-label')}`;
    expect(text).not.toMatch(/\b(reply|replies|last|Yesterday|Expand|Collapse|thread)\b/i);
  });

  test('plural counts and minute stamps, expanded', () => {
    setup({ replyCount: 3, collapsed: false });
    expect(screen.getByText('3条回复')).toBeInTheDocument();
    expect(screen.getByText('· 最近活动 2分钟')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起话题，3条回复' })).toBeInTheDocument();
  });
});
