// @ts-nocheck
// The PRODUCER halves of the two changes @sprint-review found bare (64500,
// 64501): the landing effect that decides reveal-vs-fetch from the hash, and
// the write that persists a thread's open/closed state. The consumers were
// covered (V2ThreadRestyle hands `revealMessageId` straight to the
// transcript); nothing exercised the code that computes either.
import React from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';
import { useV2ThreadState } from '../hooks/useV2ThreadState';

jest.mock('../../context/SocketContext', () => ({ useSocket: () => ({ socket: null, connected: false }) }));
jest.mock('../components/V2Avatar', () => {
  const MockAvatar = () => <span data-testid="avatar" />;
  MockAvatar.displayName = 'MockAvatar';
  return MockAvatar;
});
jest.mock('../utils/avatars', () => ({ initialsFor: (name: string) => name.slice(0, 2) }));
beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

// `mock`-prefixed so the factory may close over them (jest hoists the mock).
const THREAD_ROW = { threadRootId: 7, collapsed: true, following: null };
const mockPut = jest.fn(() => Promise.resolve({}));
const mockGet = jest.fn(() => Promise.resolve({ podId: 'p1', defaults: { following: null }, threads: [THREAD_ROW] }));
// ONE object for every render: the hook's fetch effect depends on `api`, so a
// factory that builds a fresh object per call re-fetches on every render (66
// calls in 50ms when I got this wrong).
const mockApi = {
  get: (...args) => mockGet(...args),
  post: jest.fn(() => Promise.resolve({})),
  put: (...args) => mockPut(...args),
  patch: jest.fn(() => Promise.resolve({})),
  del: jest.fn(() => Promise.resolve({})),
};
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));

const authValue = {
  currentUser: { _id: 'u1', username: 'solo-user' },
  user: { _id: 'u1', username: 'solo-user' },
  token: 't',
  loading: false,
  isAuthenticated: true,
  error: null,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

const threadMessages = () => ([
  {
    id: 'm1', pod_id: 'p1', user_id: 'u2', content: 'Root of the thread', message_type: 'text', created_at: '2026-08-22T13:00:00Z', user: { username: 'teammate' },
  },
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `r${i}`, pod_id: 'p1', user_id: 'u3', thread_root_id: 'm1', content: `reply ${i}`, message_type: 'text', created_at: `2026-08-22T13:0${i}:00Z`, user: { username: 'other' },
  })),
]);

const makeDetail = (overrides = {}) => ({
  pod: { _id: 'p1', name: 'My Workspace', type: 'chat' },
  members: [{ _id: 'u1', username: 'solo-user', isBot: false }],
  messages: threadMessages(),
  agents: [],
  sendMessage: jest.fn(() => Promise.resolve({ _id: 'm1' })),
  loading: false,
  error: null,
  sendError: null,
  hasMore: true,
  loadingOlder: false,
  loadOlder: jest.fn(() => Promise.resolve()),
  refresh: jest.fn(),
  ...overrides,
});

const threadNode = (hash, detail) => (
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={[`/v2/pods/p1${hash}`]}>
      <V2Thread detail={detail} />
    </MemoryRouter>
  </AuthContext.Provider>
);
const renderAt = (hash, detail) => render(threadNode(hash, detail));

const setScrollMetrics = (element, scrollHeight, scrollTop) => {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(element, 'scrollTop', { configurable: true, writable: true, value: scrollTop });
};
const setRowContentTop = (container, messageId, contentTop) => {
  const row = container.querySelector(`#message-${messageId}`);
  if (!row) throw new Error(`row ${messageId} not mounted`);
  Object.defineProperty(container, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 0 }),
  });
  Object.defineProperty(row, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: contentTop - container.scrollTop }),
  });
};

