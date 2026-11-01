// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import V2PodBoard from '../components/V2PodBoard';
import { AuthContext } from '../../context/AuthContext';

let mockSocketValue = { socket: null, connected: false, joinPod: jest.fn(), leavePod: jest.fn() };
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
    if (url.startsWith('/api/v1/tasks/')) return Promise.resolve({ data: { tasks, permissions: { canWrite: true } } });
    if (url.startsWith('/api/pods/')) return Promise.resolve({ data: { name: 'My Workspace' } });
    return Promise.resolve({ data: {} });
  });
};

const boardTree = (entry = '/v2/pods/pod-1/board') => (
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/v2/pods/:podId/board" element={<V2PodBoard />} />
        <Route path="/v2/pods/:podId" element={<div>chat page</div>} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>
);

const renderBoard = (entry = '/v2/pods/pod-1/board') => render(boardTree(entry));

const SwitchPod = () => {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/v2/pods/pod-b/board')}>Switch pod</button>;
};

const renderNavigableBoard = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={['/v2/pods/pod-a/board']}>
      <SwitchPod />
      <Routes>
        <Route path="/v2/pods/:podId/board" element={<V2PodBoard />} />
        <Route path="/v2/pods/:podId" element={<div>chat page</div>} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

beforeEach(() => {
  jest.clearAllMocks();
  mockSocketValue = { socket: null, connected: false, joinPod: jest.fn(), leavePod: jest.fn() };
  wireAxios();
});

