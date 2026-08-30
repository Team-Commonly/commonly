// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2PodBoard from '../components/V2PodBoard';
import { AuthContext } from '../../context/AuthContext';

let mockSocketValue = { socket: null, connected: false };
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => mockSocketValue,
}));

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    patch: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios').default;

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

const TASKS = [
  { taskId: 'TASK-001', title: 'Connect your first agent', status: 'done', updates: [] },
  { taskId: 'TASK-002', title: 'Give your agent its first task', status: 'pending', updates: [] },
  // Alias statuses written before the #921 vocabulary gate must render in
  // their canonical columns, not vanish.
  { taskId: 'N-3', title: 'Legacy alias in progress', status: 'in_progress', updates: [] },
  { taskId: 'N-4', title: 'Legacy alias completed', status: 'completed', updates: [] },
];

const wireAxios = (tasks = TASKS) => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/v1/tasks/')) return Promise.resolve({ data: { tasks } });
    if (url.startsWith('/api/pods/')) return Promise.resolve({ data: { name: 'My Workspace' } });
    return Promise.resolve({ data: {} });
  });
};

const renderBoard = (entry = '/v2/pods/pod-1/board') => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/v2/pods/:podId/board" element={<V2PodBoard />} />
        <Route path="/v2/pods/:podId" element={<div>chat page</div>} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

beforeEach(() => {
  jest.clearAllMocks();
  mockSocketValue = { socket: null, connected: false };
  wireAxios();
});

describe('V2PodBoard', () => {
  test('renders four canonical columns and places alias statuses in them', async () => {
    renderBoard();

    const pending = await screen.findByRole('region', { name: 'Pending' });
    const inProgress = screen.getByRole('region', { name: 'In Progress' });
    const done = screen.getByRole('region', { name: 'Done' });
    screen.getByRole('region', { name: 'Blocked' });

    expect(within(pending).getByText('Give your agent its first task')).toBeInTheDocument();
    // 'in_progress' and 'completed' are pre-gate aliases — they render in
    // their canonical columns instead of disappearing (#921 sets).
    expect(within(inProgress).getByText('Legacy alias in progress')).toBeInTheDocument();
    expect(within(done).getByText('Legacy alias completed')).toBeInTheDocument();
    expect(within(done).getByText('Connect your first agent')).toBeInTheDocument();
  });

  test('Start moves a pending task via PATCH with optimistic column change', async () => {
    axios.patch.mockResolvedValue({
      data: { task: { taskId: 'TASK-002', title: 'Give your agent its first task', status: 'claimed', updates: [] } },
    });
    renderBoard();

    const pending = await screen.findByRole('region', { name: 'Pending' });
    fireEvent.click(within(pending).getByRole('button', { name: 'Start' }));

    expect(axios.patch).toHaveBeenCalledWith(
      '/api/v1/tasks/pod-1/TASK-002',
      { status: 'claimed' },
      expect.any(Object),
    );
    const inProgress = screen.getByRole('region', { name: 'In Progress' });
    await waitFor(() => {
      expect(within(inProgress).getByText('Give your agent its first task')).toBeInTheDocument();
    });
  });

  test('creates a task from the dialog', async () => {
    axios.post.mockResolvedValue({ data: { task: { taskId: 'N-9', title: 'Ship it', status: 'pending' } } });
    renderBoard();
    await screen.findByRole('region', { name: 'Pending' });

    fireEvent.click(screen.getByRole('button', { name: /New task/ }));
    fireEvent.change(screen.getByPlaceholderText('What needs to happen?'), { target: { value: 'Ship it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        '/api/v1/tasks/pod-1',
        { title: 'Ship it' },
        expect.any(Object),
      );
    });
  });

  test('opens the real task dialog when Activity hands it a create-task intent', async () => {
    renderBoard('/v2/pods/pod-1/board?createTask=1');

    expect(await screen.findByPlaceholderText('What needs to happen?')).toBeInTheDocument();
  });

  test('refetches when a task_updated socket event lands for this pod', async () => {
    const handlers = {};
    mockSocketValue = {
      socket: {
        on: (event, fn) => { handlers[event] = fn; },
        off: jest.fn(),
        emit: jest.fn(),
      },
      connected: true,
    };
    renderBoard();
    await screen.findByRole('region', { name: 'Pending' });

    const tasksCallsBefore = axios.get.mock.calls.filter(([url]) => url.startsWith('/api/v1/tasks/')).length;
    act(() => {
      handlers.task_updated({ podId: 'pod-1', task: {}, kind: 'created' });
    });

    await waitFor(() => {
      const tasksCallsAfter = axios.get.mock.calls.filter(([url]) => url.startsWith('/api/v1/tasks/')).length;
      expect(tasksCallsAfter).toBeGreaterThan(tasksCallsBefore);
    });
  });
});
