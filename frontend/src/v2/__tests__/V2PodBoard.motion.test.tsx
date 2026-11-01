// @ts-nocheck
// The board's motion moments from the motion spec: a live column change
// glides through a view transition at 1440, fades out of the open tab at 390, and
// the task drawer stays mounted until its slide out ends.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2PodBoard from '../components/V2PodBoard';
import { AuthContext } from '../../context/AuthContext';
import { EXIT_SAFETY_MS, viewTransitionName } from '../utils/motion';

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

const PENDING = [
  { taskId: 'TASK-1', title: 'Claim me', status: 'pending', updates: [] },
  { taskId: 'TASK-2', title: 'Stay put', status: 'pending', updates: [] },
];
const CLAIMED = [
  { ...PENDING[0], status: 'claimed', claimedBy: 'u1', claimExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
  PENDING[1],
];

let taskRows = PENDING;
const wireAxios = () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/v1/tasks/')) return Promise.resolve({ data: { tasks: taskRows, permissions: { canWrite: true } } });
    if (url.startsWith('/api/pods/')) return Promise.resolve({ data: { name: 'Pod', members: [{ _id: 'u1', username: 'alice' }] } });
    return Promise.resolve({ data: {} });
  });
};

let media = { phone: false, reduce: false };
const realMatchMedia = window.matchMedia;
const realGetComputedStyle = window.getComputedStyle;

const handlers = {};
const liveSocket = () => {
  mockSocketValue = {
    socket: { on: (event, fn) => { handlers[event] = fn; }, off: jest.fn(), emit: jest.fn() },
    connected: true,
    joinPod: jest.fn(),
    leavePod: jest.fn(),
  };
};

const renderBoard = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={['/v2/pods/pod-1/board']}>
      <Routes>
        <Route path="/v2/pods/:podId/board" element={<V2PodBoard />} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

const column = (name) => screen.getByRole('region', { name });
const liveUpdate = async (rows) => {
  taskRows = rows;
  await act(async () => { handlers.task_updated({ podId: 'pod-1' }); });
};

