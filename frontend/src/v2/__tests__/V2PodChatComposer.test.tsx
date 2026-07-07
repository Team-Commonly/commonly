// @ts-nocheck
// Regression for the send-button click: handleSend(override?: string) was
// wired as onClick={handleSend}, so the MouseEvent arrived as `override` and
// (override ?? draft).trim() threw — the button silently did nothing while
// Enter-to-send kept working (regressed in 45380a50).
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2PodChat from '../components/V2PodChat';
import { AuthContext } from '../../context/AuthContext';

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
  sendMessage: jest.fn(() => Promise.resolve({ _id: 'm1' })),
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

describe('V2PodChat composer send button', () => {
  test('clicking the send button sends the drafted text', async () => {
    const detail = makeDetail();
    renderChat(detail);

    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'hello team' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      expect(detail.sendMessage).toHaveBeenCalledWith('hello team', 'text', undefined);
    });
  });

  test('send button is disabled while the draft is empty', () => {
    renderChat(makeDetail());
    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
  });
});
