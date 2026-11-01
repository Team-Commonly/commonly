// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useV2PodDetail } from '../hooks/useV2PodDetail';
import V2MessageRow, { CollapsiblePre, CollapsibleProse, LIVE_ENTER_WINDOW_MS } from '../components/V2MessageRow';
import V2ThreadMessages from '../components/V2ThreadMessages';
import { buildThreadView } from '../utils/threadView';

// Chat motion: a live arrival enters, history appears at once, Show more folds
// by class, and the content that replaces the loader fades in once.

const mockApi = { get: jest.fn(), post: jest.fn(), patch: jest.fn(), del: jest.fn() };
const mockSocket = { on: jest.fn(), off: jest.fn() };

jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: mockSocket, connected: true, joinPod: jest.fn(), leavePod: jest.fn() }),
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human-1', username: 'viewer' } }),
}));

const message = (id, minute, extra = {}) => ({
  id,
  pod_id: 'pod-1',
  user_id: 'agent-1',
  content: `text ${id}`,
  message_type: 'text',
  created_at: new Date(Date.UTC(2026, 9, 19, 12, minute)).toISOString(),
  user: { username: 'scout' },
  ...extra,
});

const latestNewMessageHandler = () => mockSocket.on.mock.calls
  .filter(([event]) => event === 'newMessage')
  .at(-1)[1];

// The real hook feeding real rows, so the test exercises the live path the
// socket takes rather than a hand-set flag.
const Transcript = () => {
  const { messages } = useV2PodDetail('pod-1');
  return <MemoryRouter>{messages.map((m) => <V2MessageRow key={m.id} message={m} />)}</MemoryRouter>;
};

const row = (id) => document.getElementById(`message-${id}`);

describe('chat motion: a live message enters, history does not', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/messages/pod-1?limit=50') return Promise.resolve([message('history', 0)]);
      if (url.startsWith('/api/messages/pod-1?limit=50&before=')) return Promise.resolve([message('older', -5)]);
      if (url.includes('/agents')) return Promise.resolve({ agents: [] });
      return Promise.resolve({ _id: 'pod-1', name: 'Pod', members: [] });
    });
  });

  it('gives the enter class to a socket arrival and never to the opened history', async () => {
    render(<Transcript />);
    await waitFor(() => expect(row('history')).not.toBeNull());
    expect(row('history')).not.toHaveClass('v2-msg--enter');

    act(() => { latestNewMessageHandler()(message('live', 1)); });
    expect(row('live')).toHaveClass('v2-msg--enter');
    expect(row('history')).not.toHaveClass('v2-msg--enter');
  });

  it('does not animate a socket copy of a row that is already on screen', async () => {
    render(<Transcript />);
    await waitFor(() => expect(row('history')).not.toBeNull());
    const before = row('history');
    act(() => { latestNewMessageHandler()(message('history', 0)); });
    expect(row('history')).toBe(before);
    expect(row('history')).not.toHaveClass('v2-msg--enter');
  });

  it('marks only live arrivals in the hook; history and older pages carry no flag', async () => {
    let detail;
    const Probe = () => { detail = useV2PodDetail('pod-1'); return null; };
    render(<Probe />);
    await waitFor(() => expect(detail.initialLoadComplete).toBe(true));
    act(() => { latestNewMessageHandler()(message('live', 1)); });
    await act(async () => { await detail.loadOlder(); });
    const flags = Object.fromEntries(detail.messages.map((m) => [m.id, typeof m.liveArrivedAt === 'number']));
    expect(flags).toEqual({ older: false, history: false, live: true });
  });

  it('marks your own sent message live, so it gets the same 4px enter and nothing more', async () => {
    mockApi.post.mockResolvedValue(message('mine', 2, { user_id: 'human-1', user: { username: 'viewer' } }));
    let detail;
    const Probe = () => { detail = useV2PodDetail('pod-1'); return null; };
    render(<Probe />);
    await waitFor(() => expect(detail.initialLoadComplete).toBe(true));
    await act(async () => { await detail.sendMessage('hello'); });
    expect(typeof detail.messages.find((m) => m.id === 'mine').liveArrivedAt).toBe('number');
  });
});

describe('chat motion: the row decides once, at mount', () => {
  const renderRow = (m) => render(<MemoryRouter><V2MessageRow message={m} /></MemoryRouter>);

  it('a re-render that drops the live flag keeps the row as it is and does not restart the enter', () => {
    const live = message('a', 1, { liveArrivedAt: Date.now() });
    const view = renderRow(live);
    const node = row('a');
    expect(node).toHaveClass('v2-msg--enter');
    view.rerender(<MemoryRouter><V2MessageRow message={{ ...live, liveArrivedAt: undefined, content: 'refetched' }} /></MemoryRouter>);
    expect(row('a')).toBe(node);
    expect(node).toHaveClass('v2-msg--enter');
  });

  it('a history row that later gains a flag does not start entering', () => {
    const history = message('b', 1);
    const view = renderRow(history);
    view.rerender(<MemoryRouter><V2MessageRow message={{ ...history, liveArrivedAt: Date.now() }} /></MemoryRouter>);
    expect(row('b')).not.toHaveClass('v2-msg--enter');
  });

  it('a row that remounts after the enter window (a root moving into a thread) does not replay', () => {
    renderRow(message('c', 1, { liveArrivedAt: Date.now() - LIVE_ENTER_WINDOW_MS - 1 }));
    expect(row('c')).not.toHaveClass('v2-msg--enter');
  });
});

