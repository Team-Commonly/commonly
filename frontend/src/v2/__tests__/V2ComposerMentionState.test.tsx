// @ts-nocheck
// #891 surface 1 — compose-time honesty about mentioned agents. The moment a
// draft mentions an agent that cannot hear it, the composer says so:
// certainty-matched copy (never-connected flat, gone-dark hedged), fix
// command only when the endpoint attached one (owner), and the typeahead
// itself carries the state so a dead mention is never offered silently.
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

const renderChat = (detail) => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2Thread detail={detail} />
    </MemoryRouter>
  </AuthContext.Provider>,
);

afterEach(() => jest.clearAllMocks());

describe('V2Composer mention-state honesty (#891 surface 1)', () => {
  test('mentioning a never-connected agent warns the OWNER with the fix command', async () => {
    mockStates([{
      agentName: 'sam-agent', instanceId: 'default', state: 'never-connected', isOwner: true, fixCommand: 'commonly agent run sam-agent',
    }]);
    renderChat(makeDetail());
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/agent-states'), expect.anything()));

    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'hey @sam-agent can you look' },
    });

    const warning = await screen.findByTestId('mention-state-warning');
    expect(warning.textContent).toContain("isn't connected");
    expect(warning.textContent).toContain('commonly agent run sam-agent');
  });

  test('a NON-owner gets the explanation without the instruction', async () => {
    mockStates([{
      agentName: 'sam-agent', instanceId: 'default', state: 'never-connected', isOwner: false,
    }]);
    renderChat(makeDetail());
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/agent-states'), expect.anything()));

    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: '@sam-agent ping' },
    });

    const warning = await screen.findByTestId('mention-state-warning');
    expect(warning.textContent).toContain('Its owner can connect it');
    expect(warning.textContent).not.toContain('commonly agent run');
  });

  test('gone-dark copy is hedged, never flat', async () => {
    mockStates([{
      agentName: 'sam-agent', instanceId: 'default', state: 'gone-dark', isOwner: false,
    }]);
    renderChat(makeDetail());
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/agent-states'), expect.anything()));

    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: '@sam-agent still there?' },
    });

    const warning = await screen.findByTestId('mention-state-warning');
    expect(warning.textContent).toContain('may not answer');
    expect(warning.textContent).not.toContain("isn't connected");
  });

  test('a listening agent draws no warning at all', async () => {
    mockStates([{
      agentName: 'sam-agent', instanceId: 'default', state: 'listening', isOwner: true,
    }]);
    renderChat(makeDetail());
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/agent-states'), expect.anything()));

    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: '@sam-agent all good' },
    });

    expect(screen.queryByTestId('mention-state-warning')).not.toBeInTheDocument();
  });

  test('the typeahead itself carries the state for a dead agent', async () => {
    mockStates([{
      agentName: 'sam-agent', instanceId: 'default', state: 'never-connected', isOwner: true, fixCommand: 'commonly agent run sam-agent',
    }]);
    renderChat(makeDetail());
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/agent-states'), expect.anything()));

    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: '@sam' },
    });

    const option = await screen.findByRole('option');
    expect(option.textContent).toContain("not connected");
  });
});
