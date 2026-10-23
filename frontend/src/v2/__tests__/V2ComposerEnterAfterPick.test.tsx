// @ts-nocheck
// TASK-413 — Enter after picking from the @ picker must send, not stall.
// Picker open: Enter selects. Picker closed: Enter sends. Shift+Enter is a
// newline. IME composition never sends.
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

const renderChat = (detail) => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2Thread detail={detail} />
    </MemoryRouter>
  </AuthContext.Provider>,
);

const composer = () => screen.getByPlaceholderText(/message my workspace/i);

afterEach(() => jest.clearAllMocks());

describe('V2Thread composer: Enter after the @ picker (TASK-413)', () => {
  test('pick with Enter, then Enter sends the message', async () => {
    const detail = makeDetail();
    renderChat(detail);
    fireEvent.change(composer(), { target: { value: '@sam' } });
    await screen.findByRole('option');

    fireEvent.keyDown(composer(), { key: 'Enter' });
    fireEvent.keyUp(composer(), { key: 'Enter' });
    expect(detail.sendMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(detail.sendMessage).toHaveBeenCalledTimes(1));
    expect(detail.sendMessage.mock.calls[0][0]).toContain('@sam-agent');
  });

  test('pick with a click, then Enter sends the message', async () => {
    const detail = makeDetail();
    renderChat(detail);
    fireEvent.change(composer(), { target: { value: '@sam' } });
    fireEvent.click(await screen.findByRole('option'));
    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());

    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(detail.sendMessage).toHaveBeenCalledTimes(1));
  });

  test('picker open: Enter selects and does not send', async () => {
    const detail = makeDetail();
    renderChat(detail);
    fireEvent.change(composer(), { target: { value: '@sam' } });
    await screen.findByRole('option');

    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(detail.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  test('Shift+Enter inserts a newline and does not send', () => {
    const detail = makeDetail();
    renderChat(detail);
    fireEvent.change(composer(), { target: { value: 'hello' } });
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true });
    expect(detail.sendMessage).not.toHaveBeenCalled();
  });

  test('Enter during IME composition does not send or select', async () => {
    const detail = makeDetail();
    renderChat(detail);
    fireEvent.change(composer(), { target: { value: '@sam' } });
    await screen.findByRole('option');

    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true });
    expect(detail.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('option')).toBeInTheDocument();
  });

  test('Enter with the composer closed and IME composing does not send', () => {
    const detail = makeDetail();
    renderChat(detail);
    fireEvent.change(composer(), { target: { value: 'hello' } });
    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true });
    expect(detail.sendMessage).not.toHaveBeenCalled();
  });
});

// Keystroke-level replay of the GTM sequence: type @, pick from the picker
// with Enter, then press Enter in the composer. Each key gets a keydown,
// a value change and a keyup, as a browser delivers them.
describe('V2Thread composer: keystroke replay of the GTM sequence (TASK-413)', () => {
  const typeKey = (el, char) => {
    fireEvent.keyDown(el, { key: char });
    const next = el.value + char;
    fireEvent.change(el, { target: { value: next } });
    el.setSelectionRange(next.length, next.length);
    fireEvent.keyUp(el, { key: char });
  };

  test('type @, type a name, pick with Enter, then Enter sends', async () => {
    const detail = makeDetail();
    renderChat(detail);
    const el = composer();
    typeKey(el, '@');
    typeKey(el, 's');
    typeKey(el, 'a');
    typeKey(el, 'm');
    await screen.findByRole('option');

    fireEvent.keyDown(el, { key: 'Enter' });
    fireEvent.keyUp(el, { key: 'Enter' });
    expect(detail.sendMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(detail.sendMessage).toHaveBeenCalledTimes(1));
  });
});
