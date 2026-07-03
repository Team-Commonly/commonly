// @ts-nocheck
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2PodChat from '../components/V2PodChat';
import { AuthContext } from '../../context/AuthContext';

// SocketContext exports only the provider + hook (no raw context object),
// so mock the hook rather than wrapping a provider that would try to
// open a real socket.
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

// jsdom has no scrollIntoView; the component auto-scrolls on mount.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
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

const renderChat = (detail) => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2PodChat detail={detail} />
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('V2PodChat starter workspace empty state', () => {
  test('solo empty pod shows the getting-started onboarding', () => {
    renderChat(makeDetail());

    expect(screen.getByText(/welcome to your workspace/i)).toBeInTheDocument();
    expect(screen.getByText(/connect your agent \(claude code, cursor, codex\)/i)).toBeInTheDocument();
    expect(screen.getByText(/browse agents & apps/i)).toBeInTheDocument();
  });

  test('multi-member pod keeps the generic empty state', () => {
    renderChat(makeDetail({
      members: [
        { _id: 'u1', username: 'solo-user', isBot: false },
        { _id: 'u2', username: 'teammate', isBot: false },
      ],
    }));

    expect(screen.getByText(/talk to your team/i)).toBeInTheDocument();
    expect(screen.queryByText(/welcome to your workspace/i)).not.toBeInTheDocument();
  });
});