describe('landing on a message decides reveal vs fetch (producer)', () => {
  test('a target folded inside a collapsed thread is revealed — the thread opens and NO history is fetched', async () => {
    const detail = makeDetail();
    const { container } = renderAt('#message-r2', detail);
    await waitFor(() => {
      expect(container.querySelector('.v2-thread-block--open')).toBeTruthy();
    });
    // r2 is outside the newest-eight window, so the fold must be cleared too.
    expect(container.querySelector('#message-r2')).toBeTruthy();
    expect(detail.loadOlder).not.toHaveBeenCalled();
  });

  test('a target that is nowhere in the loaded window pages older history instead', async () => {
    // Call count is deliberately not asserted: this fixture pins
    // `loadingOlder: false`, while the real hook flips it for the duration of
    // the fetch. What matters is that the fetch path is chosen at all.
    const detail = makeDetail();
    const { container } = renderAt('#message-999', detail);
    await waitFor(() => { expect(detail.loadOlder).toHaveBeenCalled(); });
    expect(container.querySelector('.v2-thread-block--open')).toBeNull();
  });

  test('does not search before the initial pod/message read settles', async () => {
    const searchOlderForMessage = jest.fn(() => Promise.resolve());
    const detail = makeDetail({
      messages: [],
      initialLoadComplete: false,
      searchOlderForMessage,
      historySearch: { targetId: null, status: 'idle', attempt: 0, maxAttempts: 5, error: null },
    });
    const view = renderAt('#message-999', detail);
    await act(async () => {});
    expect(searchOlderForMessage).not.toHaveBeenCalled();

    view.rerender(threadNode('#message-999', { ...detail, initialLoadComplete: true }));
    await waitFor(() => expect(searchOlderForMessage).toHaveBeenCalledWith('999'));
  });

  test('a target already on screen neither reveals nor fetches', async () => {
    const detail = makeDetail();
    const { container } = renderAt('#message-m1', detail);
    await waitFor(() => {
      expect(container.querySelector('#message-m1')).toHaveClass('v2-msg--landed');
    });
    expect(detail.loadOlder).not.toHaveBeenCalled();
    expect(container.querySelector('.v2-thread-block--open')).toBeNull();
  });

  test('a landed target stays protected until deliberate browsing resumes the sentinel', async () => {
    const loadOlder = jest.fn(() => Promise.resolve());
    const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    const PreviousObserver = global.IntersectionObserver;
    global.IntersectionObserver = class {
      callback: (entries: Array<{ isIntersecting: boolean }>) => void;
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        this.callback = callback;
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    } as any;
    try {
      const detail = makeDetail({ hasMore: true, loadOlder });
      const { container } = renderAt('#message-m1', detail);
      await waitFor(() => expect(container.querySelector('#message-m1')).toHaveClass('v2-msg--landed'));
      await act(async () => {
        callbacks.at(-1)?.([{ isIntersecting: true }]);
      });
      expect(loadOlder).not.toHaveBeenCalled();

      fireEvent.click(container.querySelector('button.v2-thread__edge-line'));
      expect(loadOlder).toHaveBeenCalledTimes(1);
      await act(async () => {
        callbacks.at(-1)?.([{ isIntersecting: true }]);
      });
      expect(loadOlder).toHaveBeenCalledTimes(2);
    } finally {
      global.IntersectionObserver = PreviousObserver;
    }
  });

  test('the automatic sentinel stays quiet after a target search stops even without a URL target', async () => {
    const loadOlder = jest.fn(() => Promise.resolve());
    const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    const PreviousObserver = global.IntersectionObserver;
    global.IntersectionObserver = class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    } as any;
    try {
      const detail = makeDetail({
        hasMore: true,
        loadOlder,
        historySearch: { targetId: 'missing', status: 'not-found', attempt: 5, maxAttempts: 5, error: null },
      });
      const { container } = renderAt('', detail);
      await waitFor(() => expect(container.querySelector('.v2-thread__history-status')).toHaveTextContent('keep browsing'));
      await act(async () => {
        callbacks.at(-1)?.([{ isIntersecting: true }]);
      });
      expect(loadOlder).not.toHaveBeenCalled();

      fireEvent.click(container.querySelector('button.v2-thread__edge-line'));
      expect(loadOlder).toHaveBeenCalledTimes(1);
      await act(async () => {
        callbacks.at(-1)?.([{ isIntersecting: true }]);
      });
      expect(loadOlder).toHaveBeenCalledTimes(2);
    } finally {
      global.IntersectionObserver = PreviousObserver;
    }
  });

  test('the automatic sentinel stays quiet during an active target search until deliberate browsing resumes it', async () => {
    const loadOlder = jest.fn(() => Promise.resolve());
    const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    const PreviousObserver = global.IntersectionObserver;
    global.IntersectionObserver = class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    } as any;
    try {
      const detail = makeDetail({
        hasMore: true,
        loadOlder,
        historySearch: { targetId: 'missing', status: 'searching', attempt: 1, maxAttempts: 5, error: null },
      });
      const { container } = renderAt('', detail);
      await waitFor(() => expect(container.querySelector('.v2-thread__history-status')).toHaveTextContent('Searching older messages'));
      await act(async () => {
        callbacks.at(-1)?.([{ isIntersecting: true }]);
      });
      expect(loadOlder).not.toHaveBeenCalled();

      fireEvent.click(container.querySelector('button.v2-thread__edge-line'));
      expect(loadOlder).toHaveBeenCalledTimes(1);
      await act(async () => {
        callbacks.at(-1)?.([{ isIntersecting: true }]);
      });
      expect(loadOlder).toHaveBeenCalledTimes(2);
    } finally {
      global.IntersectionObserver = PreviousObserver;
    }
  });

  test('history prepend restores the viewport after a background append without compensating for the append', async () => {
    let resolveLoadOlder;
    const loadOlder = jest.fn(() => new Promise((resolve) => { resolveLoadOlder = resolve; }));
    const initial = threadMessages();
    const arrival = {
      id: 'arrival', pod_id: 'p1', user_id: 'u4', content: 'peer arrival', message_type: 'text',
      created_at: '2026-08-22T15:00:00Z', user: { username: 'peer' },
    };
    const older = {
      id: 'older', pod_id: 'p1', user_id: 'u5', content: 'older page', message_type: 'text',
      created_at: '2026-08-22T12:00:00Z', user: { username: 'archivist' },
    };
    const detail = makeDetail({ messages: initial, loadOlder });
    const view = renderAt('', detail);
    const scroller = view.container.querySelector('.v2-chat__messages');
    setScrollMetrics(scroller, 1000, 400);
    setRowContentTop(scroller, 'm1', 1000);

    fireEvent.click(view.container.querySelector('button.v2-thread__edge-line'));
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1));
    expect(scroller.dataset.historyAnchor).toBe('active');

    // A socket append changes the list while the older-page request is still
    // pending. It must not move the reader or consume the prepend anchor. The
    // user also scrolls while waiting; that newer position must be retained.
    setScrollMetrics(scroller, 1100, 300);
    setRowContentTop(scroller, 'm1', 1000);
    view.rerender(threadNode('', { ...detail, messages: [...initial, arrival] }));
    expect(scroller.scrollTop).toBe(300);

    // The eventual prepend compensates only for its own 200px growth; the
    // 100px append was already folded into the anchor baseline.
    setScrollMetrics(scroller, 1300, 300);
    setRowContentTop(scroller, 'm1', 1200);
    view.rerender(threadNode('', { ...detail, messages: [older, ...initial, arrival] }));
    expect(scroller.scrollTop).toBe(500);
    expect(scroller.dataset.historyAnchor).toBeUndefined();
    await act(async () => { resolveLoadOlder('prepended'); });
  });

  test('a successful result waits for the committed prepend before consuming the anchor', async () => {
    let resolveLoadOlder;
    let callCount = 0;
    const loadOlder = jest.fn(() => {
      callCount += 1;
      if (callCount > 1) return Promise.resolve('noop');
      return new Promise((resolve) => { resolveLoadOlder = resolve; });
    });
    const initial = threadMessages();
    const older = {
      id: 'older', pod_id: 'p1', user_id: 'u5', content: 'older page', message_type: 'text',
      created_at: '2026-08-22T12:00:00Z', user: { username: 'archivist' },
    };
    const detail = makeDetail({ messages: initial, loadOlder });
    const view = renderAt('', detail);
    const scroller = view.container.querySelector('.v2-chat__messages');
    setScrollMetrics(scroller, 1000, 400);
    setRowContentTop(scroller, 'm1', 1000);

    // Two clicks can arrive before React commits the loading status. The
    // second must not replace the first request's anchor.
    const edge = view.container.querySelector('button.v2-thread__edge-line');
    fireEvent.click(edge);
    fireEvent.click(edge);
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(2));

    // Resolve the request before the fixture commits the new rows. A
    // post-await DOM fallback would clear the anchor too early here.
    await act(async () => { resolveLoadOlder('prepended'); });
    setScrollMetrics(scroller, 1200, 400);
    setRowContentTop(scroller, 'm1', 1200);
    view.rerender(threadNode('', { ...detail, messages: [older, ...initial] }));
    expect(scroller.scrollTop).toBe(600);
  });

  test('same-commit prepend plus append compensates only the existing row movement', async () => {
    let resolveLoadOlder;
    const loadOlder = jest.fn(() => new Promise((resolve) => { resolveLoadOlder = resolve; }));
    const initial = threadMessages();
    const arrival = {
      id: 'arrival', pod_id: 'p1', user_id: 'u4', content: 'peer arrival', message_type: 'text',
      created_at: '2026-08-22T15:00:00Z', user: { username: 'peer' },
    };
    const older = {
      id: 'older', pod_id: 'p1', user_id: 'u5', content: 'older page', message_type: 'text',
      created_at: '2026-08-22T12:00:00Z', user: { username: 'archivist' },
    };
    const detail = makeDetail({ messages: initial, loadOlder });
    const view = renderAt('', detail);
    const scroller = view.container.querySelector('.v2-chat__messages');
    setScrollMetrics(scroller, 1000, 400);
    setRowContentTop(scroller, 'm1', 1000);

    fireEvent.click(view.container.querySelector('button.v2-thread__edge-line'));
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1));

    // Both changes land in one React commit. Total scrollHeight grows by 350,
    // but the existing m1 row moves by only the 200px prepend growth.
    setScrollMetrics(scroller, 1350, 400);
    setRowContentTop(scroller, 'm1', 1200);
    view.rerender(threadNode('', { ...detail, messages: [older, ...initial, arrival] }));
    expect(scroller.scrollTop).toBe(600);
    await act(async () => { resolveLoadOlder('prepended'); });
  });

  test.each(['empty', 'failed'])('%s older-page result clears the anchor before a later prepend', async (outcome) => {
    let resolveLoadOlder;
    const loadOlder = jest.fn(() => new Promise((resolve) => { resolveLoadOlder = resolve; }));
    const initial = threadMessages();
    const arrival = {
      id: 'arrival', pod_id: 'p1', user_id: 'u4', content: 'peer arrival', message_type: 'text',
      created_at: '2026-08-22T15:00:00Z', user: { username: 'peer' },
    };
    const older = {
      id: 'older', pod_id: 'p1', user_id: 'u5', content: 'later older page', message_type: 'text',
      created_at: '2026-08-22T12:00:00Z', user: { username: 'archivist' },
    };
    const detail = makeDetail({ messages: initial, loadOlder });
    const view = renderAt('', detail);
    const scroller = view.container.querySelector('.v2-chat__messages');
    setScrollMetrics(scroller, 1000, 400);

    fireEvent.click(view.container.querySelector('button.v2-thread__edge-line'));
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1));
    expect(scroller.dataset.historyAnchor).toBe('active');
    await act(async () => { resolveLoadOlder(outcome); });
    expect(scroller.dataset.historyAnchor).toBeUndefined();

    // A no-prepend result must disarm the anchor; a later peer append should
    // not be interpreted as the missing prepend.
    setScrollMetrics(scroller, 1100, 400);
    view.rerender(threadNode('', { ...detail, messages: [...initial, arrival] }));
    expect(scroller.scrollTop).toBe(400);

    setScrollMetrics(scroller, 1300, 400);
    view.rerender(threadNode('', { ...detail, messages: [older, ...initial, arrival] }));
    expect(scroller.scrollTop).toBe(400);
  });

  test('history recovery stays anchored to the chat viewport, not the scrolled transcript', async () => {
    const detail = makeDetail({
      historySearch: { targetId: 'missing', status: 'failed', attempt: 2, maxAttempts: 5, error: 'offline' },
    });
    const { container } = renderAt('', detail);
    const status = await waitFor(() => {
      const element = container.querySelector('[role="alert"]');
      if (!element) throw new Error('history recovery status not mounted');
      return element;
    });
    expect(status).toHaveClass('v2-thread__history-status--viewport');
    expect(status.closest('.v2-chat__messages')).toBeNull();
    expect(container.querySelector('.v2-thread__transcript > .v2-chat__messages')).toBeTruthy();
  });

  test('legacy ?message= landing uses the same source reveal path', async () => {
    const detail = makeDetail();
    const { container } = renderAt('?message=r2', detail);
    await waitFor(() => {
      expect(container.querySelector('.v2-thread-block--open')).toBeTruthy();
      expect(container.querySelector('#message-r2')).toBeTruthy();
    });
    expect(detail.loadOlder).not.toHaveBeenCalled();
  });

  test('canonical hash wins when a legacy query target is also present', async () => {
    const detail = makeDetail();
    const { container } = renderAt('?message=r1#message-r2', detail);
    await waitFor(() => {
      expect(container.querySelector('#message-r2')).toBeTruthy();
    });
    expect(container.querySelector('#message-r1')).not.toHaveClass('v2-msg--landed');
    expect(detail.loadOlder).not.toHaveBeenCalled();
  });

  test('quoting the same folded reply again after collapse reopens it without fetching history', async () => {
    const detail = makeDetail({
      messages: [
        ...threadMessages(),
        {
          id: 'q', pod_id: 'p1', user_id: 'u4', content: 'follow-up', message_type: 'text',
          created_at: '2026-08-22T14:00:00Z', user: { username: 'quoter' },
          replyTo: { id: 'r2', username: 'other', content: 'reply 2' },
        },
      ],
    });
    const { container } = renderAt('#message-r2', detail);
    await waitFor(() => {
      expect(container.querySelector('.v2-thread-block--open')).toBeTruthy();
      expect(container.querySelector('#message-r2')).toBeTruthy();
    });

    fireEvent.click(container.querySelector('.v2-thread-replies__collapse'));
    await waitFor(() => {
      expect(container.querySelector('.v2-thread-block--open')).toBeNull();
    });

    fireEvent.click(container.querySelector('#message-q .v2-msg__quote'));
    await waitFor(() => {
      expect(container.querySelector('.v2-thread-block--open')).toBeTruthy();
      expect(container.querySelector('#message-r2')).toBeTruthy();
    });
    expect(detail.loadOlder).not.toHaveBeenCalled();
  });

  test('a reply visible before its older root loads remains flat after the prepend', async () => {
    const orphan = {
      id: 'orphan', pod_id: 'p1', user_id: 'u3', thread_root_id: 'old-root', content: 'orphan reply',
      message_type: 'text', created_at: '2026-08-22T12:00:00Z', user: { username: 'other' },
    };
    const initial = makeDetail({ messages: [orphan] });
    const view = renderAt('', initial);
    await waitFor(() => { expect(view.container.querySelector('#message-orphan')).toBeTruthy(); });

    const loaded = {
      ...initial,
      messages: [
        { id: 'old-root', pod_id: 'p1', user_id: 'u2', content: 'older root', message_type: 'text', created_at: '2026-08-22T11:00:00Z', user: { username: 'teammate' } },
        orphan,
      ],
    };
    view.rerender(threadNode('', loaded));
    await waitFor(() => { expect(view.container.querySelector('#message-orphan')).toBeTruthy(); });
    expect(view.container.querySelector('.v2-thread-block')).toBeNull();
  });
});

