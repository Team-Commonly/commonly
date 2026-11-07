// @ts-nocheck
// A person whose hosted slot is taken is told so before the click, not after it.
// /api/hosted/availability names the held agent; the 403 stays behind it for a
// page that went stale.
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';
import { resetByoStepsForTest } from '../utils/byoTelemetry';

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

const pods = [{ _id: 'p1', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } }];
const HELD = { agentName: 'maya-agent', instanceId: 'default', podId: 'p9', displayName: 'Maya' };

const heldAnswer = (held) => (typeof held === 'function' ? held() : held);

const mockGet = ({ held = HELD, machines = [], full = false } = {}) => {
  axios.get.mockImplementation((url) => {
    // The allocator as it answers for a name the person's own agent has taken.
    if (url.startsWith('/api/registry/agents/next-free-name?')) {
      const base = new URLSearchParams(url.split('?')[1]).get('base');
      return Promise.resolve({ data: { name: base === 'maya-agent' ? 'maya-agent-2' : base } });
    }
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 }, held: heldAnswer(held), full } });
    }
    if (url === '/api/pods') return Promise.resolve({ data: pods });
    if (url === '/api/machines') return Promise.resolve({ data: { machines } });
    return Promise.resolve({ data: {} });
  });
};

const Where = () => {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
};

const renderAt = (url) => {
  window.history.pushState({}, '', url);
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/v2/agents/byo" element={<V2AgentBYO />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
};

const actButton = () => screen.queryAllByRole('button', { name: /^run it here$/i })
  .find((b) => !b.hasAttribute('aria-pressed')) ?? null;

const NOTICE = /^You already have a hosted agent \(beta allows 1\)\. Open Maya$/;

beforeEach(() => {
  sessionStorage.clear();
  resetByoStepsForTest();
  window.matchMedia = jest.fn().mockReturnValue({ matches: true });
  axios.post.mockResolvedValue({ data: {} });
});

afterEach(() => {
  jest.clearAllMocks();
  window.history.pushState({}, '', '/');
});

