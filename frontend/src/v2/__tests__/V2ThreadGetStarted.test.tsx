// @ts-nocheck
// D288: the owner of a fresh workspace sees the Get started bar in place of
// the board chip; anyone else, or a pod whose steps are done, keeps the chip.
// Step 1 opens Bring your own; step 2 opens the composer on the person's agent.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

let mockTasks = [];
let mockAgentStates = [];
jest.mock('axios', () => {
  const mock = {
    get: jest.fn((url) => Promise.resolve({ data: String(url).startsWith('/api/v1/tasks/') ? { tasks: mockTasks }
      : String(url).endsWith('/agent-states') ? { agents: mockAgentStates } : {} })),
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

const authValue = {
  currentUser: { _id: 'u1', username: 'alice' },
  user: { _id: 'u1', username: 'alice' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const starterTasks = (connect, firstTask) => [
  { status: connect ? 'done' : 'pending', sourceRef: 'onboarding:connect-agent' },
  { status: firstTask ? 'done' : 'pending', sourceRef: 'onboarding:first-task' },
  { status: 'pending', sourceRef: 'onboarding:invite-teammate' },
];

const renderThread = ({ owner = 'u1', agents = [] } = {}) => {
  const detail = {
    pod: { _id: 'pod-1', name: 'My Workspace', type: 'chat', createdBy: owner },
    members: [{ _id: 'u1', username: 'alice', isBot: false }],
    messages: [],
    agents,
    sendMessage: jest.fn(),
    loading: false,
    error: null,
    refresh: jest.fn(),
  };
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={['/v2/pods/pod-1']}>
        <Routes>
          <Route path="/v2/agents/byo" element={<ByoPage />} />
          <Route path="/v2/pods/:podId/board" element={<p>board page</p>} />
          <Route path="*" element={<V2Thread detail={detail} onOpenInvite={jest.fn()} />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
};

const boardChips = () => document.querySelectorAll('button.v2-pod-header__board');

const ByoPage = () => {
  const params = new URLSearchParams(useLocation().search);
  return <p>byo page pod={params.get('pod')} name={params.get('name') || ''} reconnect={params.get('reconnect') || ''}</p>;
};

afterEach(() => { mockAgentStates = []; });

describe('V2Thread Get started bar (D288)', () => {
  // F516: an owner who made an agent and never ran its command comes back to
  // that agent by name, and step 1 opens that agent's page, not a blank form.
  test('an agent of theirs that never connected is named, and step 1 opens its connect page', async () => {
    mockTasks = starterTasks(false, false);
    mockAgentStates = [
      { agentName: 'scout', instanceId: 'default', state: 'listening', isOwner: false },
      { agentName: 'walk-pending', instanceId: 'default', displayName: 'Walk Pending', state: 'never-connected', isOwner: true, connectPodId: 'pod-1' },
    ];
    renderThread();
    const step = await screen.findByTestId('get-started-connect');
    await waitFor(() => expect(step).toHaveTextContent('Finish connecting Walk Pending'));
    fireEvent.click(step);
    expect(await screen.findByText(/^byo page/)).toHaveTextContent('byo page pod=pod-1 name=walk-pending reconnect=1');
  });

  test('someone else\'s unconnected agent, or one with no connect path, keeps the plain step', async () => {
    mockTasks = starterTasks(false, false);
    mockAgentStates = [
      { agentName: 'theirs', instanceId: 'default', state: 'never-connected', isOwner: false, connectPodId: 'pod-1' },
      { agentName: 'mine-no-path', instanceId: 'default', state: 'never-connected', isOwner: true },
    ];
    renderThread();
    const step = await screen.findByTestId('get-started-connect');
    await waitFor(() => expect(require('axios').default.get).toHaveBeenCalledWith('/api/pods/pod-1/agent-states', expect.anything()));
    expect(step).toHaveTextContent('Connect your first agent');
    fireEvent.click(step);
    expect(await screen.findByText(/^byo page/)).toHaveTextContent('byo page pod=pod-1 name= reconnect=');
  });

  test('the owner with both steps open sees the bar and no board chip; step 1 opens Bring your own', async () => {
    mockTasks = starterTasks(false, false);
    renderThread();
    await screen.findByTestId('get-started');
    expect(boardChips()).toHaveLength(0);
    fireEvent.click(screen.getByTestId('get-started-connect'));
    expect(await screen.findByText(/^byo page pod=/)).toHaveTextContent(/pod=\S+/);
  });

  test('step 2 opens the composer on the person\'s own agent, not Scout', async () => {
    mockTasks = starterTasks(true, false);
    renderThread({
      agents: [
        { agentName: 'scout', instanceId: 'default', status: 'active' },
        { agentName: 'claude-code', instanceId: 'laptop', status: 'active' },
      ],
    });
    fireEvent.click(await screen.findByTestId('get-started-first-task'));
    const box = screen.getByRole('textbox');
    await waitFor(() => expect(box.value).toBe('@laptop '));
  });

  test('step 2 never puts an opaque per-user token in the mention', async () => {
    mockTasks = starterTasks(true, false);
    renderThread({
      agents: [
        { agentName: 'scout', instanceId: 'default', status: 'active' },
        { agentName: 'pixel', instanceId: 'u3f9c2a1b7d', status: 'active', displayName: 'Pixel' },
      ],
    });
    fireEvent.click(await screen.findByTestId('get-started-first-task'));
    const box = screen.getByRole('textbox');
    await waitFor(() => expect(box.value).toBe('@pixel '));
    expect(box.value).not.toContain('u3f9c2a1b7d');
  });

  test('while the bar replaces the board chip, the bar itself opens the board', async () => {
    mockTasks = starterTasks(false, false);
    renderThread();
    expect(boardChips()).toHaveLength(0);
    fireEvent.click(await screen.findByTestId('get-started-board'));
    expect(await screen.findByText('board page')).toBeInTheDocument();
  });

  test('another member of the pod sees the board chip, never the bar', async () => {
    mockTasks = starterTasks(false, false);
    renderThread({ owner: 'someone-else' });
    await waitFor(() => expect(boardChips().length).toBeGreaterThan(0));
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();
  });

  test('both steps done: the bar is gone and the board chip is back', async () => {
    mockTasks = starterTasks(true, true);
    renderThread();
    await waitFor(() => expect(boardChips().length).toBeGreaterThan(0));
    expect(screen.queryByTestId('get-started')).not.toBeInTheDocument();
  });
});
