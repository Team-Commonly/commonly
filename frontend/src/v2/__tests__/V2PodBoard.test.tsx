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

const FOCUS = {
  podId: 'pod-1',
  revision: 2,
  permissions: { canEdit: true },
  focus: {
    goal: 'Ship the pilot',
    scope: 'Sharpen only',
    owner: { userId: 'u1', label: 'alice', available: true },
    nextTasks: [{ taskId: 'TASK-002', available: true, title: 'Give your agent its first task', status: 'pending', assignee: null, updatedAt: null }],
    updatedAt: '2026-09-08T00:00:00.000Z',
    updatedBy: { userId: 'u1', label: 'alice' },
  },
};

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

    // The craft pass uses icon components, not unicode arrow/plus glyphs, so
    // the accessible button names stay sentence-case labels.
    expect(screen.getByRole('button', { name: 'Back to chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument();

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
    const focusCallsBefore = axios.get.mock.calls.filter(([url]) => url.endsWith('/focus')).length;
    act(() => {
      handlers.task_updated({ podId: 'pod-1', task: {}, kind: 'created' });
    });

    await waitFor(() => {
      const tasksCallsAfter = axios.get.mock.calls.filter(([url]) => url.startsWith('/api/v1/tasks/')).length;
      expect(tasksCallsAfter).toBeGreaterThan(tasksCallsBefore);
      const focusCallsAfter = axios.get.mock.calls.filter(([url]) => url.endsWith('/focus')).length;
      expect(focusCallsAfter).toBeGreaterThan(focusCallsBefore);
    });
  });

  test('renders a populated focus and saves an explicit ordered edit', async () => {
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/focus')) return Promise.resolve({ data: FOCUS });
      if (url.startsWith('/api/v1/tasks/')) return Promise.resolve({ data: { tasks: TASKS } });
      if (url.startsWith('/api/pods/')) return Promise.resolve({ data: { name: 'My Workspace', members: [{ _id: 'u1', username: 'alice', isBot: false }] } });
      return Promise.resolve({ data: {} });
    });
    axios.patch.mockResolvedValue({ data: FOCUS });
    renderBoard();

    expect(await screen.findByText('Ship the pilot')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit focus' }));
    fireEvent.change(screen.getByDisplayValue('Ship the pilot'), { target: { value: 'Ship the pilot safely' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save focus' }));

    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
      '/api/pods/pod-1/focus',
      {
        expectedRevision: 2,
        focus: { goal: 'Ship the pilot safely', scope: 'Sharpen only', ownerUserId: 'u1', nextTaskIds: ['TASK-002'] },
      },
      expect.any(Object),
    ));
  });

  test('keeps the draft visible and shows the latest focus after a revision conflict', async () => {
    const latest = { ...FOCUS, revision: 3, focus: { ...FOCUS.focus, goal: 'A newer goal' } };
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/focus')) return Promise.resolve({ data: FOCUS });
      if (url.startsWith('/api/v1/tasks/')) return Promise.resolve({ data: { tasks: TASKS } });
      if (url.startsWith('/api/pods/')) return Promise.resolve({ data: { name: 'My Workspace', members: [{ _id: 'u1', username: 'alice', isBot: false }] } });
      return Promise.resolve({ data: {} });
    });
    axios.patch.mockRejectedValueOnce({ response: { status: 409, data: { current: latest } } });
    renderBoard();

    await screen.findByText('Ship the pilot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit focus' }));
    fireEvent.change(screen.getByDisplayValue('Ship the pilot'), { target: { value: 'My retained draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save focus' }));

    expect(await screen.findByRole('heading', { name: 'Latest focus' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('My retained draft')).toBeInTheDocument();
    expect(screen.getAllByText('A newer goal').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Save focus' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review latest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save focus' }));
    await waitFor(() => expect(axios.patch).toHaveBeenLastCalledWith(
      '/api/pods/pod-1/focus',
      {
        expectedRevision: 3,
        focus: { goal: 'My retained draft', scope: 'Sharpen only', ownerUserId: 'u1', nextTaskIds: ['TASK-002'] },
      },
      expect.any(Object),
    ));
  });
});
