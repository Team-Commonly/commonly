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

  test('the preview note names the daemon machine in "on my computer" mode (#TASK-163)', async () => {
    // Before TASK-163 the note read "Appears in the pod once your runtime
    // connects with the token" in EVERY non-hosted mode, and this mode issues
    // no token at all — ux-lead measured it drawing README frame 5. The name
    // is derived once from machines+machineId, so this pins that it FOLLOWS
    // the picker rather than merely being present.
    const second = { id: 'm2', machineId: 'mach-b', name: 'Studio', status: 'online', agentStates: [] };
    mockGet({ machines: [machineRow, second] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());

    // Default mode is 'byo', where the token wording is still correct.
    expect(screen.getByTestId('byo-preview')).toHaveTextContent('Appears in the pod once your runtime connects with the token.');

    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    expect(screen.getByTestId('byo-preview')).toHaveTextContent('Appears in the pod once the daemon on Sam’s MacBook starts it.');

    fireEvent.change(screen.getByTestId('byo-machine-select'), { target: { value: 'mach-b' } });
    expect(screen.getByTestId('byo-preview')).toHaveTextContent('Appears in the pod once the daemon on Studio starts it.');
  });

  test('no machines — no card, and the one-paste setup panel shows instead', async () => {
    mockGet({ machines: [] });
    renderPage();
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/machines', expect.anything()));
    expect(screen.queryByTestId('byo-mode-machine')).toBeNull();
    expect(screen.getByTestId('byo-add-computer')).toBeInTheDocument();
    expect(screen.getByTestId('byo-add-computer')).toHaveTextContent('commonly daemon register && commonly daemon install');
  });

  test('with machines the setup panel is gone', async () => {
    mockGet();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    expect(screen.queryByTestId('byo-add-computer')).toBeNull();
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

  test('a persona hire onto a machine carries the persona sentence too (#1649)', async () => {
    mockGet();
    axios.post.mockResolvedValue({ data: {} });
    window.history.pushState({}, '', '/v2/agents/byo?persona=recorder&pod=p1');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    fireEvent.click(screen.getByText('Add to this computer'));
    await waitFor(() => expect(screen.getByTestId('byo-machine-result')).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
      description: "The room's memory. Keeps decisions, corrections and who asked for what.",
      config: expect.objectContaining({ persona: 'recorder', runtime: { runtimeType: 'wrapper' } }),
    }), expect.anything());
    window.history.pushState({}, '', '/');
  });

  test('a chosen model rides the install as config.runtime.model; the default sends none', async () => {
    mockGet();
    axios.post.mockResolvedValue({ data: {} });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    fireEvent.change(screen.getByTestId('byo-model-select'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByText('Add to this computer'));

    await waitFor(() => expect(screen.getByTestId('byo-machine-result')).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
      config: expect.objectContaining({ runtime: { runtimeType: 'wrapper', model: 'opus' } }),
    }), expect.anything());
  });

  test('every avatar the route renders is under the one carrier the square rule is scoped to (TASK-166 item 7)', async () => {
    // The rule is `.v2-byo__layout .v2-avatar` — a descendant selector, so its
    // correctness is a DOM fact, not a CSS one: it goes silently dead the day an
    // avatar moves outside that div (the TASK-160 shape, a rule that matches
    // nothing). jsdom matches selectors even without a layout engine, so this is
    // testable here; what stays ux-lead's browser gate is the rendered box (the
    // 4px square and the cobalt dot), which jsdom structurally cannot see.
    mockGet();
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-preview')).toBeInTheDocument());

    const matched = container.querySelectorAll('.v2-byo__layout .v2-avatar');
    const page = container.querySelectorAll('.v2-feature__body .v2-avatar');
    expect(matched.length).toBeGreaterThan(0);
    // Both directions, scoped to the page's own content: an avatar inside the
    // page but outside the carrier keeps the global round radius while its
    // neighbours are square — the defect item 7 exists to prevent.
    expect(page.length).toBe(matched.length);
    // Non-vacuity for that scoping, and the named exception: the rail's account
    // avatar is chrome outside the page body, still round with a green lens. The
    // row leaves it alone on purpose (it is a pre-existing consumer on every
    // route), so this asserts the exclusion is real rather than an empty set.
    expect(container.querySelectorAll('.v2-rail__account .v2-avatar').length).toBe(1);
  });
});