describe('V2PodBoard', () => {
  test('reloads tasks missed while the socket was disconnected', async () => {
    const socket = { on: jest.fn(), off: jest.fn() };
    mockSocketValue = { socket, connected: true, joinPod: jest.fn(), leavePod: jest.fn() };
    let taskReads = 0;
    axios.get.mockImplementation((url) => {
      if (url.startsWith('/api/v1/tasks/')) {
        taskReads += 1;
        return Promise.resolve({ data: { tasks: taskReads === 1 ? TASKS : [
          ...TASKS, { taskId: 'TASK-003', title: 'Missed during outage', status: 'pending', updates: [] },
        ] } });
      }
      if (url.endsWith('/focus')) return Promise.resolve({ data: FOCUS });
      if (url.startsWith('/api/pods/')) return Promise.resolve({ data: { name: 'My Workspace' } });
      return Promise.resolve({ data: {} });
    });

    const view = renderBoard();
    await screen.findByRole('region', { name: 'Pending' });
    expect(taskReads).toBe(1);

    act(() => {
      mockSocketValue = { ...mockSocketValue, connected: false };
      view.rerender(boardTree());
    });
    act(() => {
      mockSocketValue = { ...mockSocketValue, connected: true };
      view.rerender(boardTree());
    });

    expect(await screen.findByText('Missed during outage')).toBeInTheDocument();
    expect(taskReads).toBe(2);
  });

  test('shows the live claim countdown and then the expired owner without a reload', async () => {
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const dateTimeFormatSpy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation((locale, options) => new NativeDateTimeFormat(locale, {
      timeZone: 'America/Los_Angeles',
      ...options,
    }));
    const now = new Date('2026-10-15T22:00:00.000Z');
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    const task = {
      taskId: 'TASK-269', title: 'Show the lease', status: 'claimed',
      assignee: 'someone-else', claimedBy: 'forge-id', claimExpiresAt: expiresAt, updates: [],
    };
    const holderFromUpdate = {
      taskId: 'TASK-270', title: 'Renew the lease', status: 'claimed',
      claimedBy: 'kai-id', claimExpiresAt: expiresAt,
      updates: [{ text: 'Lease renewed', author: 'Kai', authorId: 'kai-id' }],
    };
    jest.useFakeTimers({ now });
    axios.get.mockImplementation((url) => {
      if (url.startsWith('/api/v1/tasks/')) return Promise.resolve({ data: { tasks: [task, holderFromUpdate] } });
      if (url.endsWith('/focus')) return Promise.resolve({ data: FOCUS });
      if (url.startsWith('/api/pods/')) return Promise.resolve({ data: {
        name: 'My Workspace', members: [{ _id: 'forge-id', username: 'forge', displayName: 'Forge' }],
      } });
      return Promise.resolve({ data: {} });
    });

    try {
      renderBoard();
      await act(async () => { await Promise.resolve(); });
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles');
      expect(screen.getByTitle('TASK-269')).toHaveTextContent('Forge · 1m left');
      expect(screen.getByTitle('TASK-270')).toHaveTextContent('Kai · 1m left');

      act(() => { jest.advanceTimersByTime(59_999); });
      expect(screen.getByTitle('TASK-269')).toHaveTextContent('Forge · 1m left');
      act(() => { jest.advanceTimersByTime(1); });
      expect(screen.queryByText(/1m left/)).not.toBeInTheDocument();
      expect(screen.getByText('lease expired · Forge')).toBeInTheDocument();
      expect(screen.getByText('lease expired · Kai')).toBeInTheDocument();
      expect(axios.get.mock.calls.filter(([url]) => url.startsWith('/api/v1/tasks/'))).toHaveLength(1);
    } finally {
      jest.useRealTimers();
      dateTimeFormatSpy.mockRestore();
    }
  });

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

  test('card shows the task id and priority badge alongside its title', async () => {
    renderBoard();

    const pending = await screen.findByRole('region', { name: 'Pending' });
    const card = within(pending).getByText('Give your agent its first task').closest('button');
    expect(card).toHaveAttribute('title', 'TASK-002');
    expect(card.querySelector('.v2-board__card-id')).toHaveTextContent('TASK-002');
    expect(card.querySelector('.v2-board__priority')).toHaveTextContent('P2');

    fireEvent.click(card);
    const dialog = await screen.findByRole('dialog', { name: 'Give your agent its first task' });
    expect(within(dialog).getByText('TASK-002')).toBeInTheDocument();
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
        { title: 'Ship it', priority: 'P2' },
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
    const joinPod = jest.fn();
    const leavePod = jest.fn();
    mockSocketValue = {
      socket: {
        on: (event, fn) => { handlers[event] = fn; },
        off: jest.fn(),
        emit: jest.fn(),
      },
      connected: true,
      joinPod,
      leavePod,
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

  test('joins the current pod room and hands ownership across navigation', async () => {
    const handlers = {};
    const joinPod = jest.fn();
    const leavePod = jest.fn();
    mockSocketValue = {
      socket: {
        on: (event, fn) => { handlers[event] = fn; },
        off: jest.fn(),
        emit: jest.fn(),
      },
      connected: true,
      joinPod,
      leavePod,
    };
    renderNavigableBoard();

    await screen.findByRole('region', { name: 'Pending' });
    expect(joinPod).toHaveBeenCalledWith('pod-a');

    fireEvent.click(screen.getByRole('button', { name: 'Switch pod' }));
    await screen.findByRole('region', { name: 'Pending' });
    expect(leavePod).toHaveBeenCalledWith('pod-a');
    expect(joinPod).toHaveBeenCalledWith('pod-b');
  });

  test('refreshes focus after reconnecting without a visibility change', async () => {
    const refreshed = { ...FOCUS, revision: 3, focus: { ...FOCUS.focus, goal: 'Reconnected focus' } };
    let focusCalls = 0;
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/focus')) {
        focusCalls += 1;
        return Promise.resolve({ data: focusCalls === 1 ? FOCUS : refreshed });
      }
      if (url.startsWith('/api/v1/tasks/')) return Promise.resolve({ data: { tasks: TASKS } });
      if (url.startsWith('/api/pods/')) return Promise.resolve({ data: { name: 'My Workspace' } });
      return Promise.resolve({ data: {} });
    });
    const handlers = {};
    mockSocketValue = {
      socket: {
        on: (event, fn) => { handlers[event] = fn; },
        off: jest.fn(),
      },
      connected: true,
      joinPod: jest.fn(),
      leavePod: jest.fn(),
    };
    renderBoard();
    expect(await screen.findByText('Ship the pilot')).toBeInTheDocument();
    expect(focusCalls).toBe(1);

    act(() => { handlers.connect(); });
    await waitFor(() => expect(screen.getByText('Reconnected focus')).toBeInTheDocument());
    expect(focusCalls).toBe(2);
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

  test('keeps focus on a moved task and announces its new position', async () => {
    const orderedFocus = {
      ...FOCUS,
      focus: {
        ...FOCUS.focus,
        nextTasks: [
          { taskId: 'TASK-001', available: true, title: 'Connect your first agent', status: 'done', assignee: null, updatedAt: null },
          { taskId: 'TASK-002', available: true, title: 'Give your agent its first task', status: 'pending', assignee: null, updatedAt: null },
        ],
      },
    };
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/focus')) return Promise.resolve({ data: orderedFocus });
      if (url.startsWith('/api/v1/tasks/')) return Promise.resolve({ data: { tasks: TASKS } });
      if (url.startsWith('/api/pods/')) return Promise.resolve({ data: { name: 'My Workspace', members: [{ _id: 'u1', username: 'alice', isBot: false }] } });
      return Promise.resolve({ data: {} });
    });
    renderBoard();

    await screen.findByText('Ship the pilot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit focus' }));
    const selected = screen.getByTestId('focus-selected');
    fireEvent.click(screen.getAllByRole('button', { name: 'Up' })[1]);

    expect(await screen.findByText('TASK-002 moved to position 1 of 2.')).toBeInTheDocument();
    const rows = selected.querySelectorAll('li');
    expect(rows[0]).toHaveTextContent('TASK-002');
    expect(document.activeElement).toBe(rows[0]);
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

  test('pins the draft revision while a background refresh lands', async () => {
    const refreshed = { ...FOCUS, revision: 3, focus: { ...FOCUS.focus, goal: 'Background update' } };
    let focusCalls = 0;
    const handlers = {};
    const joinPod = jest.fn();
    const leavePod = jest.fn();
    mockSocketValue = {
      socket: {
        on: (event, fn) => { handlers[event] = fn; },
        off: jest.fn(),
      },
      connected: true,
      joinPod,
      leavePod,
    };
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/focus')) {
        focusCalls += 1;
        return Promise.resolve({ data: focusCalls === 1 ? FOCUS : refreshed });
      }
      if (url.startsWith('/api/v1/tasks/')) return Promise.resolve({ data: { tasks: TASKS } });
      if (url.startsWith('/api/pods/')) return Promise.resolve({ data: { name: 'My Workspace', members: [{ _id: 'u1', username: 'alice', isBot: false }] } });
      return Promise.resolve({ data: {} });
    });
    renderBoard();

    await screen.findByText('Ship the pilot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit focus' }));
    fireEvent.change(screen.getByDisplayValue('Ship the pilot'), { target: { value: 'Draft from revision 2' } });
    act(() => { handlers.pod_focus_updated({ podId: 'pod-1', revision: 3 }); });
    await waitFor(() => expect(screen.getByText('Background update')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('Draft from revision 2'), { target: { value: 'Draft after refresh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save focus' }));

    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
      '/api/pods/pod-1/focus',
      expect.objectContaining({ expectedRevision: 2 }),
      expect.any(Object),
    ));
  });

  test('drops late pod reads and saves without clearing the next pod state', async () => {
    const aFocus = { ...FOCUS, podId: 'pod-a', revision: 9, focus: { ...FOCUS.focus, goal: 'A focus' } };
    const bFocus = { ...FOCUS, podId: 'pod-b', revision: 1, focus: { ...FOCUS.focus, goal: 'B focus' } };
    const lateARead = { ...aFocus, revision: 10, focus: { ...aFocus.focus, goal: 'Late A focus' } };
    let focusCalls = 0;
    let resolveLateARead;
    const lateAReadPromise = new Promise((resolve) => { resolveLateARead = resolve; });
    const patchResolvers = [];
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/focus')) {
        focusCalls += 1;
        if (focusCalls === 1) return Promise.resolve({ data: aFocus });
        if (focusCalls === 2) return lateAReadPromise;
        return Promise.resolve({ data: bFocus });
      }
      if (url.startsWith('/api/v1/tasks/')) return Promise.resolve({ data: { tasks: TASKS } });
      if (url.startsWith('/api/pods/')) return Promise.resolve({ data: { name: 'My Workspace', members: [{ _id: 'u1', username: 'alice', isBot: false }] } });
      return Promise.resolve({ data: {} });
    });
    axios.patch.mockImplementation(() => new Promise((resolve) => { patchResolvers.push(resolve); }));
    renderNavigableBoard();

    await screen.findByText('A focus');
    fireEvent.click(screen.getByRole('button', { name: 'Edit focus' }));
    fireEvent.change(screen.getByDisplayValue('A focus'), { target: { value: 'A draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save focus' }));
    await waitFor(() => expect(patchResolvers).toHaveLength(1));

    // Start a second A read through the page visibility path, then navigate.
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(focusCalls).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Switch pod' }));
    await screen.findByText('B focus');
    resolveLateARead({ data: lateARead });
    await waitFor(() => expect(screen.queryByText('Late A focus')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit focus' }));
    fireEvent.change(screen.getByDisplayValue('B focus'), { target: { value: 'B draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save focus' }));
    await waitFor(() => expect(patchResolvers).toHaveLength(2));
    await act(async () => {
      patchResolvers[0]({ data: aFocus });
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => {
      patchResolvers[1]({ data: bFocus });
      await Promise.resolve();
    });
    expect(screen.getByText('B focus')).toBeInTheDocument();
  });
});

