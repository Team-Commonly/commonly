// @ts-nocheck
// ADR-026 Phase 2 slice 3: the "on my computer" path. Pinned: the mode card
// appears only when the user has daemon machines; submit installs with
// runtimeType 'wrapper' and files a placement request (never a binding); the
// result panel watches the daemon's per-agent heartbeat state.
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
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
  currentUser: { _id: 'u1', username: 'sam' },
  user: { _id: 'u1', username: 'sam' },
  token: 'user-jwt',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const machineRow = {
  id: 'm1', machineId: 'mach-a', name: 'Sam’s MacBook', status: 'online', agentStates: [],
};

const mockGet = ({ machines = [machineRow] } = {}) => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured: false, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    }
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } }] });
    if (url === '/api/machines') return Promise.resolve({ data: { machines, offlineAfterMs: 90000 } });
    return Promise.resolve({ data: {} });
  });
};

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

afterEach(() => {
  jest.clearAllMocks();
  window.history.pushState({}, '', '/v2/agents/byo');
});

describe('BYO on-my-computer mode', () => {
  test('a registered machine surfaces the mode card and picker', async () => {
    mockGet();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    expect(screen.getByTestId('byo-machine-select')).toBeInTheDocument();
    expect(screen.getByTestId('byo-machine-select')).toHaveTextContent('Sam’s MacBook');
  });

  test('no machines — no card, page untouched', async () => {
    mockGet({ machines: [] });
    renderPage();
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/machines', expect.anything()));
    expect(screen.queryByTestId('byo-mode-machine')).toBeNull();
  });

  test('picking a pod does not stomp an explicit mode choice', async () => {
    // Caught live 2026-09-06: the mount effect re-runs on pod change and
    // re-asserted the hosted default, flipping "Add to this computer" back
    // into "Run it here" — my submit went down the hosted path.
    mockGet();
    axios.get.mockImplementation((url) => {
      if (url.startsWith('/api/hosted/availability')) {
        return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
      }
      if (url === '/api/pods') {
        return Promise.resolve({
          data: [
            { _id: 'p1', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } },
            { _id: 'p2', name: 'Playground', type: 'team', createdBy: { _id: 'u1' } },
          ],
        });
      }
      if (url === '/api/machines') return Promise.resolve({ data: { machines: [machineRow], offlineAfterMs: 90000 } });
      return Promise.resolve({ data: {} });
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    fireEvent.change(screen.getByRole('combobox', { name: /install into pod/i }), { target: { value: 'p2' } });
    // The effect refetches on podId change; the mode must survive it.
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeInTheDocument());
    expect(screen.getByTestId('byo-mode-machine')).toHaveAttribute('aria-pressed', 'true');
  });

  test('submit installs a wrapper runtime and files the placement request', async () => {
    mockGet();
    axios.post.mockResolvedValue({ data: {} });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    fireEvent.click(screen.getByText('Add to this computer'));

    await waitFor(() => expect(screen.getByTestId('byo-machine-result')).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
      agentName: 'sam-agent',
      podId: 'p1',
      config: expect.objectContaining({ runtime: { runtimeType: 'wrapper' } }),
    }), expect.anything());
    expect(axios.post).toHaveBeenCalledWith('/api/agent-binding/request', {
      agentName: 'sam-agent', instanceId: 'default', machineId: 'mach-a',
    }, expect.anything());
    // Honest until the daemon reports it: waiting, not live.
    expect(screen.getByTestId('byo-machine-waiting')).toBeInTheDocument();
  });
});
