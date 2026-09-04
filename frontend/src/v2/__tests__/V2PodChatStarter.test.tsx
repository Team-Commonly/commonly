// @ts-nocheck
import React from 'react';
import {
  act, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import V2PodChat from '../components/V2PodChat';
import { AuthContext } from '../../context/AuthContext';

// SocketContext exports only the provider + hook (no raw context object),
// so mock the hook rather than wrapping a provider that would try to
// open a real socket.
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

jest.mock('../components/V2MessageBubble', () => {
  const MockV2MessageBubble = () => <div>Rendered message</div>;
  MockV2MessageBubble.displayName = 'MockV2MessageBubble';
  return MockV2MessageBubble;
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
  error: null,
  refresh: jest.fn(),
  ...overrides,
});

const renderChat = (detail, props = {}) => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2PodChat detail={detail} {...props} />
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

describe('V2PodChat teaching empty states', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    axios.post.mockResolvedValue({ data: {} });
  });

  test('regular empty pods teach visible membership and @-mentions', () => {
    renderChat(makeDetail());

    expect(screen.getByText('This pod is quiet')).toBeInTheDocument();
    expect(screen.getByText(/use @ to mention an agent or teammate/i)).toBeInTheDocument();
    expect(screen.getByText(/everyone in the member list can see and reply/i)).toBeInTheDocument();
  });

  test('multi-member regular pods use the same teaching state', () => {
    renderChat(makeDetail({
      members: [
        { _id: 'u1', username: 'solo-user', isBot: false },
        { _id: 'u2', username: 'teammate', isBot: false },
      ],
    }));

    expect(screen.getByText('This pod is quiet')).toBeInTheDocument();
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

describe('V2PodChat starter prompts', () => {
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

describe('V2PodChat agent-room liveness', () => {
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
          <V2PodChat detail={{ ...detail, messages: [sent, reply] }} />
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

describe('V2PodChat just-created Pod starter panel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    axios.post.mockResolvedValue({ data: {} });
  });

  test('pre-generates a copyable invite and offers agent and composer actions', async () => {
    const token = 'd'.repeat(32);
    const onOpenInvite = jest.fn();
    sessionStorage.setItem('v2.justCreated.p1', '1');
    axios.post.mockResolvedValueOnce({ data: { token } });
    renderChat(makeDetail(), { onOpenInvite });

    expect(await screen.findByText('Your Pod is ready')).toBeInTheDocument();
    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        '/api/pods/p1/invites',
        {},
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    const inviteUrl = `${window.location.origin}/v2/invite/${token}`;
    expect(await screen.findByLabelText('Invite link for this Pod')).toHaveValue(inviteUrl);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(inviteUrl));

    fireEvent.click(screen.getByRole('button', { name: /^Add an agent/ }));
    expect(onOpenInvite).toHaveBeenCalledWith('agent');

    const composer = screen.getByPlaceholderText('Message My Workspace…');
    fireEvent.click(screen.getByRole('button', { name: /^Write the first message/ }));
    expect(composer).toHaveFocus();
  });

  test('stays absent without the flag or after messages arrive', async () => {
    const noFlag = renderChat(makeDetail());
    expect(screen.queryByText('Your Pod is ready')).not.toBeInTheDocument();
    expect(screen.getByText('This pod is quiet')).toBeInTheDocument();
    noFlag.unmount();

    sessionStorage.setItem('v2.justCreated.p1', '1');
    const withMessage = renderChat(makeDetail({
      messages: [{ id: 'm1', content: 'First!', user: { username: 'solo-user' } }],
    }));
    expect(screen.queryByText('Your Pod is ready')).not.toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem('v2.justCreated.p1')).toBeNull());
    withMessage.unmount();
  });

  test('keeps the first-run modal ahead of the starter panel without minting an invite', () => {
    sessionStorage.setItem('v2.justCreated.p1', '1');
    renderChat(makeDetail(), { firstRunVisible: true });

    expect(screen.queryByText('Your Pod is ready')).not.toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('does not mint an invite when the starter panel does not render', () => {
    renderChat(makeDetail());

    expect(screen.queryByText('Your Pod is ready')).not.toBeInTheDocument();
    expect(screen.getByText('This pod is quiet')).toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('dismisses explicitly and clears the session flag', async () => {
    sessionStorage.setItem('v2.justCreated.p1', '1');
    axios.post.mockResolvedValueOnce({ data: { token: 'e'.repeat(32) } });
    renderChat(makeDetail());

    expect(await screen.findByText('Your Pod is ready')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss starter actions' }));

    expect(screen.queryByText('Your Pod is ready')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('v2.justCreated.p1')).toBeNull();
  });
});