test('priority orders cards, separates assignment from claim, and edits the stored priority', async () => {
  const task = { taskId: 'TASK-9', taskNum: 9, title: 'Urgent work', priority: 'P0', status: 'claimed', assignee: 'rivet', claimedBy: 'u2', claimExpiresAt: new Date(Date.now() + 18 * 60000).toISOString(), watchers: [], updates: [] };
  const low = { ...task, taskId: 'TASK-1', taskNum: 1, title: 'Later work', priority: 'P3', status: 'claimed' };
  wireAxios([low, task]);
  axios.patch.mockResolvedValue({ data: { task: { ...task, priority: 'P1' } } });
  renderBoard();
  await screen.findByText('Urgent work');
  const cards = within(screen.getByRole('region', { name: 'In Progress' })).getAllByRole('article');
  expect(cards[0]).toHaveTextContent('TASK-9');
  fireEvent.click(screen.getByTitle('TASK-9'));
  const dialog = screen.getByRole('dialog', { name: /Urgent work/ });
  expect(within(dialog).getByText('Assigned to').nextElementSibling).toHaveTextContent('rivet');
  expect(within(dialog).getByText('Claimed by').nextElementSibling).toHaveTextContent('u2');
  fireEvent.change(within(dialog).getByLabelText('Priority'), { target: { value: 'P1' } });
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/api/v1/tasks/pod-1/TASK-9', { priority: 'P1' }, expect.any(Object)));
  expect(await within(dialog).findByDisplayValue('P1')).toBeInTheDocument();
});

