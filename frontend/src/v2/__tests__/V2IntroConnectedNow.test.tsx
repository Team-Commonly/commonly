// @ts-nocheck
// F509: an agent's join note says "nothing is running me yet" and never
// updates. Once the pod sees the agent listening, the note gains one line
// saying it is connected now, so the pod's top message stops reading as current.
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

const HOURS_AGO_3 = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

const intro = {
  id: 'i1', pod_id: 'p1', user_id: 'bot-1', message_type: 'text', created_at: '2026-11-14T16:16:00.000Z',
  content: "Hi all — I'm Sam Agent, just joined the pod. As I post this, nothing is running me yet, so mentioning me won't reach anyone.",
  payload: { kind: 'install-intro' },
  user: { username: 'sam-agent', isBot: true },
};
const row = (state) => ({ agentName: 'sam-agent', instanceId: 'default', displayName: 'Sam Agent', state, lastUsedAt: state === 'listening' ? new Date().toISOString() : null, isOwner: false });

describe('the join note says when its agent is connected now (F509)', () => {
  test('a listening agent: the note gains the connected-now line', async () => {
    mockStates([row('listening')]);
    renderChat(makeDetail({ messages: [intro] }));
    const line = await screen.findByTestId('intro-connected-now');
    expect(line).toHaveTextContent(/^Sam Agent is connected now\. @mentions reach it\.$/);
    expect(document.getElementById('message-i1')).toContainElement(line);
  });

  test('a second instance: the line follows its own key, and its sibling’s note stays as posted', async () => {
    mockStates([
      { ...row('listening'), instanceId: 'laptop' },
      row('never-connected'),
    ]);
    renderChat(makeDetail({
      agents: [
        { agentName: 'sam-agent', instanceId: 'default', displayName: 'Sam Agent' },
        { agentName: 'sam-agent', instanceId: 'laptop' },
      ],
      messages: [intro, { ...intro, id: 'i2', user: { username: 'sam-agent-laptop', isBot: true } }],
    }));
    const line = await screen.findByTestId('intro-connected-now');
    expect(document.getElementById('message-i2')).toContainElement(line);
    expect(screen.getAllByTestId('intro-connected-now')).toHaveLength(1);
  });

  test('a never-connected agent: no line, the note stands as posted', async () => {
    mockStates([row('never-connected')]);
    renderChat(makeDetail({ messages: [intro] }));
    await screen.findByTestId('pod-agent-liveness');
    expect(screen.queryByTestId('intro-connected-now')).toBeNull();
  });

  test('an ordinary agent message gets no line, even while the agent listens', async () => {
    mockStates([row('listening')]);
    renderChat(makeDetail({ messages: [{ ...intro, id: 'm2', payload: undefined, content: 'hello' }] }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/agent-states'), expect.anything()));
    expect(screen.queryByTestId('intro-connected-now')).toBeNull();
  });
});