describe('chat motion: Show more folds by class, never by measured height', () => {
  const setScrollHeight = (px) => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => px });
  };
  afterEach(() => setScrollHeight(0));

  it('a folding prose keeps its fold class open and closed, toggles only the closed class, and sets no inline size', () => {
    setScrollHeight(900);
    const { container } = render(
      <CollapsibleProse collapsible><div className="v2-msg__content">long reply</div></CollapsibleProse>,
    );
    const wrapper = container.querySelector('.v2-msg__prose');
    expect(wrapper).toHaveClass('v2-msg__prose--fold', 'v2-msg__prose--closed');
    const button = screen.getByRole('button', { name: 'Show more' });

    fireEvent.click(button);
    expect(wrapper).toHaveClass('v2-msg__prose--fold');
    expect(wrapper).not.toHaveClass('v2-msg__prose--closed');
    expect(button).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(button);
    expect(wrapper).toHaveClass('v2-msg__prose--fold', 'v2-msg__prose--closed');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // The motion is CSS sizing to auto; JS never writes a height.
    expect(wrapper.getAttribute('style')).toBeNull();
  });

  it('a short prose gets no fold class, so it never transitions', () => {
    setScrollHeight(60);
    const { container } = render(
      <CollapsibleProse collapsible><div className="v2-msg__content">short</div></CollapsibleProse>,
    );
    expect(container.querySelector('.v2-msg__prose')).not.toHaveClass('v2-msg__prose--fold');
  });

  it('long code opens and closes by the collapse classes', () => {
    const code = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const { container } = render(<CollapsiblePre><code>{`${code}\n`}</code></CollapsiblePre>);
    const box = container.querySelector('.v2-msg__collapse');
    expect(box).toHaveClass('v2-msg__collapse--closed');
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(box).toHaveClass('v2-msg__collapse--open');
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(box).toHaveClass('v2-msg__collapse--closed');
    expect(container.querySelector('pre').getAttribute('style')).toBeNull();
  });
});

describe('chat motion: content replacing the loader fades in once', () => {
  const renderTranscript = (props) => {
    const threadView = buildThreadView(props.messages, new Map());
    return (
      <MemoryRouter>
        <V2ThreadMessages
          threadView={threadView}
          threadState={{ byRoot: new Map(), toggleCollapsed: jest.fn(), toggleFollowing: jest.fn() }}
          decisionByMessageId={new Map()}
          settledDecisionByMessageId={new Map()}
          agentDisplayNames={new Map()}
          agentAuthorKeys={new Set()}
          onAimAtThread={jest.fn()}
          hasMore={false}
          loadingOlder={false}
          onLoadOlder={jest.fn()}
          error={null}
          messagesContainerRef={React.createRef()}
          messagesEndRef={React.createRef()}
          {...props}
        />
      </MemoryRouter>
    );
  };
  const scroller = (container) => container.querySelector('.v2-chat__messages');

  it('fades the transcript in when it replaces the spinner, and a later render does not restart it', () => {
    const view = render(renderTranscript({ messages: [], loading: true }));
    expect(view.container.querySelector('.v2-spinner')).not.toBeNull();
    expect(scroller(view.container)).not.toHaveClass('v2-chat__messages--reveal');

    view.rerender(renderTranscript({ messages: [message('h', 0)], loading: false }));
    expect(view.container.querySelector('.v2-spinner')).toBeNull();
    expect(scroller(view.container)).toHaveClass('v2-chat__messages--reveal');

    // A re-render keeps the same class on the same node, so the animation does not restart.
    const node = scroller(view.container);
    view.rerender(renderTranscript({ messages: [message('h', 0), message('n', 1)], loading: false }));
    expect(scroller(view.container)).toBe(node);
    expect(node).toHaveClass('v2-chat__messages--reveal');
  });

  it('content that never waited on a spinner appears at once', () => {
    const view = render(renderTranscript({ messages: [message('h', 0)], loading: false }));
    expect(scroller(view.container)).not.toHaveClass('v2-chat__messages--reveal');
    // A refresh with rows already on screen shows no spinner, so nothing fades.
    view.rerender(renderTranscript({ messages: [message('h', 0)], loading: true }));
    view.rerender(renderTranscript({ messages: [message('h', 0)], loading: false }));
    expect(scroller(view.container)).not.toHaveClass('v2-chat__messages--reveal');
  });
});