test('follow is self-service and shows a failed request without changing subscription state', async () => {
  const task = { taskId: 'TASK-1', title: 'Follow this', status: 'pending', watchers: [], updates: [] };
  wireAxios([task]);
  axios.post.mockRejectedValueOnce(new Error('offline'));
  renderBoard();
  fireEvent.click(await screen.findByTitle('TASK-1'));
  const follow = screen.getByRole('button', { name: 'Follow task' });
  fireEvent.click(follow);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
  expect(follow).toHaveAttribute('aria-pressed', 'false');
  axios.post.mockResolvedValueOnce({ data: { task: { ...task, watchers: ['u1'] } } });
  wireAxios([{ ...task, watchers: ['u1'] }]);
  fireEvent.click(follow);
  expect(await screen.findByRole('button', { name: /Following/ })).toHaveAttribute('aria-pressed', 'true');
  expect(axios.post).toHaveBeenLastCalledWith('/api/v1/tasks/pod-1/TASK-1/watch', { following: true }, expect.any(Object));
  expect(screen.getByText('alice')).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});


test('viewer priority is read-only while follow remains available', async () => {
  const task = { taskId: 'TASK-1', title: 'Read this', priority: 'P2', status: 'pending', watchers: [] };
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.startsWith('/api/v1/tasks/') ? { tasks: [task], permissions: { canWrite: false } } : {} }));
  renderBoard();
  fireEvent.click(await screen.findByTitle('TASK-1'));
  expect(screen.getByLabelText('Priority')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Follow task' })).toBeEnabled();
});

