// @ts-nocheck
// A group pod names each installed agent that isn't running, so a newcomer
// doesn't wait on a reply that can't come. Silence census 10-30: 5 of 7 people
// who heard nothing in their first pod had an agent that never connected.
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

describe('group pod agent liveness', () => {
  test('names an agent that never connected', async () => {
    mockStates([{ agentName: 'sam-agent', instanceId: 'default', displayName: 'Sam Agent', state: 'never-connected', lastUsedAt: null, isOwner: true }]);
    renderChat(makeDetail());

    const row = await screen.findByTestId('pod-agent-liveness');
    expect(row).toHaveTextContent("Sam Agent isn't connected yet");
  });

  test('says when an agent that went quiet last checked in', async () => {
    mockStates([{ agentName: 'sam-agent', instanceId: 'default', displayName: 'Sam Agent', state: 'gone-dark', lastUsedAt: HOURS_AGO_3, isOwner: false }]);
    renderChat(makeDetail());

    const row = await screen.findByTestId('pod-agent-liveness');
    expect(row).toHaveTextContent('Sam Agent last checked in 3h ago');
  });

  test.each([
    ['listening', { state: 'listening', lastUsedAt: HOURS_AGO_3 }],
    ['hosted (reachable)', { state: 'reachable', lastUsedAt: null, hosted: true }],
    ['unknown', { state: 'unknown', lastUsedAt: null }],
  ])('shows nothing for an agent that is %s', async (_label, fields) => {
    mockStates([{ agentName: 'sam-agent', instanceId: 'default', displayName: 'Sam Agent', isOwner: true, ...fields }]);
    renderChat(makeDetail());

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/agent-states'), expect.anything()));
    expect(screen.queryByTestId('pod-agent-liveness')).not.toBeInTheDocument();
  });

  test('two agents away fold into one closed line that names both and opens to their rows', async () => {
    mockStates([
      { agentName: 'flint', instanceId: 'default', displayName: 'Flint', state: 'gone-dark', lastUsedAt: HOURS_AGO_3, isOwner: false },
      { agentName: 'swift', instanceId: 'default', displayName: 'Swift', state: 'never-connected', lastUsedAt: null, isOwner: false },
    ]);
    renderChat(makeDetail());

    const away = await screen.findByTestId('pod-agents-away');
    expect(away.tagName).toBe('DETAILS');
    expect(away).not.toHaveAttribute('open');
    expect(away.querySelector('summary')).toHaveTextContent("Flint and Swift aren't answering right now");
    const rows = screen.getAllByTestId('pod-agent-liveness');
    expect(rows.map((r) => r.textContent)).toEqual([
      "Flint last checked in 3h ago. It answers when it's back.",
      "Swift isn't connected yet, so it won't answer here until it's running.",
    ]);
    expect(rows.every((r) => away.contains(r))).toBe(true);
    rows.forEach((r) => expect(r).not.toBeVisible());
    fireEvent.click(away.querySelector('summary'));
    expect(away).toHaveAttribute('open');
    rows.forEach((r) => expect(r).toBeVisible());
    expect(document.querySelectorAll('.v2-chat__agent-room-status')).toHaveLength(1);
  });

  test('three agents away name two and count the rest', async () => {
    mockStates(['Flint', 'Swift', 'Dart'].map((name) => ({
      agentName: name.toLowerCase(), instanceId: 'default', displayName: name, state: 'gone-dark', lastUsedAt: HOURS_AGO_3, isOwner: false,
    })));
    renderChat(makeDetail());

    const away = await screen.findByTestId('pod-agents-away');
    expect(away.querySelector('summary')).toHaveTextContent("Flint, Swift and 1 other aren't answering right now");
    expect(screen.getAllByTestId('pod-agent-liveness')).toHaveLength(3);
  });

  test('five agents away count every one and list every one, past the old three-row cap', async () => {
    mockStates(['Flint', 'Swift', 'Dart', 'Echo', 'Kite'].map((name) => ({
      agentName: name.toLowerCase(), instanceId: 'default', displayName: name, state: 'gone-dark', lastUsedAt: HOURS_AGO_3, isOwner: false,
    })));
    renderChat(makeDetail());

    const away = await screen.findByTestId('pod-agents-away');
    expect(away.querySelector('summary')).toHaveTextContent("Flint, Swift and 3 others aren't answering right now");
    const rows = screen.getAllByTestId('pod-agent-liveness');
    expect(rows).toHaveLength(5);
    expect(rows[4]).toHaveTextContent('Kite last checked');
  });

  test('the away line is announced from a live region outside the summary', async () => {
    mockStates(['Flint', 'Swift'].map((name) => ({
      agentName: name.toLowerCase(), instanceId: 'default', displayName: name, state: 'gone-dark', lastUsedAt: HOURS_AGO_3, isOwner: false,
    })));
    renderChat(makeDetail());

    const away = await screen.findByTestId('pod-agents-away');
    const live = screen.getByRole('status');
    expect(live).toHaveTextContent("Flint and Swift aren't answering right now");
    expect(away.contains(live)).toBe(false);
    expect(away.querySelector('summary [role="status"]')).toBeNull();
  });

  test('a 1:1 agent room keeps its own row and never doubles it', async () => {
    mockStates([{ agentName: 'sam-agent', instanceId: 'default', displayName: 'Sam Agent', state: 'never-connected', lastUsedAt: null, isOwner: true }]);
    renderChat(makeDetail({
      pod: { _id: 'p1', name: 'Sam Agent', type: 'agent-room' },
      members: [
        { _id: 'u1', username: 'solo-user', isBot: false },
        { _id: 'b1', username: 'sam-agent', isBot: true },
      ],
    }));

    await screen.findByTestId('agent-room-liveness');
    expect(screen.queryByTestId('pod-agent-liveness')).not.toBeInTheDocument();
  });
});
