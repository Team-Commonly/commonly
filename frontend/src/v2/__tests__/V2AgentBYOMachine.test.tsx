// @ts-nocheck
// Keep setup request assertions independent of funnel telemetry.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
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
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
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

  test('adapter and model edits do not clear an unrelated field error', async () => {
    mockGet();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());

    fireEvent.change(screen.getByPlaceholderText('my-mcp-agent'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Add to this computer'));

    const nameField = screen.getByPlaceholderText('my-mcp-agent').closest('label');
    expect(nameField).toHaveClass('v2-byo__field--error');

    fireEvent.change(screen.getByTestId('byo-adapter-select'), { target: { value: 'codex' } });
    expect(nameField).toHaveClass('v2-byo__field--error');
    fireEvent.change(screen.getByTestId('byo-model-select'), { target: { value: 'gpt-6-sol' } });
    expect(nameField).toHaveClass('v2-byo__field--error');
  });

  test('the preview stays visual-only when the mode or machine changes', async () => {
    const second = { id: 'm2', machineId: 'mach-b', name: 'Studio', status: 'online', agentStates: [] };
    mockGet({ machines: [machineRow, second] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());

    const preview = screen.getByTestId('byo-preview');
    expect(preview).not.toHaveTextContent('This is how it will appear in the pod. The face follows the name.');

    // On "Bring your own runtime", the token wording is correct.
    fireEvent.click(screen.getByTestId('byo-mode-byo'));
    expect(preview).not.toHaveTextContent('Appears in the pod once the command is running.');

    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    expect(preview).not.toHaveTextContent('Appears in the pod once the daemon on Sam’s MacBook starts it.');

    fireEvent.change(screen.getByTestId('byo-machine-select'), { target: { value: 'mach-b' } });
    expect(preview).not.toHaveTextContent('Appears in the pod once the daemon on Studio starts it.');
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
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
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
    fireEvent.change(screen.getByRole('combobox', { name: /pod it joins/i }), { target: { value: 'p2' } });
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
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());
    fireEvent.click(screen.getByText('Add to this computer'));

    await waitFor(() => expect(screen.getByTestId('byo-machine-result')).toBeInTheDocument());
    // A computer placement defaults to `<user>-<adapter|local>`, never to the
    // hosted agent's `<user>-agent` (C14 rehearsal, 2026-10-20).
    expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
      agentName: 'sam-local',
      instanceId: 'default',
      podId: 'p1',
      config: expect.objectContaining({ runtime: { runtimeType: 'wrapper' } }),
    }), expect.anything());
    expect(axios.post).toHaveBeenCalledWith('/api/agent-binding/request', {
      agentName: 'sam-local', instanceId: 'default', machineId: 'mach-a',
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
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());
    fireEvent.click(screen.getByText('Add to this computer'));
    await waitFor(() => expect(screen.getByTestId('byo-machine-result')).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
      description: "The room's memory. Keeps decisions, corrections and who asked for what.",
      instanceId: 'default',
      config: expect.objectContaining({ persona: 'recorder', runtime: { runtimeType: 'wrapper' } }),
    }), expect.anything());
    window.history.pushState({}, '', '/');
  });

  test('Codex suggests four plain catalog slugs and submits a chosen model', async () => {
    mockGet();
    axios.post.mockResolvedValue({ data: {} });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));

    fireEvent.change(screen.getByTestId('byo-adapter-select'), { target: { value: 'codex' } });
    const modelInput = screen.getByTestId('byo-model-select');
    expect(modelInput).toHaveAttribute('type', 'text');
    expect(modelInput).toHaveAttribute('list', 'byo-codex-models');
    const suggestions = Array.from(document.querySelectorAll('#byo-codex-models option'));
    expect(suggestions.map((option) => option.getAttribute('value'))).toEqual([
      'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra',
    ]);
    expect(suggestions.map((option) => option.getAttribute('label'))).toEqual([
      'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra',
    ]);
    expect(screen.getByText(/suggestions only.*catalog on that machine/i)).toBeInTheDocument();
    fireEvent.change(modelInput, { target: { value: 'gpt-6-sol' } });
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());
    fireEvent.click(screen.getByText('Add to this computer'));

    await waitFor(() => expect(screen.getByTestId('byo-machine-result')).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
      config: expect.objectContaining({ runtime: { runtimeType: 'wrapper', adapter: 'codex', model: 'gpt-6-sol' } }),
    }), expect.anything());
  });

  test('Codex accepts a catalog slug beyond the suggestions', async () => {
    mockGet();
    axios.post.mockResolvedValue({ data: {} });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    fireEvent.change(screen.getByTestId('byo-adapter-select'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByTestId('byo-model-select'), { target: { value: 'future-catalog-slug' } });
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());
    fireEvent.click(screen.getByText('Add to this computer'));

    await waitFor(() => expect(screen.getByTestId('byo-machine-result')).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
      config: expect.objectContaining({ runtime: { runtimeType: 'wrapper', adapter: 'codex', model: 'future-catalog-slug' } }),
    }), expect.anything());
  });

  test('Claude offers stable aliases and submits the selected model', async () => {
    mockGet();
    axios.post.mockResolvedValue({ data: {} });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    fireEvent.change(screen.getByTestId('byo-adapter-select'), { target: { value: 'claude' } });
    const modelSelect = screen.getByTestId('byo-model-select');
    expect(modelSelect.tagName).toBe('SELECT');
    expect(Array.from(modelSelect.querySelectorAll('option')).map((option) => option.value)).toEqual([
      '', 'opus', 'sonnet', 'haiku',
    ]);
    fireEvent.change(modelSelect, { target: { value: 'sonnet' } });
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());
    fireEvent.click(screen.getByText('Add to this computer'));

    await waitFor(() => expect(screen.getByTestId('byo-machine-result')).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
      config: expect.objectContaining({ runtime: { runtimeType: 'wrapper', adapter: 'claude', model: 'sonnet' } }),
    }), expect.anything());
  });

  test('Claude with its default model submits only the adapter', async () => {
    mockGet();
    axios.post.mockResolvedValue({ data: {} });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    fireEvent.change(screen.getByTestId('byo-adapter-select'), { target: { value: 'claude' } });
    expect(screen.getByTestId('byo-model-select')).toHaveValue('');
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());
    fireEvent.click(screen.getByText('Add to this computer'));

    await waitFor(() => expect(screen.getByTestId('byo-machine-result')).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
      config: expect.objectContaining({ runtime: { runtimeType: 'wrapper', adapter: 'claude' } }),
    }), expect.anything());
  });

  test('switching from Codex and its model to Claude clears the model', async () => {
    mockGet();
    axios.post.mockResolvedValue({ data: {} });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    const adapterSelect = screen.getByTestId('byo-adapter-select');
    fireEvent.change(adapterSelect, { target: { value: 'codex' } });
    fireEvent.change(screen.getByTestId('byo-model-select'), { target: { value: 'gpt-6-sol' } });
    fireEvent.change(adapterSelect, { target: { value: 'claude' } });
    expect(screen.getByTestId('byo-model-select')).toHaveValue('');
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());
    fireEvent.click(screen.getByText('Add to this computer'));

    await waitFor(() => expect(screen.getByTestId('byo-machine-result')).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
      config: expect.objectContaining({ runtime: { runtimeType: 'wrapper', adapter: 'claude' } }),
    }), expect.anything());
  });

  test('auto-detect submits neither adapter nor model', async () => {
    mockGet();
    axios.post.mockResolvedValue({ data: {} });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    expect(screen.getByTestId('byo-adapter-select')).toHaveValue('');
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());
    fireEvent.click(screen.getByText('Add to this computer'));

    await waitFor(() => expect(screen.getByTestId('byo-machine-result')).toBeInTheDocument());
    expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
      config: expect.objectContaining({ runtime: { runtimeType: 'wrapper' } }),
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

  // The placement route refuses an agent Commonly runs in-process (the
  // person's hosted agent) with in_process_agent_no_token. The page says so
  // in plain words and shows no "waiting for your computer" result. Matched on
  // the words both the server's message and the page's own copy for that code
  // share, so it holds whichever one renders.
  test("placing the person's hosted agent on a computer is refused in plain words", async () => {
    mockGet();
    axios.post.mockImplementation((url) => {
      if (url === '/api/registry/install') {
        return Promise.reject({ response: { status: 400, data: { error: 'Agent already installed in this pod' } } });
      }
      if (url === '/api/agent-binding/request') {
        return Promise.reject({
          response: {
            status: 409,
            data: {
              code: 'in_process_agent_no_token',
              message: "sam-hosted is your hosted agent, and Commonly runs it, so it can't also run on your computer. Choose a different name for an agent you run yourself.",
            },
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    fireEvent.change(screen.getByPlaceholderText('my-mcp-agent'), { target: { value: 'sam-hosted' } });
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());
    fireEvent.click(screen.getByText('Add to this computer'));

    expect(await screen.findByText(/sam-hosted is your hosted agent/)).toBeInTheDocument();
    expect(screen.queryByTestId('byo-machine-result')).toBeNull();
    expect(screen.queryByText(/has no runtime token/)).toBeNull();
  });

  test('two computers with one name get distinct labels and the online one is the default', async () => {
    mockGet({
      machines: [
        { id: 'm2', machineId: 'mach-new', name: 'Sams-MacBook', status: 'online', createdAt: '2026-10-24T09:00:00.000Z', agentStates: [] },
        { id: 'm1', machineId: 'mach-old', name: 'Sams-MacBook', status: 'offline', createdAt: '2026-09-06T09:00:00.000Z', agentStates: [] },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    const select = screen.getByTestId('byo-machine-select');
    const labels = Array.from(select.querySelectorAll('option')).map((option) => option.textContent);
    expect(labels[0]).toMatch(/^Sams-MacBook · added Oct 24, .* \(online\)$/);
    expect(labels[1]).toMatch(/^Sams-MacBook · added Sep 6, .* \(offline\)$/);
    expect(select).toHaveValue('mach-new');
  });

  test('a unique computer name renders without a date', async () => {
    mockGet({
      machines: [
        { id: 'm1', machineId: 'mach-a', name: 'Sam’s MacBook', status: 'online', createdAt: '2026-09-06T09:00:00.000Z', agentStates: [] },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    const labels = Array.from(screen.getByTestId('byo-machine-select').querySelectorAll('option')).map((option) => option.textContent);
    expect(labels).toEqual(['Sam’s MacBook (online)']);
  });

  test('the default computer is the online one even when an offline one is listed first', async () => {
    mockGet({
      machines: [
        { id: 'm1', machineId: 'mach-off', name: 'Old Mac', status: 'offline', createdAt: '2026-09-06T09:00:00.000Z', agentStates: [] },
        { id: 'm2', machineId: 'mach-on', name: 'Studio', status: 'online', createdAt: '2026-10-01T09:00:00.000Z', agentStates: [] },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-machine'));
    expect(screen.getByTestId('byo-machine-select')).toHaveValue('mach-on');
  });
});
