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

// Composer behavior does not depend on avatar rendering. Keep this test
// isolated from the external DiceBear package graph used by V2Avatar.
jest.mock('../components/V2Avatar', () => () => <span data-testid="avatar" />);
jest.mock('../utils/avatars', () => ({ initialsFor: (name: string) => name.slice(0, 2) }));

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
  sendError: null,
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
      // 4th arg is threadRootId (W-T 4/4). Both trailing args are undefined
      // for an ordinary send, and that IS the assertion: a plain message must
      // carry neither an addressing edge nor a thread membership.
      expect(detail.sendMessage).toHaveBeenCalledWith('hello team', 'text', undefined, undefined);
    });
  });

  test('send button is disabled while the draft is empty', () => {
    renderChat(makeDetail());
    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
  });

  test('shows send failures by the composer and keeps the reply draft intact', async () => {
    const detail = makeDetail({
      messages: [{
        id: 'm1',
        pod_id: 'p1',
        user_id: 'u2',
        content: 'Can you check this?',
        message_type: 'text',
        created_at: '2026-08-22T13:00:00Z',
        user: { username: 'teammate' },
      }],
      sendMessage: jest.fn(() => Promise.resolve(null)),
    });
    const { rerender } = renderChat(detail);

    fireEvent.click(screen.getByRole('button', { name: /reply to teammate/i }));
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), {
      target: { value: 'I am checking it now.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => {
      // Reply-to-person sets the addressing edge and NOT the thread root —
      // the two are mutually exclusive at the composer, and the resolver 400s
      // a message carrying both.
      expect(detail.sendMessage).toHaveBeenCalledWith('I am checking it now.', 'text', 'm1', undefined);
    });

    rerender(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter>
          <V2PodChat detail={{ ...detail, sendError: 'Replies are temporarily unavailable. Please try again shortly.' }} />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    const sendError = screen.getByText('Replies are temporarily unavailable. Please try again shortly.');
    expect(sendError.closest('.v2-chat__composer')).not.toBeNull();
    expect(sendError.closest('.v2-chat__messages')).toBeNull();
    expect(screen.getByPlaceholderText(/message my workspace/i)).toHaveValue('I am checking it now.');
    expect(screen.getByRole('button', { name: /cancel reply/i }).closest('.v2-chat__reply-chip')).not.toBeNull();
  });
});