beforeEach(() => {
  jest.clearAllMocks();
  taskRows = PENDING;
  media = { phone: false, reduce: false };
  window.matchMedia = jest.fn().mockImplementation((query) => ({
    matches: query.includes('reduced-motion') ? media.reduce : query.includes('max-width') ? media.phone : false,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
  liveSocket();
  wireAxios();
  delete document.startViewTransition;
  document.documentElement.classList.remove('v2-board-glide');
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  window.getComputedStyle = realGetComputedStyle;
  delete document.startViewTransition;
});

const stubViewTransitions = () => {
  const seen = [];
  document.startViewTransition = jest.fn((update) => {
    // What the browser captures as the old state: the glide class and the named columns.
    seen.push({
      glide: document.documentElement.classList.contains('v2-board-glide'),
      named: Array.from(document.querySelectorAll('.v2-board__col[data-glide]')).map((node) => node.getAttribute('aria-label')),
    });
    update();
    return { finished: Promise.resolve() };
  });
  return seen;
};

describe('board motion: an agent claims a task', () => {
  test('each card carries a CSS-safe task-<id> view-transition name', async () => {
    taskRows = [{ taskId: 'odd id/1.2_x', title: 'Odd', status: 'pending', updates: [] }];
    renderBoard();
    const card = (await screen.findByText('Odd')).closest('article');
    expect(card.style.getPropertyValue('--v2-task-vt')).toBe(viewTransitionName('task', 'odd id/1.2_x'));
    expect(viewTransitionName('task', 'odd id/1.2_x')).toMatch(/^task-[A-Za-z0-9_-]+$/);
    // Escaping the underscore keeps two ids from sharing a name.
    expect(viewTransitionName('task', 'a_2e_')).not.toBe(viewTransitionName('task', 'a.'));
  });

  test('a live column change at 1440 runs inside startViewTransition and the card lands in its new column', async () => {
    const seen = stubViewTransitions();
    renderBoard();
    await within(await screen.findByRole('region', { name: 'Pending' })).findByText('Claim me');
    expect(document.startViewTransition).not.toHaveBeenCalled();

    await liveUpdate(CLAIMED);

    expect(document.startViewTransition).toHaveBeenCalledTimes(1);
    expect(seen[0].glide).toBe(true);
    expect(seen[0].named.sort()).toEqual(['In Progress', 'Pending']);
    expect(within(column('In Progress')).getByText('Claim me')).toBeInTheDocument();
    expect(within(column('Pending')).queryByText('Claim me')).toBeNull();
    // Once it has landed the class goes, so the lease ring starts pulsing.
    await waitFor(() => expect(document.documentElement.classList.contains('v2-board-glide')).toBe(false));
    expect(document.querySelector('.v2-board__col[data-glide]')).toBeNull();
  });

  test('an edit that lands while a glide waits is not overwritten by the older rows', async () => {
    let pending = null;
    document.startViewTransition = jest.fn((update) => { pending = update; return { finished: Promise.resolve() }; });
    renderBoard();
    fireEvent.click(await within(await screen.findByRole('region', { name: 'Pending' })).findByText('Stay put'));
    const priority = await screen.findByLabelText(/priority/i);

    await liveUpdate(CLAIMED);
    expect(pending).not.toBeNull();

    // The edit resolves inside the gap; the server now holds P0 for TASK-2.
    taskRows = [CLAIMED[0], { ...PENDING[1], priority: 'P0' }];
    axios.patch.mockResolvedValueOnce({ data: { task: { ...PENDING[1], priority: 'P0', updatedAt: new Date().toISOString() } } });
    await act(async () => { fireEvent.change(priority, { target: { value: 'P0' } }); });

    await act(async () => { pending(); });
    await waitFor(() => expect(screen.getByLabelText(/priority/i)).toHaveValue('P0'));
  });

  test('no glide under reduced motion: the card is simply in its new column', async () => {
    stubViewTransitions();
    media.reduce = true;
    renderBoard();
    await within(await screen.findByRole('region', { name: 'Pending' })).findByText('Claim me');
    await liveUpdate(CLAIMED);
    expect(document.startViewTransition).not.toHaveBeenCalled();
    expect(within(column('In Progress')).getByText('Claim me')).toBeInTheDocument();
  });

  test('no glide on first load, even for a claim already made elsewhere', async () => {
    stubViewTransitions();
    taskRows = CLAIMED;
    renderBoard();
    await within(await screen.findByRole('region', { name: 'In Progress' })).findByText('Claim me');
    expect(document.startViewTransition).not.toHaveBeenCalled();
  });

  test('no glide for a task first seen already claimed: it was never on this board to move', async () => {
    stubViewTransitions();
    taskRows = [PENDING[1]];
    renderBoard();
    await within(await screen.findByRole('region', { name: 'Pending' })).findByText('Stay put');
    await liveUpdate(CLAIMED);
    expect(within(column('In Progress')).getByText('Claim me')).toBeInTheDocument();
    expect(document.startViewTransition).not.toHaveBeenCalled();
  });

  test('no glide on a refetch the user started (creating a task)', async () => {
    stubViewTransitions();
    renderBoard();
    await within(await screen.findByRole('region', { name: 'Pending' })).findByText('Claim me');
    taskRows = CLAIMED;
    fireEvent.click(screen.getAllByRole('button', { name: 'New task' })[0]);
    fireEvent.change(screen.getByPlaceholderText(/what needs/i), { target: { value: 'Another' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create task' })); });
    await within(column('In Progress')).findByText('Claim me');
    expect(document.startViewTransition).not.toHaveBeenCalled();
  });

  test('without the API a live change still lands, at once', async () => {
    renderBoard();
    await within(await screen.findByRole('region', { name: 'Pending' })).findByText('Claim me');
    await liveUpdate(CLAIMED);
    expect(within(column('In Progress')).getByText('Claim me')).toBeInTheDocument();
    expect(document.documentElement.classList.contains('v2-board-glide')).toBe(false);
  });
});

describe('board motion at 390: a card leaves the open tab', () => {
  test('it fades toward its new tab, that tab ticks, and the open tab stays put', async () => {
    stubViewTransitions();
    media.phone = true;
    renderBoard();
    await within(await screen.findByRole('region', { name: 'Pending' })).findByText('Claim me');

    await liveUpdate(CLAIMED);

    expect(document.startViewTransition).not.toHaveBeenCalled();
    const ghost = within(column('Pending')).getByText('Claim me').closest('article');
    expect(ghost).toHaveClass('is-leaving', 'is-leaving--next');
    expect(ghost).toHaveAttribute('inert');
    expect(screen.getByRole('tab', { name: /Pending/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /In Progress/ }).querySelector('.v2-board__tab-count')).toHaveClass('is-ticking');
    expect(screen.getByRole('tab', { name: /Pending/ }).querySelector('.v2-board__tab-count')).not.toHaveClass('is-ticking');

    fireEvent.animationEnd(ghost);
    expect(within(column('Pending')).queryByText('Claim me')).toBeNull();
  });

  test('a card going back a tab fades the other way, and leaves even with no animationend', async () => {
    media.phone = true;
    taskRows = CLAIMED;
    renderBoard();
    await within(await screen.findByRole('region', { name: 'Pending' })).findByText('Stay put');
    fireEvent.click(screen.getByRole('tab', { name: /In Progress/ }));
    await liveUpdate(PENDING);
    const ghost = within(column('In Progress')).getByText('Claim me').closest('article');
    expect(ghost).toHaveClass('is-leaving--prev');
    await waitFor(() => expect(within(column('In Progress')).queryByText('Claim me')).toBeNull(), { timeout: EXIT_SAFETY_MS + 500 });
  });

  test('no leaving card under reduced motion', async () => {
    media.phone = true;
    media.reduce = true;
    renderBoard();
    await within(await screen.findByRole('region', { name: 'Pending' })).findByText('Claim me');
    await liveUpdate(CLAIMED);
    expect(within(column('Pending')).queryByText('Claim me')).toBeNull();
  });
});

describe('board motion: the task drawer', () => {
  // jsdom has no animations; report the exit animation the stylesheet would apply.
  const withExitAnimation = () => {
    window.getComputedStyle = (node, pseudo) => new Proxy(realGetComputedStyle(node, pseudo), {
      get(target, key) {
        if (key === 'animationName') return node.hasAttribute?.('data-leaving') ? 'v2-board-drawer-out' : 'v2-board-drawer-in';
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const openDrawer = async () => {
    renderBoard();
    fireEvent.click(await screen.findByText('Claim me'));
    return screen.getByRole('dialog', { name: 'Claim me' });
  };

  test('closing keeps it mounted and inert until its slide out ends', async () => {
    withExitAnimation();
    const drawer = await openDrawer();
    expect(drawer).not.toHaveAttribute('data-leaving');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));

    const leaving = document.querySelector('.v2-board__drawer');
    expect(leaving).toHaveAttribute('data-leaving');
    expect(leaving.parentElement).toHaveAttribute('inert');
    expect(leaving.parentElement).toHaveAttribute('data-leaving');
    fireEvent.animationEnd(leaving);
    expect(document.querySelector('.v2-board__drawer')).toBeNull();
  });

  test('a drawer whose exit never reports back still unmounts', async () => {
    withExitAnimation();
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(document.querySelector('.v2-board__drawer')).not.toBeNull();
    await waitFor(() => expect(document.querySelector('.v2-board__drawer')).toBeNull(), { timeout: EXIT_SAFETY_MS + 500 });
  });

  test('under reduced motion it closes at once', async () => {
    withExitAnimation();
    media.reduce = true;
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(document.querySelector('.v2-board__drawer')).toBeNull();
  });
});