test('drawer traps keyboard focus and restores its opener', async () => {
  wireAxios([{ taskId: 'TASK-1', title: 'Focus here', status: 'pending', watchers: [] }]);
  renderBoard();
  const opener = await screen.findByTitle('TASK-1');
  opener.focus();
  fireEvent.click(opener);
  const close = screen.getByRole('button', { name: 'Close' });
  expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  const buttons = within(screen.getByRole('dialog')).getAllByRole('button');
  expect(buttons[buttons.length - 1]).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(opener).toHaveFocus();
});

test('a detail save replaces an invalidated socket read, preserving another row update', async () => {
  const first = { taskId: 'TASK-1', title: 'First', priority: 'P2', status: 'pending', watchers: [] };
  const second = { taskId: 'TASK-2', title: 'Second', priority: 'P2', status: 'pending', watchers: [] };
  const socket = { on: jest.fn(), off: jest.fn() };
  mockSocketValue = { socket, connected: true, joinPod: jest.fn(), leavePod: jest.fn() };
  let resolvePending;
  let reads = 0;
  axios.get.mockImplementation((url) => {
    if (!url.startsWith('/api/v1/tasks/')) return Promise.resolve({ data: {} });
    reads += 1;
    if (reads === 2) return new Promise((resolve) => { resolvePending = resolve; });
    return Promise.resolve({ data: { tasks: reads === 1 ? [first, second] : [{ ...first, priority: 'P0' }, { ...second, title: 'Second changed' }], permissions: { canWrite: true } } });
  });
  axios.patch.mockResolvedValueOnce({ data: { task: { ...first, priority: 'P0' } } });
  renderBoard();
  fireEvent.click(await screen.findByTitle('TASK-1'));
  act(() => socket.on.mock.calls.find(([name]) => name === 'task_updated')[1]({ podId: 'pod-1' }));
  fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'P0' } });
  expect(await screen.findByText('Second changed')).toBeInTheDocument();
  await act(async () => { resolvePending({ data: { tasks: [first, second], permissions: { canWrite: true } } }); });
  expect(screen.getByText('Second changed')).toBeInTheDocument();
});


