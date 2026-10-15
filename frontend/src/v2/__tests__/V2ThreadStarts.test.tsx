// @ts-nocheck
// Scout's starts: the first session's direction B (ruled 2026-10-15). Scout's
// welcome carries its starts in a server-composed payload, the thread renders
// them as buttons under that message, and a click sends the start as the
// person's own message. A start goes away only once this person has sent it,
// so nothing else in the pod (a join row, Scout's follow-ups, another member)
// can take the offer away before it is seen.
import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

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

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  sessionStorage.clear();
});

const authValue = {
  currentUser: { _id: 'u1', username: 'maya' },
  user: { _id: 'u1', username: 'maya' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const CONNECT = 'Connect an agent I already use';
const POD_START = 'Start a pod for a project';

const at = (minute) => `2026-10-15T10:${String(minute).padStart(2, '0')}:00.000Z`;

const welcome = {
  id: 'welcome',
  pod_id: 'pod-1',
  user_id: 'scout-1',
  content: "I'm Scout. This pod is yours, and I work in it with you. Start with one of these, or tell me what you're working on.",
  message_type: 'text',
  created_at: at(0),
  user: { username: 'scout', isBot: true },
  payload: {
    kind: 'starts',
    starts: [
      { id: 'connect-agent', label: CONNECT },
      { id: 'start-pod', label: POD_START },
    ],
  },
};

const message = (id, userId, username, content, minute, extra = {}) => ({
  id,
  pod_id: 'pod-1',
  user_id: userId,
  content,
  message_type: 'text',
  created_at: at(minute),
  user: { username },
  ...extra,
});

const Harness = ({ initial, sendSpy }) => {
  const [messages, setMessages] = useState(initial);
  const sendMessage = async (...args) => {
    sendSpy(...args);
    const sent = message(`sent-${args[0]}`, 'u1', 'maya', args[0], 30);
    setMessages((current) => [...current, sent]);
    return sent;
  };
  const detail = {
    pod: { _id: 'pod-1', name: 'My Workspace', type: 'chat', createdBy: 'u1' },
    members: [{ _id: 'u1', username: 'maya', isBot: false }],
    messages,
    agents: [{ agentName: 'scout', instanceId: 'u1a2b3c4d5e', displayName: 'Scout', status: 'active' }],
    sendMessage,
    loading: false,
    error: null,
    refresh: jest.fn(),
  };
  return <V2Thread detail={detail} />;
};

const renderThread = (initial, sendSpy = jest.fn()) => {
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter>
        <Harness initial={initial} sendSpy={sendSpy} />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return sendSpy;
};

const startsGroup = () => screen.queryByRole('group', { name: 'Ways to start' });

describe("V2Thread — Scout's starts", () => {
  test("Scout's welcome shows its starts as buttons, as one labelled group", () => {
    renderThread([welcome]);

    const group = startsGroup();
    expect(group).toBeInTheDocument();
    expect(within(group).getAllByRole('button').map((button) => button.textContent))
      .toEqual([CONNECT, POD_START]);
  });

  test('a click sends the start as a root message, leaves the draft alone, and that start goes away', async () => {
    const sendSpy = renderThread([welcome]);
    const composer = screen.getByPlaceholderText(/message my workspace/i);
    fireEvent.change(composer, { target: { value: 'half typed' } });

    fireEvent.click(within(startsGroup()).getByRole('button', { name: POD_START }));

    expect(await screen.findByText(POD_START, { selector: '.v2-msg *' })).toBeInTheDocument();
    expect(sendSpy).toHaveBeenCalledWith(POD_START, 'text', undefined, undefined);
    expect(composer).toHaveValue('half typed');
    const group = startsGroup();
    expect(within(group).queryByRole('button', { name: POD_START })).not.toBeInTheDocument();
    expect(within(group).getByRole('button', { name: CONNECT })).toBeInTheDocument();
  });

  test('a join row, Scout following up, or another member does not take the starts away', () => {
    renderThread([
      welcome,
      message('join', 'commonly-bot', 'commonly-bot', 'lee joined the pod', 1, { user: { username: 'commonly-bot', isBot: true } }),
      message('follow-up', 'scout-1', 'scout', 'Still here when you want me.', 2, { user: { username: 'scout', isBot: true } }),
      message('other-human', 'u2', 'lee', CONNECT, 3),
    ]);

    expect(within(startsGroup()).getAllByRole('button').map((button) => button.textContent))
      .toEqual([CONNECT, POD_START]);
  });

  test('typing something else leaves the starts in place, so connecting stays one click away', async () => {
    const sendSpy = renderThread([welcome]);
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    expect(await screen.findByText('hello', { selector: '.v2-msg *' })).toBeInTheDocument();
    expect(sendSpy).toHaveBeenCalledWith('hello', 'text', undefined, undefined);
    expect(within(startsGroup()).getByRole('button', { name: CONNECT })).toBeInTheDocument();
  });

  test('a start this person already sent stays gone after a reload', () => {
    renderThread([welcome, message('sent', 'u1', 'maya', CONNECT, 4)]);

    const group = startsGroup();
    expect(within(group).queryByRole('button', { name: CONNECT })).not.toBeInTheDocument();
    expect(within(group).getByRole('button', { name: POD_START })).toBeInTheDocument();
  });

  test('both starts sent: no group is left behind', () => {
    renderThread([
      welcome,
      message('sent-1', 'u1', 'maya', CONNECT, 4),
      message('sent-2', 'u1', 'maya', POD_START, 5),
    ]);

    expect(startsGroup()).not.toBeInTheDocument();
  });

  test('a message without starts shows no buttons, including an older welcome', () => {
    renderThread([
      message('old-welcome', 'scout-1', 'scout', "Welcome — I'm Scout. This workspace is yours, and I live here.", 0, { user: { username: 'scout', isBot: true } }),
    ]);

    expect(startsGroup()).not.toBeInTheDocument();
  });
});