describe('V2AgentBYO — the hosted slot is held', () => {
  test('the mode choice drops Run it here, says why, and bring-your-own is the path', async () => {
    mockGet({ machines: [{ id: 'm1', machineId: 'm1', name: 'Mac', status: 'online' }] });
    renderAt('/v2/agents/byo?pod=p1');

    expect(await screen.findByTestId('byo-hosted-held')).toHaveTextContent(NOTICE);
    expect(screen.queryByTestId('byo-mode-hosted')).not.toBeInTheDocument();
    expect(screen.getByTestId('byo-mode-byo')).toBeInTheDocument();
    expect(screen.getByTestId('byo-mode-machine')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('{{');
  });

  test('with no other place to run, bringing your own is simply the mode', async () => {
    mockGet();
    renderAt('/v2/agents/byo?pod=p1');

    await screen.findByTestId('byo-hosted-held');
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeInTheDocument());
    expect(actButton()).not.toBeInTheDocument();
  });

  test("Scout's hosted offer lands on the notice with a way forward, not on a refused button", async () => {
    mockGet();
    renderAt('/v2/agents/byo?pod=p1&mode=hosted');

    const notice = await screen.findByTestId('byo-hosted-held');
    expect(notice).toHaveTextContent(NOTICE);
    expect(screen.getByTestId('byo-hosted-compact')).toContainElement(notice);
    expect(actButton()).not.toBeInTheDocument();
    expect(screen.queryByText(/It joins Workspace/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('byo-other-ways'));
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeInTheDocument());
    expect(screen.getByTestId('byo-hosted-held')).toBeInTheDocument();
    expect(axios.post.mock.calls.some(([url]) => url === '/api/registry/install')).toBe(false);
  });

  test('the notice opens the agent that holds the slot', async () => {
    mockGet({ held: { ...HELD, agentName: '@acme/maya', instanceId: 'night' } });
    renderAt('/v2/agents/byo?pod=p1');

    fireEvent.click(await screen.findByRole('button', { name: 'Open Maya' }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/v2/agents/%40acme%2Fmaya/night');
  });

  test('counts no hosted offer as shown while none is', async () => {
    mockGet();
    renderAt('/v2/agents/byo?pod=p1');

    await screen.findByTestId('byo-hosted-held');
    const shown = axios.post.mock.calls.filter(([, body]) => body?.step === 'hosted-offer-shown');
    expect(shown).toEqual([]);
  });

  test('a ?name= link to the agent they hold is the same agent in this pod, so it can still run', async () => {
    mockGet();
    renderAt('/v2/agents/byo?pod=p1&mode=hosted&name=maya-agent');

    await waitFor(() => expect(actButton()).toBeEnabled());
    await waitFor(() => expect(axios.get.mock.calls.some(([url]) => url.includes('next-free-name'))
      || axios.get.mock.calls.some(([url]) => url === '/api/machines')).toBe(true));
    expect(screen.queryByTestId('byo-hosted-held')).not.toBeInTheDocument();
    fireEvent.click(actButton());
    await waitFor(() => expect(axios.post.mock.calls.some(([url]) => url === '/api/hosted/provision')).toBe(true));
    const body = (path) => axios.post.mock.calls.find(([url]) => url === path)[1];
    expect(body('/api/registry/install')).toMatchObject({ agentName: 'maya-agent', displayName: 'maya-agent' });
    expect(body('/api/hosted/provision')).toMatchObject({ agentName: 'maya-agent' });
  });

  test('a plain ?name= link keeps the card, and choosing it takes the held name back from the allocator', async () => {
    mockGet();
    renderAt('/v2/agents/byo?pod=p1&name=maya-agent');

    // Bring your own is the link's mode, so the allocator has moved the name on.
    await waitFor(() => expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('maya-agent-2'));
    fireEvent.click(await screen.findByTestId('byo-mode-hosted'));
    await waitFor(() => expect(actButton()).toBeEnabled());
    fireEvent.click(actButton());
    await waitFor(() => expect(axios.post.mock.calls.some(([url]) => url === '/api/registry/install')).toBe(true));
    expect(axios.post.mock.calls.find(([url]) => url === '/api/registry/install')[1].agentName).toBe('maya-agent');
  });

  test('typing another name over the held link brings the notice back', async () => {
    mockGet();
    renderAt('/v2/agents/byo?pod=p1&name=maya-agent');

    fireEvent.click(await screen.findByTestId('byo-mode-hosted'));
    await waitFor(() => expect(actButton()).toBeEnabled());
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'someone-new' } });
    expect(await screen.findByTestId('byo-hosted-held')).toBeInTheDocument();
    expect(actButton()).not.toBeInTheDocument();
  });

  test('a capacity of nothing, with no agent to name, offers no hosting', async () => {
    mockGet({ held: null, full: true });
    renderAt('/v2/agents/byo?pod=p1');

    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeInTheDocument());
    expect(screen.queryByTestId('byo-mode-hosted')).not.toBeInTheDocument();
  });

  test('"Install another" reads availability again, so the new agent is what holds the slot', async () => {
    let placed = null;
    mockGet({ held: () => placed });
    axios.post.mockImplementation((url) => {
      if (url === '/api/hosted/provision') placed = HELD;
      return Promise.resolve({ data: { ready: true } });
    });
    renderAt('/v2/agents/byo?pod=p1&mode=hosted');

    await waitFor(() => expect(actButton()).toBeEnabled());
    fireEvent.click(actButton());
    fireEvent.click(await screen.findByRole('button', { name: /another/i }));
    expect(await screen.findByTestId('byo-hosted-held')).toHaveTextContent(NOTICE);
  });

  // The page's default name is the one the person's first agent took, so the
  // match that keeps Run it here has to be a link, not the field.
  test('the default name matching the held agent does not hide the notice', async () => {
    mockGet({ held: { ...HELD, agentName: 'sam-agent' } });
    renderAt('/v2/agents/byo?pod=p1&mode=hosted');

    expect(await screen.findByTestId('byo-hosted-held')).toBeInTheDocument();
    expect(actButton()).not.toBeInTheDocument();
  });

  test('a ?name= link to another name lands on the Bring your own form with the notice', async () => {
    mockGet();
    renderAt('/v2/agents/byo?pod=p1&name=my-claude');

    await screen.findByTestId('byo-hosted-held');
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeInTheDocument());
  });

  test('a person with room sees no notice', async () => {
    mockGet({ held: null });
    renderAt('/v2/agents/byo?pod=p1');

    expect(await screen.findByTestId('byo-mode-hosted')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-hosted-held')).not.toBeInTheDocument();
  });

  test('a stale page still gets the 403 notice, with the name the server gives', async () => {
    mockGet({ held: null });
    axios.post.mockImplementation((url) => (url === '/api/registry/install'
      ? Promise.reject({ response: { data: { code: 'hosted_cap_reached', used: 1, cap: 1, holders: [HELD] } } })
      : Promise.resolve({ data: {} })));
    renderAt('/v2/agents/byo?pod=p1&mode=hosted');

    await waitFor(() => expect(actButton()).toBeEnabled());
    fireEvent.click(actButton());
    expect(await screen.findByText(/Maya already holds your hosted agent slot \(beta allows 1\)/)).toBeInTheDocument();
  });
});