test('Follow keeps focus during a pending request and refuses a second click', async () => {
  const task = { taskId: 'TASK-1', title: 'Follow focus', status: 'pending', watchers: [] };
  wireAxios([task]);
  let finishFollow;
  axios.post.mockImplementationOnce(() => new Promise((resolve) => { finishFollow = resolve; }));
  renderBoard();
  fireEvent.click(await screen.findByTitle('TASK-1'));
  const follow = screen.getByRole('button', { name: 'Follow task' });
  follow.focus();
  fireEvent.click(follow);
  expect(follow).toHaveAttribute('aria-disabled', 'true');
  expect(follow).not.toBeDisabled();
  expect(follow).toHaveFocus();
  fireEvent.click(follow);
  expect(axios.post).toHaveBeenCalledTimes(1);
  wireAxios([{ ...task, watchers: ['u1'] }]);
  await act(async () => { finishFollow({ data: { task: { ...task, watchers: ['u1'] } } }); });
  expect(follow).toHaveAttribute('aria-disabled', 'false');
  expect(follow).toHaveAttribute('aria-pressed', 'true');
  expect(follow).toHaveFocus();
});


test('a delayed Follow response cannot replace another follower from the current server state', async () => {
  const task = { taskId: 'TASK-1', title: 'Concurrent follow', status: 'pending', watchers: [] };
  wireAxios([task]);
  let finishFollow;
  axios.post.mockImplementationOnce(() => new Promise((resolve) => { finishFollow = resolve; }));
  renderBoard();
  fireEvent.click(await screen.findByTitle('TASK-1'));
  fireEvent.click(screen.getByRole('button', { name: 'Follow task' }));
  // Both writes commit while the first response is delayed. No GET is pending.
  wireAxios([{ ...task, watchers: ['u1', 'u2'] }]);
  await act(async () => { finishFollow({ data: { task: { ...task, watchers: ['u1'] } } }); });
  expect(await screen.findByRole('button', { name: /Following/ })).toHaveAttribute('aria-pressed', 'true');
  expect(document.querySelectorAll('.v2-board__watcher')).toHaveLength(2);
});

test('the drawer links to the task record only when the server says the reader may read it', async () => {
  const POD = 'aaaaaaaaaaaaaaaaaaaaaaa1';
  const task = { taskId: 'TASK-7', title: 'Recorded work', status: 'claimed', watchers: [] };
  let canReadRecord = true;
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.startsWith('/api/v1/tasks/')
    ? { tasks: [task], permissions: { canWrite: true, canReadRecord } } : {} }));
  const { unmount } = renderBoard(`/v2/pods/${POD}/board`);
  fireEvent.click(await screen.findByTitle('TASK-7'));
  expect(screen.getByRole('link', { name: 'View record' })).toHaveAttribute('href', `/v2/pods/${POD}/tasks/TASK-7/record`);
  unmount();

  canReadRecord = false;
  renderBoard(`/v2/pods/${POD}/board`);
  fireEvent.click(await screen.findByTitle('TASK-7'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'View record' })).toBeNull();
});

test('detail status is a segment that moves the task, and older updates fold behind a toggle', async () => {
  const updates = ['one', 'two', 'three', 'four', 'five'].map((text) => ({ text, author: 'Kai', authorId: 'kai-id' }));
  const task = { taskId: 'TASK-5', title: 'Segmented', status: 'pending', watchers: [], updates };
  wireAxios([task]);
  axios.patch.mockResolvedValue({ data: { task: { ...task, status: 'claimed' } } });
  renderBoard();
  fireEvent.click(await screen.findByTitle('TASK-5'));
  const dialog = screen.getByRole('dialog', { name: /Segmented/ });
  const segment = within(dialog).getByRole('radiogroup', { name: 'Status' });
  expect(within(segment).getByRole('radio', { name: 'Pending' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(within(segment).getByRole('radio', { name: /in progress/i }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/api/v1/tasks/pod-1/TASK-5', { status: 'claimed' }, expect.any(Object)));
  // Newest three show; the two oldest fold behind the toggle.
  expect(within(dialog).queryByText('one')).toBeNull();
  expect(within(dialog).queryByText('two')).toBeNull();
  expect(within(dialog).getByText('five')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Show 2 earlier updates' }));
  expect(within(dialog).getByText('one')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Hide earlier updates' })).toHaveAttribute('aria-expanded', 'true');
});
