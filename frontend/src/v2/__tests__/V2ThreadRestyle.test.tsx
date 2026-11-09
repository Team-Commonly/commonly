// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2MessageRow, { landOnMessage } from '../components/V2MessageRow';
import V2MessageActions from '../components/V2MessageActions';
import V2ThreadMessages from '../components/V2ThreadMessages';
import { buildThreadView } from '../utils/threadView';

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

  // The strip stayed over the chat at 390 until the same message was tapped
  // again. A tap elsewhere, or using one of its actions, now closes it.
  test('at 390 a revealed strip closes on a tap outside the message and after Reply', () => {
    jest.useFakeTimers();
    const orig = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q.includes('hover: none'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    const onReply = jest.fn();
    const { container } = render(
      <MemoryRouter>
        <V2MessageRow message={msg(5)} onReply={onReply} />
        <V2MessageRow message={msg(6)} onReply={onReply} />
      </MemoryRouter>,
    );
    const row = container.querySelector('#message-5');
    const reveal = () => {
      fireEvent.pointerDown(row);
      act(() => { jest.advanceTimersByTime(600); });
      fireEvent.pointerUp(row);
      fireEvent.click(row);
      expect(row).toHaveClass('v2-msg--reveal');
    };

    reveal();
    // A press inside the message (its own strip included) keeps it open.
    fireEvent.pointerDown(row.querySelector('.v2-msg__strip'));
    expect(row).toHaveClass('v2-msg--reveal');
    fireEvent.pointerDown(container.querySelector('#message-6'));
    expect(row).not.toHaveClass('v2-msg--reveal');

    reveal();
    fireEvent.click(within(row.querySelector('.v2-msg__strip')).getByRole('button', { name: /reply/i }));
    expect(onReply).toHaveBeenCalledTimes(1);
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
    expect(document.activeElement).toBe(container.querySelector('#message-10'));
    fireEvent.click(quotes[1]);
    expect(window.location.hash).toBe('#message-99');
    expect(landOnMessage(null)).toBe(false);
  });

  test('a decision-card ask row is a keyboard-landable landing target', () => {
    const { container } = render(
      <MemoryRouter>
        <V2MessageRow
          message={msg('decision-ask')}
          decision={{
            id: 'decision-1',
            title: 'Choose a path',
            options: [{ label: 'Ship it' }, { label: 'Wait' }],
          }}
        />
      </MemoryRouter>,
    );
    const row = container.querySelector('#message-decision-ask');
    expect(row).toHaveClass('v2-message-row--decision');
    expect(row).toHaveAttribute('tabindex', '-1');
    Element.prototype.scrollIntoView = jest.fn();
    expect(landOnMessage('decision-ask')).toBe(true);
    expect(document.activeElement).toBe(row);
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

  test('the first-reply invite survives collapse and the hidden expanded prefix exactly once', () => {
    const { container } = renderThread({ afterMessage: { messageId: '21', content: <div data-testid="teammate-prompt">Invite</div> } });
    expect(screen.getAllByTestId('teammate-prompt')).toHaveLength(1);
    expect(container.querySelector('.v2-thread-replies')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand thread, 11 replies' }));
    const prompt = screen.getByTestId('teammate-prompt');
    expect(prompt.previousElementSibling).toHaveClass('v2-thread-replies__more');
    expect(container.querySelector('#message-21')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '3 more replies' }));
    expect(screen.getAllByTestId('teammate-prompt')).toHaveLength(1);
    expect(screen.getByTestId('teammate-prompt').previousElementSibling).toHaveAttribute('id', 'message-21');
  });

  test('an expanded visible reply keeps its invite directly after that reply', () => {
    renderThread({ afterMessage: { messageId: '31', content: <div data-testid="teammate-prompt">Invite</div> } });
    fireEvent.click(screen.getByRole('button', { name: 'Expand thread, 11 replies' }));
    expect(screen.getAllByTestId('teammate-prompt')).toHaveLength(1);
    expect(screen.getByTestId('teammate-prompt').previousElementSibling).toHaveAttribute('id', 'message-31');
  });

  test('expanded settled source replies render one ruled answer instead of a duplicate durable reply', () => {
    const root = msg(20);
    const source = msg(21, { thread_root_id: '20', content: 'Choose a path' });
    const durableRuling = msg(22, { thread_root_id: '20', content: 'Ship it', user: { username: 'Sam' } });
    const replies = [source, durableRuling];
    const { container } = renderThread({
      messages: [root, ...replies],
      threadView: [
        { kind: 'message', message: root },
        { kind: 'card', rootId: '20', replyCount: replies.length, participants: [], lastActivityAt: null, replies },
      ],
      settledDecisionByMessageId: new Map([['21', { value: 'Ship it', by: 'Sam', messageId: '22' }]]),
      afterMessage: { messageId: '21', content: <div data-testid="settled-invite">Invite</div> },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand thread, 2 replies' }));
    const block = container.querySelector('.v2-thread-block--open');
    expect(block.querySelectorAll('.v2-thread-replies .v2-msg')).toHaveLength(1);
    expect(screen.getAllByTestId('settled-invite')).toHaveLength(1);
    expect(block.querySelector('[data-testid="decision-ruling-row"]')).toHaveTextContent('Ship it');
    expect(block.querySelectorAll('#message-22')).toHaveLength(1);
    Element.prototype.scrollIntoView = jest.fn();
    expect(landOnMessage('21')).toBe(true);
    const sourceTarget = block.querySelector('#message-22');
    expect(sourceTarget).toHaveClass('v2-msg--landed');
    expect(landOnMessage('22')).toBe(true);
    expect(block.querySelector('#message-22')).toBe(sourceTarget);
  });

  test('settled root keeps source and durable links on the same visible ruling', () => {
    const root = msg(30, { content: 'Choose a path' });
    const durableRuling = msg(31, { content: 'Ship it', user: { username: 'Sam' } });
    const { container } = renderThread({
      messages: [root, durableRuling],
      threadView: [{ kind: 'message', message: root }],
      settledDecisionByMessageId: new Map([['30', { value: 'Ship it', by: 'Sam', messageId: '31' }]]),
    });
    const ruling = container.querySelector('[data-testid="decision-ruling-row"]');
    expect(ruling).toBe(container.querySelector('#message-31'));
    Element.prototype.scrollIntoView = jest.fn();
    expect(landOnMessage('30')).toBe(true);
    expect(landOnMessage('31')).toBe(true);
    expect(container.querySelectorAll('[data-testid="decision-ruling-row"]')).toHaveLength(1);
    expect(container.querySelector('#message-31')).toBe(ruling);
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

  test('transcript avatars keep Big Smile faces inside compact square frames', () => {
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
    expect(agent.querySelector('img')).toHaveAttribute('src', expect.stringMatching(/^data:image\/svg\+xml/));
    expect(human.querySelector('img')).toHaveAttribute('src', expect.stringMatching(/^data:image\/svg\+xml/));
  });
});

// D278: answers land in the mention's thread, so the asker's own thread opens
// for them and everyone else's chip previews the latest reply.
describe('D278: threads that hold an answer to me', () => {
  const at = (min) => `2026-11-09T10:${String(min).padStart(2, '0')}:00.000Z`;
  // The read-tracking epoch (#3831 D1): before every fixture message here.
  const EPOCH = '2026-11-09T09:00:00.000Z';
  const helper = { username: 'helper', isBot: true };
  const root = (id) => msg(id, { user_id: 'me', created_at: at(0), content: `question ${id}` });
  const answer = (id, rootId, minute) => msg(id, {
    thread_root_id: String(rootId), user_id: 'bot', user: helper, created_at: at(minute), content: `answer ${id}`,
  });

  // jsdom has no IntersectionObserver; this one lets a test say which bands
  // are on screen.
  let observers = [];
  class MockIntersectionObserver {
    constructor(callback) { this.callback = callback; this.elements = new Set(); observers.push(this); }

    observe(element) { this.elements.add(element); }

    unobserve(element) { this.elements.delete(element); }

    disconnect() { this.elements.clear(); }
  }
  const bandsOnScreen = (isIntersecting) => act(() => {
    observers.forEach((observer) => observer.callback(
      Array.from(observer.elements).map((target) => ({ target, isIntersecting })),
    ));
  });
  let visibility = 'visible';
  const setTabVisibility = (value) => act(() => {
    visibility = value;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const PreviousObserver = global.IntersectionObserver;
  beforeEach(() => {
    observers = [];
    visibility = 'visible';
    global.IntersectionObserver = MockIntersectionObserver;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });
  afterEach(() => {
    global.IntersectionObserver = PreviousObserver;
    delete document.visibilityState;
  });

  const renderAsker = (messages, extra = {}) => {
    const markRead = jest.fn();
    const setCollapsed = jest.fn();
    const onThreadOpened = jest.fn();
    const props = (list) => ({
      messages: list,
      threadView: buildThreadView(list, new Map(), new Set(), { viewerId: 'me', readTrackingSince: extra.readTrackingSince ?? EPOCH }),
      threadState: {
        byRoot: new Map(), toggleCollapsed: jest.fn(), setCollapsed, toggleFollowing: jest.fn(), markRead, ready: true,
      },
      viewerId: 'me',
      onThreadOpened,
      decisionByMessageId: new Map(),
      settledDecisionByMessageId: new Map(),
      agentDisplayNames: new Map(),
      agentAuthorKeys: new Set(),
      onAimAtThread: jest.fn(),
      onReply: jest.fn(),
      hasMore: false,
      loadingOlder: false,
      onLoadOlder: jest.fn(),
      loading: false,
      error: null,
      messagesContainerRef: React.createRef(),
      messagesEndRef: React.createRef(),
      ...extra,
    });
    const utils = render(<MemoryRouter><V2ThreadMessages {...props(messages)} /></MemoryRouter>);
    const rerenderWith = (list) => utils.rerender(<MemoryRouter><V2ThreadMessages {...props(list)} /></MemoryRouter>);
    return { ...utils, rerenderWith, markRead, setCollapsed, onThreadOpened };
  };

  afterEach(() => { jest.useRealTimers(); });

  test('the asker\'s thread opens on an unread agent reply, the reply shows, and the list is asked to stay pinned', () => {
    const { container, setCollapsed, onThreadOpened } = renderAsker([root(40), answer(41, 40, 1)]);
    const block = container.querySelector('.v2-thread-block');
    expect(block).toHaveClass('v2-thread-block--open');
    expect(block.querySelector('#message-41')).toBeTruthy();
    expect(onThreadOpened).toHaveBeenCalledTimes(1);
    // A local open: the server's collapsed row is written only by a gesture.
    expect(setCollapsed).not.toHaveBeenCalled();
  });

  test('an open thread on screen in a visible tab marks itself read up to its newest reply, after the settle', () => {
    jest.useFakeTimers();
    const { markRead } = renderAsker([root(40), answer(41, 40, 1), answer(42, 40, 3)]);
    bandsOnScreen(true);
    act(() => { jest.advanceTimersByTime(599); });
    expect(markRead).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1); });
    expect(markRead).toHaveBeenCalledWith('40', at(3));
  });

  test('an open thread that is off screen is not marked read', () => {
    jest.useFakeTimers();
    const { container, markRead } = renderAsker([root(40), answer(41, 40, 1)]);
    expect(container.querySelector('.v2-thread-block--open')).toBeTruthy();
    // Never reported on screen.
    act(() => { jest.advanceTimersByTime(2000); });
    // Reported, then scrolled away before the settle.
    bandsOnScreen(true);
    act(() => { jest.advanceTimersByTime(300); });
    bandsOnScreen(false);
    act(() => { jest.advanceTimersByTime(2000); });
    expect(markRead).not.toHaveBeenCalled();
  });

  test('a hidden tab marks nothing; the settle starts when the tab is shown', () => {
    jest.useFakeTimers();
    visibility = 'hidden';
    const { markRead } = renderAsker([root(40), answer(41, 40, 1)]);
    bandsOnScreen(true);
    act(() => { jest.advanceTimersByTime(2000); });
    expect(markRead).not.toHaveBeenCalled();
    setTabVisibility('visible');
    act(() => { jest.advanceTimersByTime(600); });
    expect(markRead).toHaveBeenCalledWith('40', at(1));
  });

  test('nothing is marked read before the thread state has loaded', () => {
    jest.useFakeTimers();
    const markRead = jest.fn();
    renderAsker([msg(50, { created_at: at(0) }), answer(51, 50, 2)], {
      threadState: {
        byRoot: new Map(), toggleCollapsed: jest.fn(), setCollapsed: jest.fn(), toggleFollowing: jest.fn(), markRead, ready: false,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Expand thread, 1 reply/ }));
    bandsOnScreen(true);
    act(() => { jest.advanceTimersByTime(2000); });
    expect(markRead).not.toHaveBeenCalled();
  });

  test('a thread opened by hand marks itself read too', () => {
    jest.useFakeTimers();
    const { markRead } = renderAsker([msg(50, { created_at: at(0) }), answer(51, 50, 2)]);
    act(() => { jest.advanceTimersByTime(600); });
    expect(markRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Expand thread, 1 reply, latest from helper/ }));
    bandsOnScreen(true);
    act(() => { jest.advanceTimersByTime(600); });
    expect(markRead).toHaveBeenCalledWith('50', at(2));
  });

  test('a bystander sees the chip with the latest reply and no unread mark', () => {
    jest.useFakeTimers();
    const { container, markRead, onThreadOpened } = renderAsker([msg(50, { created_at: at(0) }), answer(51, 50, 2)]);
    const block = container.querySelector('.v2-thread-block');
    expect(block).not.toHaveClass('v2-thread-block--open');
    const chip = within(block).getByRole('button', { name: 'Expand thread, 1 reply, latest from helper: answer 51' });
    expect(chip.querySelector('.v2-thread-card__name')).toHaveTextContent('helper');
    expect(chip.querySelector('.v2-thread-card__preview')).toHaveTextContent('answer 51');
    expect(chip.querySelector('.v2-thread-card__unread')).toBeNull();
    bandsOnScreen(true);
    act(() => { jest.advanceTimersByTime(600); });
    expect(markRead).not.toHaveBeenCalled();
    expect(onThreadOpened).not.toHaveBeenCalled();
  });

  test('the chip names an agent the way its row does', () => {
    renderAsker([msg(50, { created_at: at(0) }), answer(51, 50, 2)], { agentDisplayNames: new Map([['helper', 'Helper Bot']]) });
    expect(screen.getByRole('button', { name: 'Expand thread, 1 reply, latest from Helper Bot: answer 51' })).toBeInTheDocument();
  });

  test('a thread closed by hand stays closed until a newer agent reply arrives', () => {
    const first = [root(40), answer(41, 40, 1)];
    const { container, rerenderWith } = renderAsker(first);
    fireEvent.click(within(container.querySelector('.v2-thread-replies__foot')).getByRole('button', { name: 'Collapse' }));
    expect(container.querySelector('.v2-thread-block--open')).toBeNull();
    // Same replies, fresh view: still a chip, and it still says what is unread.
    rerenderWith([...first]);
    expect(container.querySelector('.v2-thread-block--open')).toBeNull();
    expect(container.querySelector('.v2-thread-card__unread')).toHaveTextContent('1 new');
    // A newer agent reply opens it again.
    rerenderWith([...first, answer(42, 40, 5)]);
    expect(container.querySelector('.v2-thread-block--open')).toBeTruthy();
  });

  test('a human reply does not open the asker\'s thread; the chip still marks it unread', () => {
    const { container } = renderAsker([
      root(40),
      msg(41, { thread_root_id: '40', user_id: 'pat', user: { username: 'pat', isBot: false }, created_at: at(1) }),
    ]);
    expect(container.querySelector('.v2-thread-block--open')).toBeNull();
    expect(container.querySelector('.v2-thread-card__unread')).toHaveTextContent('1 new');
  });

  test('an answer from before the read-tracking epoch does not open an old thread', () => {
    const { container } = renderAsker([root(40), answer(41, 40, 1)], { readTrackingSince: at(30) });
    expect(container.querySelector('.v2-thread-block--open')).toBeNull();
    expect(container.querySelector('.v2-thread-card__unread')).toBeNull();
  });

  test('with no epoch (older server, failed fetch) nothing opens and nothing is marked unread', () => {
    const { container } = renderAsker([root(40), answer(41, 40, 1)], { readTrackingSince: '' });
    expect(container.querySelector('.v2-thread-block--open')).toBeNull();
    expect(container.querySelector('.v2-thread-card__unread')).toBeNull();
  });

  test('nothing opens before the thread state has loaded', () => {
    const { container } = renderAsker([root(40), answer(41, 40, 1)], {
      threadState: {
        byRoot: new Map(), toggleCollapsed: jest.fn(), setCollapsed: jest.fn(), toggleFollowing: jest.fn(), markRead: jest.fn(), ready: false,
      },
    });
    expect(container.querySelector('.v2-thread-block--open')).toBeNull();
  });

  test('at most three threads open themselves: the three with the newest answers', () => {
    const { container } = renderAsker([
      root(60), root(70), root(80), root(90),
      answer(61, 60, 1), answer(71, 70, 2), answer(81, 80, 3), answer(91, 90, 4),
    ]);
    const open = Array.from(container.querySelectorAll('.v2-thread-block--open'))
      .map((block) => block.querySelector('[id^="message-"]').id);
    expect(open).toEqual(['message-70', 'message-80', 'message-90']);
    // The oldest rests as a chip with its unread mark.
    expect(container.querySelectorAll('.v2-thread-card__unread')).toHaveLength(1);
  });

  test('a thread passed over by the cap stays a chip when a slot frees, until a newer agent reply', () => {
    const list = [
      root(60), root(70), root(80), root(90),
      answer(61, 60, 1), answer(71, 70, 2), answer(81, 80, 3), answer(91, 90, 4),
    ];
    const { container, rerenderWith } = renderAsker(list);
    const blockOf = (id) => container.querySelector(`#message-${id}`).closest('.v2-thread-block');
    // Close one of the three: a slot frees, and 60 still does not open.
    fireEvent.click(within(blockOf(90).querySelector('.v2-thread-replies__foot')).getByRole('button', { name: 'Collapse' }));
    expect(blockOf(60)).not.toHaveClass('v2-thread-block--open');
    rerenderWith([...list]);
    expect(blockOf(60)).not.toHaveClass('v2-thread-block--open');
    expect(blockOf(90)).not.toHaveClass('v2-thread-block--open');
    // A newer agent reply in 60 opens it.
    rerenderWith([...list, answer(62, 60, 9)]);
    expect(blockOf(60)).toHaveClass('v2-thread-block--open');
  });
});
