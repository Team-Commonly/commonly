// The thread headline card (W-T 4/4) against @ux-lead's render brief.
//
// Checklist items 1 and 5 are asserted here; the geometry half of item 2 is a
// real-browser check, because jsdom has no layout engine and a rail offset
// asserted in jsdom would be a test of my own CSS string.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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
  const onToggleFollowing = jest.fn();
  const onReplyInThread = over.onReplyInThread || jest.fn();
  const utils = render(
    <V2ThreadCard
      replyCount={3}
      participants={people.slice(0, 2)}
      lastActivityAt={new Date(NOW.getTime() - 2 * 60000).toISOString()}
      collapsed
      following={null}
      onToggleCollapsed={onToggleCollapsed}
      onToggleFollowing={onToggleFollowing}
      onReplyInThread={onReplyInThread}
      now={NOW}
      {...over}
    />,
  );
  return { ...utils, onToggleCollapsed, onToggleFollowing, onReplyInThread };
};

describe('content is a count, faces and a time — and nothing else', () => {
  test('renders the count, pluralised', () => {
    setup();
    expect(screen.getByText('3 replies')).toBeInTheDocument();
  });

  test('one reply is singular', () => {
    setup({ replyCount: 1 });
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });

  test('the short activity stamp is shown', () => {
    setup();
    expect(screen.getByText('2m')).toBeInTheDocument();
  });

  test('at most three avatars, however many participants', () => {
    const { container } = setup({ participants: people });
    expect(container.querySelectorAll('.v2-thread-card__faces .v2-avatar')).toHaveLength(3);
  });

  test('no reply bodies and no participant names leak into the card', () => {
    // The brief is explicit: the card is a door, not a preview. Names are the
    // easy thing to add later "for context" and the reason it is written down.
    setup({ participants: people });
    expect(screen.queryByText('Ada')).not.toBeInTheDocument();
    expect(screen.queryByText('Grace')).not.toBeInTheDocument();
  });
});

describe('accent is reserved for being addressed', () => {
  test('a resting card carries no accent modifier', () => {
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

describe('collapse is driven by the prop and reported to the caller', () => {
  test('collapsed hides the chevron and reads as not expanded', () => {
    const { container } = setup({ collapsed: true });
    expect(container.querySelector('.v2-thread-card__chevron')).toBeNull();
    expect(screen.getByRole('button', { name: /Expand thread/ })).toHaveAttribute('aria-expanded', 'false');
  });

  test('expanded shows the chevron and says so', () => {
    const { container } = setup({ collapsed: false });
    expect(container.querySelector('.v2-thread-card__chevron')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Collapse thread/ })).toHaveAttribute('aria-expanded', 'true');
  });

  test('clicking asks the caller to toggle — the card holds no state', () => {
    // If the card owned `collapsed` it would drift from the server value the
    // moment a write failed, and the persistence in constraint 2 would be a
    // local illusion.
    const { onToggleCollapsed } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Expand thread/ }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  test('Reply in thread is a sibling action that does not need an expand', () => {
    const { container, onReplyInThread, onToggleCollapsed } = setup({ collapsed: true });
    const main = container.querySelector('.v2-thread-card__main');
    const reply = screen.getByRole('button', { name: /^reply in thread$/i });

    expect(main?.contains(reply)).toBe(false);
    fireEvent.click(reply);
    expect(onReplyInThread).toHaveBeenCalledTimes(1);
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });
});

describe('the follow toggle renders three states from the raw value', () => {
  test('null reads Follow — an invitation, not a state', () => {
    setup({ collapsed: false, following: null });
    expect(screen.getByRole('button', { name: 'Follow' })).toBeInTheDocument();
  });

  test('true reads Following and is pressed', () => {
    setup({ collapsed: false, following: true });
    expect(screen.getByRole('button', { name: 'Following' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('false reads Muted, and is NOT the same rendering as null', () => {
    // Boolean(null) is false, and false is a mute. The whole tri-state exists
    // so these two do not collapse into one another.
    setup({ collapsed: false, following: false });
    const muted = screen.getByRole('button', { name: 'Muted' });
    expect(muted).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Follow' })).not.toBeInTheDocument();
  });

  test('the toggle is absent while collapsed, per the brief', () => {
    setup({ collapsed: true, following: true });
    expect(screen.queryByRole('button', { name: 'Following' })).not.toBeInTheDocument();
  });

  test('follow is a sibling of the expand control, not nested inside it', () => {
    // A button inside a button is invalid HTML and, here, a mis-hit that
    // silently mutes a thread — the expensive direction.
    const { container } = setup({ collapsed: false });
    const main = container.querySelector('.v2-thread-card__main');
    expect(main?.querySelector('.v2-thread-card__follow')).toBeNull();
    expect(container.querySelector('.v2-thread-card__follow')).not.toBeNull();
  });

  test('clicking follow does not also toggle collapse', () => {
    const { onToggleCollapsed, onToggleFollowing } = setup({ collapsed: false });
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    expect(onToggleFollowing).toHaveBeenCalledTimes(1);
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });
});
