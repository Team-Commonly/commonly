// @ts-nocheck
import React from 'react';
import {
  act, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import axios from 'axios';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';

// SocketContext exports only the provider + hook (no raw context object),
// so mock the hook rather than wrapping a provider that would try to
// open a real socket.
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

jest.mock('../components/V2MessageRow', () => {
  const MockV2MessageRow = () => <div>Rendered message</div>;
  MockV2MessageRow.displayName = 'MockV2MessageRow';
  return MockV2MessageRow;
});

// jsdom has no scrollIntoView; the component auto-scrolls on mount.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
  Element.prototype.scrollTo = jest.fn();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
});

// Same mock surface as V2Login.test.tsx — axiosConfig assigns
// axios.defaults.baseURL at import time.
jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const authValue = {
  currentUser: { _id: 'u1', username: 'solo-user' },
  user: { _id: 'u1', username: 'solo-user' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const makeDetail = (overrides = {}) => ({
  pod: { _id: 'p1', name: 'My Workspace', type: 'chat' },
  members: [{ _id: 'u1', username: 'solo-user', isBot: false }],
  messages: [],
  agents: [],
  sendMessage: jest.fn(),
  loading: false,
  initialMessagesLoaded: true,
  error: null,
  refresh: jest.fn(),
  ...overrides,
});

const CurrentPath = () => <div data-testid="current-path">{useLocation().pathname}{useLocation().search}</div>;

const renderChat = (detail, props = {}) => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2Thread detail={detail} {...props} />
      <CurrentPath />
    </MemoryRouter>
  </AuthContext.Provider>,
);

const makeAgentRoom = (overrides = {}) => makeDetail({
  pod: { _id: 'agent-room-1', name: 'Aria', type: 'agent-room' },
  members: [
    { _id: 'u1', username: 'solo-user', isBot: false },
    { _id: 'agent-1', username: 'openclaw-aria', isBot: true },
  ],
  agents: [{ agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria' }],
  ...overrides,
});

describe('V2Thread teaching empty states', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    axios.post.mockResolvedValue({ data: {} });
  });

  test('regular empty pods teach visible membership and @-mentions', () => {
    renderChat(makeDetail());

    expect(screen.getByText('no messages yet')).toBeInTheDocument();
    // Direction C: the empty pod is one mono line; the composer (focused) carries the teaching.
    expect(screen.queryByText(/use @ to mention an agent or teammate/i)).not.toBeInTheDocument();
    expect(document.querySelector('.v2-thread__empty-line')).toHaveTextContent('no messages yet');
  });

  test('a failed first history read never shows a solo-pod invite', () => {
    renderChat(makeDetail({ initialLoadComplete: true, initialMessagesLoaded: false, error: 'Messages unavailable' }));
    expect(screen.queryByRole('button', { name: 'Copy invite link' })).not.toBeInTheDocument();
    expect(document.querySelector('.v2-teammate')).toBeNull();
  });

  test('the desktop meta labels the member faces with both counts; the phone head carries no counts', () => {
    const detail = makeDetail({
      agents: [{ agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria' }],
    });
    renderChat(detail);

    expect(document.querySelector('.v2-pod-header__meta--compact')).toBeNull();
    expect(document.querySelector('.v2-pod-header__faces')).toHaveAttribute('aria-label', '1 member, 1 agent');
  });

  test('multi-member regular pods use the same teaching state', () => {
    renderChat(makeDetail({
      members: [
        { _id: 'u1', username: 'solo-user', isBot: false },
        { _id: 'u2', username: 'teammate', isBot: false },
      ],
    }));

    expect(screen.getByText('no messages yet')).toBeInTheDocument();
  });

  test('a 1:1 room header carries a DM chip and none of the pod furniture', () => {
    renderChat(makeAgentRoom());

    const meta = document.querySelector('.v2-pod-header__meta:not(.v2-pod-header__meta--compact)');
    expect(meta).toHaveTextContent('DM');
    expect(document.querySelector('.v2-pod-header__faces')).toBeNull();
    expect(document.querySelector('.v2-pod-header__board')).toBeNull();
    expect(screen.queryByText('read only')).not.toBeInTheDocument();
  });

  test('an observer of an agent DM sees a read-only chip and note, and no composer', () => {
    renderChat(makeDetail({
      pod: { _id: 'agent-dm-1', name: 'Aria and Pixel', type: 'agent-dm' },
      members: [
        { _id: 'agent-1', username: 'Aria', isBot: true },
        { _id: 'agent-2', username: 'Pixel', isBot: true },
      ],
    }));

    const meta = document.querySelector('.v2-pod-header__meta:not(.v2-pod-header__meta--compact)');
    expect(meta).toHaveTextContent('DM');
    expect(meta).toHaveTextContent('read only');
    // The phone head draws "DM" alone (d215 390 frame).
    const compact = document.querySelector('.v2-pod-header__meta--compact');
    expect(compact).toHaveTextContent('DM');
    expect(compact).not.toHaveTextContent('read only');
    const note = screen.getByRole('note', { name: 'Read-only conversation' });
    expect(note).toHaveTextContent('Aria and Pixel are talking directly');
    expect(note.querySelector('.v2-chat__readonly-icon svg')).not.toBeNull();
    expect(screen.queryByPlaceholderText(/Message/)).not.toBeInTheDocument();
  });

  test('keeps the agent-to-agent empty state unchanged', () => {
    renderChat(makeDetail({
      pod: { _id: 'agent-dm-1', name: 'Aria and Pixel', type: 'agent-dm' },
      members: [
        { _id: 'agent-1', username: 'Aria', isBot: true },
        { _id: 'agent-2', username: 'Pixel', isBot: true },
      ],
    }));

    expect(screen.getByText("Aria and Pixel haven't talked yet")).toBeInTheDocument();
    expect(screen.getByText("They'll DM each other when one of them needs the other's help.")).toBeInTheDocument();
  });
});

describe('V2Thread starter prompts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    axios.post.mockResolvedValue({ data: {} });
  });

  test('render for an empty agent room after first-run and never auto-send', async () => {
    const detail = makeAgentRoom();
    renderChat(detail);

    const prompt = screen.getByRole('button', {
      name: 'Introduce yourself — what are you best at?',
    });
    expect(screen.getByRole('group', { name: 'Conversation starters' })).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: "Here's what I'm working on — where can you help?",
    })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'What should I ask you first?' })).toBeInTheDocument();

    fireEvent.click(prompt);

    const composer = screen.getByPlaceholderText('Message Aria…');
    expect(composer).toHaveValue('Introduce yourself — what are you best at?');
    await waitFor(() => expect(composer).toHaveFocus());
    expect(detail.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Conversation starters' })).not.toBeInTheDocument();
  });

  test('also render for a writable human-agent DM', () => {
    renderChat(makeAgentRoom({
      pod: { _id: 'agent-dm-1', name: 'Aria DM', type: 'agent-dm' },
    }));

    expect(screen.getByRole('group', { name: 'Conversation starters' })).toBeInTheDocument();
  });

  test('hide after a message exists or while the first-run hero is visible', () => {
    const withMessage = renderChat(makeAgentRoom({
      messages: [{ id: 'm1', content: 'Hello', user: { username: 'Aria' } }],
    }));
    expect(screen.queryByRole('group', { name: 'Conversation starters' })).not.toBeInTheDocument();
    withMessage.unmount();

    renderChat(makeAgentRoom(), { firstRunVisible: true });
    expect(screen.queryByRole('group', { name: 'Conversation starters' })).not.toBeInTheDocument();
  });
});

