// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2MessageRow, { landOnMessage } from '../components/V2MessageRow';
import V2MessageActions from '../components/V2MessageActions';
import V2ThreadMessages from '../components/V2ThreadMessages';

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer', _id: 'me' } }),
}));
jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));

const msg = (id, extra = {}) => ({
  id: String(id), pod_id: 'p', user_id: `u${id}`, content: `message ${id}`, created_at: '2026-09-06T09:00:00.000Z', user: { username: `author${id}` }, ...extra,
});

describe('direction C threading restyle (PR 2b)', () => {
  test('an agent row carries the runtime tag after the time and the agent modifier; a human row carries neither', () => {
    const tags = new Map([['sprint-impl', 'codex']]);
    const { container } = render(
      <MemoryRouter>
        <V2MessageRow message={msg(1, { user: { username: 'sprint-impl', isBot: true } })} agentTags={tags} />
        <V2MessageRow message={msg(2, { user: { username: 'sam', isBot: false } })} agentTags={tags} />
      </MemoryRouter>,
    );
    const agent = container.querySelector('#message-1');
    expect(agent).toHaveClass('v2-msg--agent');
    expect(agent.querySelector('.v2-msg__tag')).toHaveTextContent('codex');
    const human = container.querySelector('#message-2');
    expect(human).not.toHaveClass('v2-msg--agent');
    expect(human.querySelector('.v2-msg__tag')).toBeNull();
  });

  test('reactions past six collapse into a +N chip that expands the row', () => {
    const reactions = ['👍', '❤️', '🔥', '🤔', '👀', '🚀', '✅', '🎉'].map((emoji, i) => ({ emoji, count: i + 1, mine: false }));
    render(<MemoryRouter><V2MessageRow message={msg(3, { reactions })} /></MemoryRouter>);
    // Six emoji chips (emoji + count as text) and one +N chip whose accessible name carries the count.
    const chips = document.querySelectorAll('.v2-msg__reaction:not(.v2-msg__reaction--more)');
    expect(chips).toHaveLength(6);
    const more = screen.getByRole('button', { name: '2 more reactions' });
    expect(more).toHaveTextContent('+2');
    fireEvent.click(more);
    expect(document.querySelectorAll('.v2-msg__reaction:not(.v2-msg__reaction--more)')).toHaveLength(8);
    expect(screen.queryByRole('button', { name: /more reactions/ })).not.toBeInTheDocument();
  });

  test('at 390 a long-press reveals the strip, the click that ends the press keeps it, and the next tap hides it', () => {
    jest.useFakeTimers();
    const orig = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q.includes('hover: none'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    const { container } = render(<MemoryRouter><V2MessageRow message={msg(5)} /></MemoryRouter>);
    const row = container.querySelector('#message-5');
    fireEvent.pointerDown(row);
    act(() => { jest.advanceTimersByTime(600); });
    fireEvent.pointerUp(row);
    fireEvent.click(row);
    expect(row).toHaveClass('v2-msg--reveal');
    fireEvent.click(row);
    expect(row).not.toHaveClass('v2-msg--reveal');
    // A short tap never reveals.
    fireEvent.pointerDown(row);
    act(() => { jest.advanceTimersByTime(200); });
    fireEvent.pointerUp(row);
    fireEvent.click(row);
    expect(row).not.toHaveClass('v2-msg--reveal');
    window.matchMedia = orig;
    jest.useRealTimers();
  });

  test('a quoted reply is a link that lands on its source when loaded, else sets the hash', () => {
    window.location.hash = '';
    const { container } = render(
      <MemoryRouter>
        <V2MessageRow message={msg(10)} />
        <V2MessageRow message={msg(11, { replyTo: { id: '10', username: 'author10', content: 'message 10' } })} />
        <V2MessageRow message={msg(12, { replyTo: { id: '99', username: 'gone', content: 'paged out' } })} />
      </MemoryRouter>,
    );
    Element.prototype.scrollIntoView = jest.fn();
    const quotes = container.querySelectorAll('.v2-msg__quote');
    expect(quotes[0]).toHaveAttribute('role', 'link');
    fireEvent.click(quotes[0]);
    expect(container.querySelector('#message-10')).toHaveClass('v2-msg--landed');
    fireEvent.click(quotes[1]);
    expect(window.location.hash).toBe('#message-99');
    expect(landOnMessage(null)).toBe(false);
  });

  test('the strip is react · reply · thread · more, and more offers copy link / copy text', () => {
    render(
      <V2MessageActions
        message={msg(5)}
        author="Vera"
        onReply={jest.fn()}
        onThread={jest.fn()}
        canInteract
        pickerOpen={false}
        reactions={[]}
        onTogglePicker={jest.fn()}
        onToggleReaction={jest.fn()}
      />,
    );
    const strip = screen.getByRole('toolbar', { name: 'Message actions' });
    expect(strip).toHaveClass('v2-msg__strip');
    expect(within(strip).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Add reaction', 'Reply to Vera', 'Thread from Vera', 'More']);
    fireEvent.click(within(strip).getByRole('button', { name: 'More' }));
    expect(within(strip).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Copy link', 'Copy text']);
  });

  const renderThread = (props = {}) => {
    const root = msg(20);
    const replies = Array.from({ length: 11 }, (_, i) => msg(21 + i, { thread_root_id: '20' }));
    const setCollapsed = jest.fn();
    const toggleFollowing = jest.fn();
    const utils = render(
      <MemoryRouter>
        <V2ThreadMessages
          messages={[root, ...replies]}
          threadView={[{ kind: 'message', message: root }, { kind: 'card', rootId: '20', replyCount: 11, participants: [], lastActivityAt: null, replies }]}
          threadState={{ byRoot: new Map([['20', { collapsed: false, following: null }]]), toggleCollapsed: jest.fn(), setCollapsed, toggleFollowing }}
          decisionByMessageId={new Map()}
          settledDecisionByMessageId={new Map()}
          agentDisplayNames={new Map()}
          agentAuthorKeys={new Set()}
          onAimAtThread={jest.fn()}
          onReply={jest.fn()}
          hasMore={false}
          loadingOlder={false}
          onLoadOlder={jest.fn()}
          loading={false}
          error={null}
          messagesContainerRef={React.createRef()}
          messagesEndRef={React.createRef()}
          {...props}
        />
      </MemoryRouter>,
    );
    return { ...utils, setCollapsed, toggleFollowing };
  };

  test('a thread rests as a chip under its root even when the server row says open; the chip opens it and the server is told', () => {
    const { container, setCollapsed } = renderThread();
    const block = container.querySelector('.v2-thread-block');
    expect(block).not.toHaveClass('v2-thread-block--open');
    // The root renders INSIDE the block — one surface once it opens.
    expect(block.querySelector('#message-20')).toBeTruthy();
    expect(container.querySelectorAll('.v2-chat__messages > #message-20')).toHaveLength(0);
    expect(within(block).getByRole('button', { name: 'Expand thread, 11 replies' })).toBeInTheDocument();
    expect(block.querySelector('.v2-thread-replies')).toBeNull();
    fireEvent.click(within(block).getByRole('button', { name: 'Expand thread, 11 replies' }));
    expect(block).toHaveClass('v2-thread-block--open');
    expect(setCollapsed).toHaveBeenCalledWith('20', false);
    expect(within(block).queryByRole('button', { name: /Expand thread/ })).not.toBeInTheDocument();
  });

  test('open: one band with the root, the newest eight, a more line, and a foot with Collapse · count · Reply in thread · Follow', () => {
    const { container, setCollapsed, toggleFollowing } = renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Expand thread, 11 replies' }));
    const block = container.querySelector('.v2-thread-block--open');
    expect(block.querySelector('#message-20')).toBeTruthy();
    expect(block.querySelectorAll('.v2-thread-replies .v2-msg')).toHaveLength(8);
    fireEvent.click(within(block).getByRole('button', { name: '3 more replies' }));
    expect(block.querySelectorAll('.v2-thread-replies .v2-msg')).toHaveLength(11);
    const foot = block.querySelector('.v2-thread-replies__foot');
    expect(foot).toHaveTextContent('11 replies');
    expect(within(foot).getByRole('button', { name: /reply from expanded thread/i })).toBeInTheDocument();
    const follow = within(foot).getByRole('button', { name: 'Follow' });
    expect(follow).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(follow);
    expect(toggleFollowing).toHaveBeenCalledWith('20');
    fireEvent.click(within(foot).getByRole('button', { name: 'Collapse' }));
    expect(setCollapsed).toHaveBeenLastCalledWith('20', true);
    expect(container.querySelector('.v2-thread-block--open')).toBeNull();
  });

  test('landing on a reply folded behind the chip reveals the whole thread instead of fetching history', () => {
    const onRevealed = jest.fn();
    const { container, rerender } = renderThread({ revealMessageId: '22', onRevealed });
    expect(onRevealed).toHaveBeenCalledWith('22', true);
    const block = container.querySelector('.v2-thread-block--open');
    expect(block).toBeTruthy();
    // 22 is the second-oldest reply — outside the newest-eight window, so the fold must be gone too.
    expect(block.querySelector('#message-22')).toBeTruthy();
    expect(block.querySelectorAll('.v2-thread-replies .v2-msg')).toHaveLength(11);
    onRevealed.mockClear();
    renderThread({ revealMessageId: '999', onRevealed });
    expect(onRevealed).toHaveBeenCalledWith('999', false);
  });

  test('the strip keeps react as its first icon, disabled, when the row cannot take a reaction', () => {
    render(
      <V2MessageActions
        message={msg(6)}
        author="Vera"
        onReply={jest.fn()}
        onThread={jest.fn()}
        canInteract={false}
        pickerOpen={false}
        reactions={[]}
        onTogglePicker={jest.fn()}
        onToggleReaction={jest.fn()}
      />,
    );
    const strip = screen.getByRole('toolbar', { name: 'Message actions' });
    const buttons = within(strip).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Add reaction', 'Reply to Vera', 'Thread from Vera', 'More']);
    expect(buttons[0]).toBeDisabled();
  });

  test('transcript avatars are flat two-tone squares: agent cobalt, human tint, no illustration', () => {
    const { container } = render(
      <MemoryRouter>
        <V2MessageRow message={msg(30, { user: { username: 'sprint-impl', isBot: true } })} />
        <V2MessageRow message={msg(31, { user: { username: 'sam', isBot: false } })} />
      </MemoryRouter>,
    );
    const agent = container.querySelector('#message-30 .v2-avatar');
    const human = container.querySelector('#message-31 .v2-avatar');
    expect(agent).toHaveClass('v2-avatar--flat', 'v2-avatar--flat-agent');
    expect(human).toHaveClass('v2-avatar--flat', 'v2-avatar--flat-human');
    expect(agent.querySelector('img')).toBeNull();
    expect(agent.textContent).toBe('SI');
  });
});
