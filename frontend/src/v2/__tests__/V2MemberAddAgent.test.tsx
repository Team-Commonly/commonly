// @ts-nocheck
// F510: a person who joins someone else's pod by invite saw the messages and
// nothing that said they could bring their own agent (the Agents section sits
// collapsed in the inspector). A member with no agent of their own here gets
// one line above the composer, until they add one or dismiss it.
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

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

const axios = jest.requireMock('axios').default;

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
  agents: [{ agentName: 'sam-agent', instanceId: 'default', displayName: 'Sam Agent' }],
  sendMessage: jest.fn(() => Promise.resolve({ _id: 'm1' })),
  loading: false,
  error: null,
  refresh: jest.fn(),
  ...overrides,
});

const mockStates = (agents) => {
  axios.get.mockImplementation((url) => {
    if (typeof url === 'string' && url.endsWith('/agent-states')) {
      return Promise.resolve({ data: { agents } });
    }
    return Promise.resolve({ data: {} });
  });
};

const renderChat = (detail, onOpenInvite = jest.fn()) => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2Thread detail={detail} onOpenInvite={onOpenInvite} />
    </MemoryRouter>
  </AuthContext.Provider>,
);

afterEach(() => jest.clearAllMocks());

const HOURS_AGO_3 = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

const joined = (pod = {}, extra = {}) => makeDetail({
  pod: { _id: 'p1', name: 'Team pod', type: 'chat', createdBy: 'owner-a', ...pod },
  members: [{ _id: 'owner-a', username: 'ann', isBot: false }, { _id: 'u1', username: 'solo-user', isBot: false }],
  messages: [{ id: 'm1', pod_id: 'p1', user_id: 'owner-a', content: 'hi team', created_at: '2026-11-14T16:00:00.000Z', user: { username: 'ann' } }],
  ...extra,
});
const annsAgent = { agentName: 'sam-agent', instanceId: 'default', displayName: 'Sam Agent', state: 'listening', lastUsedAt: new Date().toISOString(), isOwner: false };

beforeEach(() => { try { localStorage.clear(); } catch {} });

describe('a member with no agent of their own in the pod (F510)', () => {
  test('sees one line that opens Add an agent', async () => {
    mockStates([annsAgent]);
    const onOpenInvite = jest.fn();
    renderChat(joined(), onOpenInvite);
    const line = await screen.findByTestId('member-add-agent');
    expect(line).toHaveTextContent('You can add your own agent to this pod.');
    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }));
    expect(onOpenInvite).toHaveBeenCalledWith('agent');
  });

  test('dismissed, it stays gone for this pod', async () => {
    mockStates([annsAgent]);
    const first = renderChat(joined());
    await screen.findByTestId('member-add-agent');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('member-add-agent')).toBeNull();
    first.unmount();
    renderChat(joined());
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/agent-states'), expect.anything()));
    await screen.findByText('hi team');
    expect(screen.queryByTestId('member-add-agent')).toBeNull();
  });

  test.each([
    ['the pod owner', joined({ createdBy: 'u1' }), [annsAgent]],
    ['a member who already added an agent here', joined(), [annsAgent, { ...annsAgent, agentName: 'mine', isOwner: true }]],
    ['a community pod, where members cannot install', joined({ publicRead: true }), [annsAgent]],
    ['an agent admin pod, where the install is refused', joined({ type: 'agent-admin' }), [annsAgent]],
  ])('stays away for %s', async (_label, detail, states) => {
    mockStates(states);
    renderChat(detail);
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/agent-states'), expect.anything()));
    await screen.findByText('hi team');
    expect(screen.queryByTestId('member-add-agent')).toBeNull();
  });

  test('waits for agent-states before showing, so it never flashes at an agent owner', async () => {
    axios.get.mockImplementation(() => new Promise(() => {}));
    renderChat(joined());
    await screen.findByText('hi team');
    expect(screen.queryByTestId('member-add-agent')).toBeNull();
  });
});
