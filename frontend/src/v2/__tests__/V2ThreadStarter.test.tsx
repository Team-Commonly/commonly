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

  test('compact header shows singular agents and names both counts for assistive tech', () => {
    const detail = makeDetail({
      agents: [{ agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria' }],
    });
    renderChat(detail);

    const compact = screen.getByRole('group', { name: '1 member, 1 agent' });
    expect(compact).toHaveTextContent('1 · 1 agent');
    expect(compact.querySelector('[aria-hidden="true"]')).toHaveTextContent('1 · 1 agent');
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

  test('shows an unknown direct seat before the person sends a message', async () => {
    axios.get.mockResolvedValue({
      data: {
        agents: [{
          agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria', state: 'unknown', isOwner: false,
        }],
      },
    });
    renderChat(makeAgentRoom());

    expect(await screen.findByTestId('agent-room-liveness')).toHaveTextContent(
      "Aria's availability is unknown",
    );
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

    act(() => { jest.advanceTimersByTime(120_000); });
    expect(screen.getByTestId('agent-reply-wait')).toHaveTextContent("Aria hasn't replied yet");
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

  test('Scout’s owned workspace discloses the conversation being shared', async () => {
    const detail = withReply({ _id: 'p1', name: 'My Workspace', type: 'chat', createdBy: { _id: 'u1' } });
    const username = 'scout-u0123456789';
    detail.agents = [{ agentName: 'scout', instanceId: 'u0123456789', status: 'active', displayName: 'Scout' }];
    detail.members = [member, { ...agent, username }];
    detail.messages = [messages[0], { ...messages[1], user: { username, isBot: true } }];
    renderChat(detail);
    expect(await screen.findByText(/including this conversation with Scout/)).toBeInTheDocument();
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

  test('dismissing the state-owned invite leaves the transcript and composer mounted', async () => {
    renderChat(withReply());
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('button', { name: 'Copy invite link' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Rendered message')).toHaveLength(2);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

});