describe('V2Thread agent-room liveness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockResolvedValue({ data: { agents: [] } });
  });

  test('an unknown reach state shows no row, so a failed status read never reads as offline', async () => {
    axios.get.mockResolvedValue({
      data: {
        agents: [{
          agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria', state: 'unknown', isOwner: true, fixCommand: 'commonly agent run aria',
        }],
      },
    });
    renderChat(makeAgentRoom());

    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('agent-room-liveness')).not.toBeInTheDocument();
  });

  test('a gone-dark direct seat gets the line with no command, even for its owner', async () => {
    axios.get.mockResolvedValue({
      data: {
        agents: [{
          agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria', state: 'gone-dark', isOwner: true, fixCommand: 'commonly agent run aria',
        }],
      },
    });
    renderChat(makeAgentRoom());

    expect(await screen.findByTestId('agent-room-liveness')).toHaveTextContent("Aria hasn't checked in recently");
    expect(screen.queryByTestId('agent-room-fix-command')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy command' })).not.toBeInTheDocument();
  });

  test('a never-connected direct seat says so and shows the owner the command to run', async () => {
    axios.get.mockResolvedValue({
      data: {
        agents: [{
          agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria', state: 'never-connected', isOwner: true, fixCommand: 'commonly agent run aria',
        }],
      },
    });
    renderChat(makeAgentRoom());

    const banner = await screen.findByTestId('agent-room-liveness');
    expect(banner).toHaveTextContent("Aria isn't connected yet");
    expect(screen.getByTestId('agent-room-fix-command')).toHaveTextContent('commonly agent run aria');
  });

  test('the owner copies the fix command with one key, which confirms the copy', async () => {
    navigator.clipboard.writeText.mockClear();
    axios.get.mockResolvedValue({
      data: {
        agents: [{
          agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria', state: 'never-connected', isOwner: true, fixCommand: 'commonly agent run aria',
        }],
      },
    });
    renderChat(makeAgentRoom());

    fireEvent.click(await screen.findByRole('button', { name: 'Copy command' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('commonly agent run aria'));
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  test('a never-connected direct seat shows a non-owner no command', async () => {
    axios.get.mockResolvedValue({
      data: {
        agents: [{
          agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria', state: 'never-connected', isOwner: false,
        }],
      },
    });
    renderChat(makeAgentRoom());

    expect(await screen.findByTestId('agent-room-liveness')).toHaveTextContent("Aria isn't connected yet");
    expect(screen.queryByTestId('agent-room-fix-command')).not.toBeInTheDocument();
  });

  test('a live direct seat shows a wait until it replies', async () => {
    axios.get.mockResolvedValue({
      data: {
        agents: [{
          agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria', state: 'listening', isOwner: false,
        }],
      },
    });
    const sent = {
      id: 'outgoing-1',
      pod_id: 'agent-room-1',
      user_id: 'u1',
      content: 'Hello Aria',
      message_type: 'text',
      created_at: new Date().toISOString(),
      user: { username: 'solo-user', isBot: false },
    };
    const detail = makeAgentRoom({ sendMessage: jest.fn().mockResolvedValue(sent) });
    const view = renderChat(detail);

    fireEvent.change(screen.getByPlaceholderText('Message Aria…'), { target: { value: 'Hello Aria' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByTestId('agent-reply-wait')).toHaveTextContent('Waiting for Aria to reply');
    expect(screen.getByTestId('agent-reply-wait').querySelector('.v2-chat__agent-room-status-dot')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-room-liveness')).not.toBeInTheDocument();

    const reply = {
      id: 'agent-reply-1',
      pod_id: 'agent-room-1',
      user_id: 'agent-1',
      content: 'Hi!',
      message_type: 'text',
      created_at: new Date(Date.now() + 1_000).toISOString(),
      user: { username: 'openclaw-aria', isBot: true },
    };
    view.rerender(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter>
          <V2Thread detail={{ ...detail, messages: [sent, reply] }} />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(screen.queryByTestId('agent-reply-wait')).not.toBeInTheDocument());
  });

  test('turns an unanswered direct-message wait into a timeout message', async () => {
    jest.useFakeTimers();
    axios.get.mockResolvedValue({
      data: {
        agents: [{
          agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria', state: 'listening', isOwner: false,
        }],
      },
    });
    const sent = {
      id: 'outgoing-timeout',
      pod_id: 'agent-room-1',
      user_id: 'u1',
      content: 'Hello Aria',
      message_type: 'text',
      created_at: new Date().toISOString(),
      user: { username: 'solo-user', isBot: false },
    };
    renderChat(makeAgentRoom({ sendMessage: jest.fn().mockResolvedValue(sent) }));

    fireEvent.change(screen.getByPlaceholderText('Message Aria…'), { target: { value: 'Hello Aria' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await Promise.resolve();
    });
    expect(screen.getByTestId('agent-reply-wait')).toHaveTextContent('Waiting for Aria to reply');

    expect(screen.getByTestId('agent-reply-wait')).toHaveClass('v2-chat__agent-room-status--wait');

    act(() => { jest.advanceTimersByTime(120_000); });
    const timedOut = screen.getByTestId('agent-reply-wait');
    expect(timedOut).toHaveTextContent("Aria hasn't replied yet");
    // Timed out drops the pulsing dot and the mono face (d215 frame).
    expect(timedOut.querySelector('.v2-chat__agent-room-status-dot')).toBeNull();
    expect(timedOut).not.toHaveClass('v2-chat__agent-room-status--wait');
    jest.useRealTimers();
  });
});

describe('V2Thread just-created Pod starter panel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    axios.post.mockResolvedValue({ data: {} });
    axios.get.mockResolvedValue({ data: {} });
  });

  test('renders one-click hosted and bring-your-own buttons with no subtitle copy', async () => {
    const token = 'd'.repeat(32);
    sessionStorage.setItem('v2.justCreated.p1', '1');
    axios.post.mockResolvedValueOnce({ data: { token } });
    axios.get.mockImplementation((url) => Promise.resolve({
      data: url === '/api/hosted/pod-start-availability' ? { configured: true } : {},
    }));
    renderChat(makeDetail());

    expect(await screen.findByText('Your pod is ready')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Run it here' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bring your own' })).toBeInTheDocument();
    expect(screen.queryByText('Bring in people or an agent, or start the conversation yourself.')).not.toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }));
    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        '/api/pods/p1/invites',
        {},
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    const inviteUrl = `${window.location.origin}/v2/invite/${token}`;
    expect(await screen.findByLabelText('Invite link for this pod')).toHaveValue(inviteUrl);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(inviteUrl));

    fireEvent.click(screen.getByRole('button', { name: 'Run it here' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/registry/install',
      expect.objectContaining({
        agentName: 'solo-user-p1', podId: 'p1', config: { runtime: { runtimeType: 'hosted' } },
      }),
      expect.any(Object),
    ));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/hosted/provision', { agentName: 'solo-user-p1' }, expect.any(Object),
    ));
    expect(screen.getByRole('button', { name: 'Starting agent…' })).toBeDisabled();
  });

  test('bring-your-own opens setup with this pod selected when hosting is unavailable', async () => {
    sessionStorage.setItem('v2.justCreated.p1', '1');
    axios.post.mockResolvedValueOnce({ data: { token: 'b'.repeat(32) } });
    axios.get.mockResolvedValue({ data: { configured: false } });
    renderChat(makeDetail());

    expect(await screen.findByRole('button', { name: 'Bring your own' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run it here' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Bring your own' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/agents/byo?pod=p1');
  });

  test('native hosted status marks the agent running after the one-click start', async () => {
    sessionStorage.setItem('v2.justCreated.p1', '1');
    axios.post.mockResolvedValueOnce({ data: { token: 'c'.repeat(32) } });
    axios.get.mockImplementation((url) => Promise.resolve({
      data: url === '/api/hosted/pod-start-availability'
        ? { configured: true }
        : url.startsWith('/api/hosted/status?') ? { runtime: { ready: true } } : {},
    }));
    const detail = makeDetail();
    renderChat(detail);

    fireEvent.click(await screen.findByRole('button', { name: 'Run it here' }));
    expect(await screen.findByRole('button', { name: 'Agent running' })).toBeInTheDocument();
    expect(detail.refresh).toHaveBeenCalled();
  });

  test('a delayed hosted status from another pod cannot mark this pod running', async () => {
    sessionStorage.setItem('v2.justCreated.p1', '1');
    sessionStorage.setItem('v2.justCreated.p2', '1');
    let resolveStatus;
    const delayedStatus = new Promise((resolve) => { resolveStatus = resolve; });
    axios.post.mockResolvedValue({ data: { token: 'f'.repeat(32) } });
    axios.get.mockImplementation((url) => {
      if (url === '/api/hosted/pod-start-availability') return Promise.resolve({ data: { configured: true } });
      if (url.startsWith('/api/hosted/status?')) return delayedStatus;
      return Promise.resolve({ data: {} });
    });
    const wrap = (detail) => (
      <AuthContext.Provider value={authValue}>
        <MemoryRouter><V2Thread detail={detail} /></MemoryRouter>
      </AuthContext.Provider>
    );
    const view = render(wrap(makeDetail()));
    fireEvent.click(await screen.findByRole('button', { name: 'Run it here' }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(
      '/api/hosted/status?agentName=solo-user-p1', expect.any(Object),
    ));

    view.rerender(wrap(makeDetail({ pod: { _id: 'p2', name: 'Second', type: 'chat' } })));
    expect(await screen.findByRole('button', { name: 'Run it here' })).toBeEnabled();
    await act(async () => { resolveStatus({ data: { runtime: { ready: true } } }); });
    expect(screen.getByRole('button', { name: 'Run it here' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Agent running' })).not.toBeInTheDocument();
  });

  test('stays absent without the flag or after messages arrive', async () => {
    const noFlag = renderChat(makeDetail());
    expect(screen.queryByText('Your pod is ready')).not.toBeInTheDocument();
    expect(screen.getByText('no messages yet')).toBeInTheDocument();
    noFlag.unmount();

    sessionStorage.setItem('v2.justCreated.p1', '1');
    const withMessage = renderChat(makeDetail({
      messages: [{ id: 'm1', content: 'First!', user: { username: 'solo-user' } }],
    }));
    expect(screen.queryByText('Your pod is ready')).not.toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem('v2.justCreated.p1')).toBeNull());
    withMessage.unmount();
  });

  test('keeps the first-run modal ahead of the starter panel without minting an invite', () => {
    sessionStorage.setItem('v2.justCreated.p1', '1');
    renderChat(makeDetail(), { firstRunVisible: true });

    expect(screen.queryByText('Your pod is ready')).not.toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('does not mint an invite when the starter panel does not render', () => {
    renderChat(makeDetail());

    expect(screen.queryByText('Your pod is ready')).not.toBeInTheDocument();
    expect(screen.getByText('no messages yet')).toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('dismisses explicitly and clears the session flag', async () => {
    sessionStorage.setItem('v2.justCreated.p1', '1');
    axios.post.mockResolvedValueOnce({ data: { token: 'e'.repeat(32) } });
    renderChat(makeDetail());

    expect(await screen.findByText('Your pod is ready')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss starter actions' }));

    expect(screen.queryByText('Your pod is ready')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('v2.justCreated.p1')).toBeNull();
  });
});

describe('second-person prompt placements', () => {
  beforeEach(() => {
    jest.clearAllMocks(); sessionStorage.clear(); localStorage.clear();
    axios.post.mockReset();
    navigator.clipboard.writeText.mockReset().mockResolvedValue(undefined);
    axios.get.mockImplementation((url) => Promise.resolve({ data: /\/invites$/.test(url) ? [] : {} }));
  });
  const member = { _id: 'u1', username: 'solo-user', isBot: false };
  const agent = { _id: 'bot', username: 'scout', isBot: true };
  const messages = [
    { id: '10', pod_id: 'p1', user_id: 'u1', content: 'Help with this launch', message_type: 'text', created_at: '2026-10-25T10:00:00Z', user: { username: 'solo-user', isBot: false } },
    { id: '11', pod_id: 'p1', user_id: 'bot', content: 'Here is the first plan', message_type: 'text', created_at: '2026-10-25T10:01:00Z', user: { username: 'scout', isBot: true } },
  ];
  const withReply = (pod = { _id: 'p1', name: 'Launch', type: 'chat' }) => makeDetail({
    pod, members: [member, agent], messages, hasMore: false,
    agents: [{ agentName: 'scout', instanceId: 'default', status: 'active', displayName: 'Scout' }],
  });
  test('the empty state offers the card without minting or taking composer focus', async () => {
    renderChat(makeDetail());
    expect(await screen.findByRole('region', { name: 'Invite a teammate to My Workspace' })).toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveFocus();
  });
  test('the group reply offers one prompt and joining a second human removes it', async () => {
    const detail = withReply();
    const view = renderChat(detail);
    expect(await screen.findByText(/They can work with Scout too/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy invite link' })).toHaveLength(1);
    view.rerender(<AuthContext.Provider value={authValue}><MemoryRouter>
      <V2Thread detail={{ ...detail, members: [...detail.members, { _id: 'other', isBot: false }] }} />
    </MemoryRouter></AuthContext.Provider>);
    expect(screen.queryByRole('button', { name: 'Copy invite link' })).not.toBeInTheDocument();
  });
  test('socket messages after a failed initial history read do not qualify as the first reply', () => {
    const failed = makeDetail({ initialLoadComplete: true, initialMessagesLoaded: false, error: 'History unavailable', hasMore: false });
    const view = renderChat(failed);
    const liveDetail = { ...withReply(), initialMessagesLoaded: false, error: 'History unavailable' };
    view.rerender(<AuthContext.Provider value={authValue}><MemoryRouter><V2Thread detail={liveDetail} /></MemoryRouter></AuthContext.Provider>);
    expect(screen.getAllByText('Rendered message')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Copy invite link' })).not.toBeInTheDocument();
  });

  test('Lily’s Drop B ruling suppresses the automatic card in Scout’s owned workspace', async () => {
    const detail = withReply({ _id: 'p1', name: 'My Workspace', type: 'chat', createdBy: { _id: 'u1' } });
    const username = 'scout-u0123456789';
    detail.agents = [{ agentName: 'scout', instanceId: 'u0123456789', status: 'active', displayName: 'Scout' }];
    detail.members = [member, { ...agent, username }];
    detail.messages = [messages[0], { ...messages[1], user: { username, isBot: true } }];
    renderChat(detail);
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('.v2-teammate')).toBeNull();
    expect(axios.get.mock.calls.filter(([url]) => url.endsWith('/invites'))).toHaveLength(0);
    expect(axios.post).not.toHaveBeenCalled();
  });
  test('a pending invite press completes once across expanding and collapsing its thread', async () => {
    let finish;
    axios.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const detail = withReply();
    detail.messages = [messages[0], { ...messages[1], thread_root_id: '10' }];
    renderChat(detail);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy invite link' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Expand thread, 1 reply' }));
    expect(screen.getByRole('button', { name: 'Creating link…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    await act(async () => { finish({ data: { token: 'a'.repeat(32) } }); });
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${window.location.origin}/v2/invite/${'a'.repeat(32)}`);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  // TASK-583: on a reload the card mounts after history settles, below where
  // the arrival effect already followed. A follow scrolls the message list
  // itself; scrollIntoView would also scroll the overflow-hidden main pane and
  // take the whole thread off screen (UX Lead on #2870), so it must never run.
  const endFollows = () => Element.prototype.scrollTo.mock.contexts
    .filter((el) => el.classList.contains('v2-chat__messages')).length;
  const clearScrolls = () => {
    Element.prototype.scrollTo.mockClear();
    Element.prototype.scrollIntoView.mockClear();
  };
  const rerenderChat = (view, detail) => view.rerender(<AuthContext.Provider value={authValue}><MemoryRouter>
    <V2Thread detail={detail} />
  </MemoryRouter></AuthContext.Provider>);
  // `byReader` fires the reader's own input first. Without it, the scroll is
  // treated as part of the app's smooth follow, as in a real browser.
  const scrollListTo = (scrollTop, { byReader = true } = {}) => {
    const list = document.querySelector('.v2-chat__messages');
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    if (byReader) fireEvent.wheel(list);
    list.scrollTop = scrollTop;
    fireEvent.scroll(list);
  };
  test('when the invite card mounts with the reader at the end, the thread follows it into view', async () => {
    const settled = withReply();
    const view = renderChat({ ...settled, hasMore: true });
    expect(document.querySelector('.v2-teammate')).toBeNull();
    scrollListTo(1600);
    clearScrolls();
    rerenderChat(view, settled);
    expect(await screen.findByRole('button', { name: 'Copy invite link' })).toBeInTheDocument();
    expect(endFollows()).toBe(1);
    expect(Element.prototype.scrollTo.mock.calls.at(-1)[0]).toEqual({ top: 2000, behavior: 'smooth' });
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
  // UX Lead on e0fd1523: the open-time follow is a smooth scroll whose own
  // mid-animation scroll events read as the reader scrolling up, so a card
  // mounting after the first of them was skipped and the list stopped one card
  // short. 6 of 18 opens at 1440.
  test('a card that mounts while a follow is still animating is still followed', async () => {
    const settled = withReply();
    const arrived = { ...settled, messages: [...settled.messages, {
      id: '12', pod_id: 'p1', user_id: 'bot', content: 'And a second step', message_type: 'text',
      created_at: '2026-10-25T10:02:00Z', user: { username: 'scout', isBot: true },
    }] };
    const view = renderChat({ ...settled, hasMore: true });
    scrollListTo(1600);
    clearScrolls();
    // An arrival at the end starts a smooth follow...
    rerenderChat(view, { ...arrived, hasMore: true });
    expect(endFollows()).toBe(1);
    clearScrolls();
    // ...whose first animation frame is still far from the end. That is the
    // app scrolling, not the reader (no wheel/touch/key/pointer input).
    scrollListTo(800, { byReader: false });
    rerenderChat(view, arrived);
    expect(await screen.findByRole('button', { name: 'Copy invite link' })).toBeInTheDocument();
    expect(endFollows()).toBe(1);
  });
  test('a reader scrolled up stays put when the invite card mounts', async () => {
    const settled = withReply();
    const view = renderChat({ ...settled, hasMore: true });
    scrollListTo(100);
    clearScrolls();
    rerenderChat(view, settled);
    expect(await screen.findByRole('button', { name: 'Copy invite link' })).toBeInTheDocument();
    expect(endFollows()).toBe(0);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  test('dismissing the state-owned invite leaves the transcript and composer mounted', async () => {
    renderChat(withReply());
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('button', { name: 'Copy invite link' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Rendered message')).toHaveLength(2);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

});