describe('opening or closing a thread persists (producer)', () => {
  const wrapper = ({ children }) => <>{children}</>;

  beforeEach(() => { mockPut.mockClear(); });

  test('setCollapsed writes the new value to the collapsed route', async () => {
    const { result } = renderHook(() => useV2ThreadState('p1'), { wrapper });
    await waitFor(() => { expect(result.current.byRoot.size).toBe(1); });

    act(() => { result.current.setCollapsed('7', false); });
    expect(mockPut).toHaveBeenCalledWith('/api/messages/7/collapsed', { collapsed: false });
    await waitFor(() => { expect(result.current.byRoot.get('7').collapsed).toBe(false); });

    act(() => { result.current.setCollapsed('7', true); });
    expect(mockPut).toHaveBeenLastCalledWith('/api/messages/7/collapsed', { collapsed: true });
  });

  test('a no-op and an unknown root write nothing — a 10-chip first load must not issue a bulk write', async () => {
    const { result } = renderHook(() => useV2ThreadState('p1'), { wrapper });
    await waitFor(() => { expect(result.current.byRoot.size).toBe(1); });

    act(() => { result.current.setCollapsed('7', true); });
    act(() => { result.current.setCollapsed('nope', false); });
    expect(mockPut).not.toHaveBeenCalled();
  });

  test('a failed write reverts the optimistic state', async () => {
    mockPut.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useV2ThreadState('p1'), { wrapper });
    await waitFor(() => { expect(result.current.byRoot.size).toBe(1); });

    act(() => { result.current.setCollapsed('7', false); });
    await waitFor(() => { expect(result.current.byRoot.get('7').collapsed).toBe(true); });
  });
});
