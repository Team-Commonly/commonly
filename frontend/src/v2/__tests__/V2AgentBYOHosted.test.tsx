// @ts-nocheck
// ADR-023 W2 "Run it here" on the BYO page. The instance reports whether it
// can host; when it can, the page asks where the agent should run with
// nothing preselected (ruled 2026-10-14), and choosing "Run it here" installs
// with runtimeType 'hosted', asks the kernel to provision, and never renders a
// token. When it cannot, the page is exactly the BYO page it was.
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

const pods = [{ _id: 'p1', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } }];

const mockGet = ({ configured, status }) => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    }
    if (url.startsWith('/api/hosted/status')) return Promise.resolve({ data: status || { runtime: {} } });
    if (url === '/api/pods') return Promise.resolve({ data: pods });
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
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('V2AgentBYO — Run it here', () => {
  test('with hosting available nothing is preselected, and the act waits for a choice', async () => {
    // A bare visit asks "Where should it run?" with no card pressed. Preselecting
    // "Run it here" answered a question the page never asked, and made every
    // bare visit read as a choice of hosting (ruled 2026-10-14).
    mockGet({ configured: true, status: { runtime: { lastPollAt: 1 } } });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'Where should it run?' })).toBeInTheDocument();
    expect(screen.getByTestId('byo-mode-hosted')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('byo-mode-byo')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('byo-mode-unchosen')).toHaveTextContent('Choose where it runs first');
    expect(screen.queryByRole('button', { name: /^run it here$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install \+ generate token/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('byo-mode-byo'));
    expect(screen.queryByTestId('byo-mode-unchosen')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /install \+ generate token/i })).toBeInTheDocument();
  });

  // The pod list loads before availability and enables the act. Until the
  // instance has said whether it can host, the page must not offer an act at
  // all: an enabled "Install + generate token" there chose a runtime for the
  // person (Sprint Review's measurement on #2190).
  test('offers no act while it is not yet known whether there is a choice', async () => {
    let answerAvailability;
    let answerMachines;
    axios.get.mockImplementation((url) => {
      if (url.startsWith('/api/hosted/availability')) {
        return new Promise((resolve) => { answerAvailability = resolve; });
      }
      if (url === '/api/machines') return new Promise((resolve) => { answerMachines = resolve; });
      if (url === '/api/pods') return Promise.resolve({ data: pods });
      return Promise.resolve({ data: {} });
    });
    renderPage();

    const podPicker = await screen.findByRole('combobox', { name: /install into pod/i });
    await waitFor(() => expect(podPicker).toHaveValue('p1'));
    expect(screen.queryByRole('button', { name: /install \+ generate token/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('byo-mode-unchosen')).toBeInTheDocument();

    // This instance cannot host. Still no act until the machines list answers,
    // because a registered computer would make it a choice.
    await act(async () => { answerAvailability({ data: { configured: false, caps: { agentsPerUser: 0, turnsPerDay: 0 } } }); });
    expect(screen.queryByRole('button', { name: /install \+ generate token/i })).not.toBeInTheDocument();

    // No computers either: bringing your own runtime is the only path.
    await act(async () => { answerMachines({ data: { machines: [] } }); });
    expect(await screen.findByRole('button', { name: /install \+ generate token/i })).toBeEnabled();
    expect(screen.queryByTestId('byo-mode-unchosen')).not.toBeInTheDocument();
  });

  test('choosing hosted: install hosted → provision → live screen, no token shown', async () => {
    mockGet({ configured: true, status: { runtime: { lastPollAt: 1 } } });
    axios.post.mockResolvedValue({ data: { ok: true } });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    expect(screen.getByText(/beta: 200 turns a day/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    fireEvent.click(screen.getByRole('button', { name: /^run it here$/i }));

    await screen.findByTestId('byo-hosted-result');
    const installCall = axios.post.mock.calls.find(([url]) => url === '/api/registry/install');
    expect(installCall[1]).toMatchObject({ agentName: 'sam-agent', podId: 'p1', config: { runtime: { runtimeType: 'hosted' } } });
    expect(axios.post).toHaveBeenCalledWith('/api/hosted/provision', { agentName: 'sam-agent' }, expect.anything());
    expect(axios.post.mock.calls.some(([url]) => /runtime-tokens/.test(url))).toBe(false);
    expect(screen.queryByText(/cm_agent/)).not.toBeInTheDocument();
    expect(screen.getByText(/sam-agent is live in Workspace/i)).toBeInTheDocument();
  });

  // QA 2026-10-16: with "Run it here" chosen at 1440x900, the act's top edge
  // sat at y=882, under the "Add a computer" box, so a stranger saw a selected
  // card and no button. The act now comes straight after the fields it acts on.
  // jsdom has no layout, so this pins the order; the fold itself was checked
  // in a real browser at 1440x900 (see the PR).
  test('the act comes before the "Add a computer" box', async () => {
    mockGet({ configured: true, status: { runtime: { lastPollAt: 1 } } });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    const act = screen.getByRole('button', { name: /^run it here$/i });
    const addComputer = await screen.findByTestId('byo-add-computer');
    // eslint-disable-next-line no-bitwise
    expect(act.compareDocumentPosition(addComputer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('a connect-card deep link (?name=) keeps "Bring your own runtime" selected even when hosting is available', async () => {
    mockGet({ configured: true, status: { runtime: { lastPollAt: 1 } } });
    // Scout's connect_local_agent card lands here with the seat it proposed: the
    // user asked to connect their OWN agent, so hosted must not be preselected.
    window.history.pushState({}, '', '/v2/agents/byo?pod=p1&name=growth-claude');
    render(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter initialEntries={['/v2/agents/byo?pod=p1&name=growth-claude']}>
          <V2AgentBYO />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    // let the availability effect settle, then assert it did not stomp the mode
    await waitFor(() => expect(axios.get.mock.calls.some(([url]) => url === '/api/hosted/availability')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('byo-mode-byo')).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByTestId('byo-mode-hosted')).toHaveAttribute('aria-pressed', 'false');
    window.history.pushState({}, '', '/');
  });

  // Scout's hosted offer links here with ?mode=hosted: the person asked
  // Commonly to host their agent, so the page opens on "Run it here" and its
  // act is the next click (QA 2026-10-16: the hand-off was text only).
  const renderAt = (url) => {
    window.history.pushState({}, '', url);
    return render(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter initialEntries={[url]}>
          <V2AgentBYO />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
  };

  test('a hosted offer link (?mode=hosted) opens on Run it here, one click from live', async () => {
    mockGet({ configured: true, status: { runtime: { lastPollAt: 1 } } });
    axios.post.mockResolvedValue({ data: { ok: true } });
    renderAt('/v2/agents/byo?pod=p1&mode=hosted');

    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByTestId('byo-mode-byo')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: /^run it here$/i }));

    await screen.findByTestId('byo-hosted-result');
    const installCall = axios.post.mock.calls.find(([url]) => url === '/api/registry/install');
    expect(installCall[1]).toMatchObject({ agentName: 'sam-agent', podId: 'p1', config: { runtime: { runtimeType: 'hosted' } } });
    window.history.pushState({}, '', '/');
  });

  test('a hosted offer link offers no act until the instance says it can host', async () => {
    let answerAvailability;
    axios.get.mockImplementation((url) => {
      if (url.startsWith('/api/hosted/availability')) {
        return new Promise((resolve) => { answerAvailability = resolve; });
      }
      if (url === '/api/pods') return Promise.resolve({ data: pods });
      return Promise.resolve({ data: {} });
    });
    renderAt('/v2/agents/byo?pod=p1&mode=hosted');

    const podPicker = await screen.findByRole('combobox', { name: /install into pod/i });
    await waitFor(() => expect(podPicker).toHaveValue('p1'));
    expect(screen.queryByRole('button', { name: /^run it here$/i })).not.toBeInTheDocument();

    await act(async () => { answerAvailability({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 30 } } }); });
    expect(await screen.findByRole('button', { name: /^run it here$/i })).toBeEnabled();
    window.history.pushState({}, '', '/');
  });

  test('a hosted offer link on an instance that cannot host is the plain BYO page', async () => {
    mockGet({ configured: false });
    renderAt('/v2/agents/byo?pod=p1&mode=hosted');

    expect(await screen.findByRole('button', { name: /install \+ generate token/i })).toBeEnabled();
    expect(screen.queryByTestId('byo-mode-hosted')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^run it here$/i })).not.toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });

  test('a persona hire sends the persona\'s card sentence as the seat description (#1649)', async () => {
    mockGet({ configured: true, status: { runtime: { lastPollAt: 1 } } });
    axios.post.mockResolvedValue({ data: { ok: true } });
    // The page reads its deep-link prefill from window.location, not the router.
    window.history.pushState({}, '', '/v2/agents/byo?persona=scout&pod=p1');
    render(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter initialEntries={['/v2/agents/byo?persona=scout&pod=p1']}>
          <V2AgentBYO />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    // A persona link says what to hire, not where it runs.
    expect(screen.getByTestId('byo-mode-hosted')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    fireEvent.click(screen.getByRole('button', { name: /^run it here$/i }));
    await screen.findByTestId('byo-hosted-result');
    const installCall = axios.post.mock.calls.find(([url]) => url === '/api/registry/install');
    expect(installCall[1]).toMatchObject({
      displayName: 'Scout',
      description: 'Your first teammate. Answers how things work here, sets up agents, keeps what you decide.',
      config: { persona: 'scout', runtime: { runtimeType: 'hosted' } },
    });
    window.history.pushState({}, '', '/');
  });

  test('flips from starting to listening once the runtime reports a poll', async () => {
    jest.useFakeTimers();
    mockGet({ configured: true, status: { runtime: { lastPollAt: null } } });
    axios.post.mockResolvedValue({ data: { ok: true } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    fireEvent.click(screen.getByRole('button', { name: /^run it here$/i }));
    await screen.findByTestId('byo-hosted-starting');

    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.getByTestId('byo-hosted-starting')).toBeInTheDocument();

    mockGet({ configured: true, status: { runtime: { lastPollAt: 123 } } });
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.getByTestId('byo-hosted-running')).toBeInTheDocument();
  });

  // QA walk 3 (2026-10-16): the first status check waited 4s, so the panel
  // said "is live" and "Starting…" together. A provision that answers ready is
  // running at once, with no status call at all.
  test('a provision that answers ready shows running at once, without asking status', async () => {
    mockGet({ configured: true, status: { runtime: {} } });
    axios.post.mockResolvedValue({ data: { provisioned: true, ready: true } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    fireEvent.click(screen.getByRole('button', { name: /^run it here$/i }));

    expect(await screen.findByTestId('byo-hosted-running')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-hosted-starting')).not.toBeInTheDocument();
    expect(axios.get.mock.calls.some(([url]) => url.startsWith('/api/hosted/status'))).toBe(false);
  });

  test('without ready from provision, status is checked at once, not after the first interval', async () => {
    jest.useFakeTimers();
    mockGet({ configured: true, status: { runtime: { lastPollAt: 123 } } });
    axios.post.mockResolvedValue({ data: { ok: true } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    fireEvent.click(screen.getByRole('button', { name: /^run it here$/i }));

    // No timer advanced: the first check runs on its own.
    expect(await screen.findByTestId('byo-hosted-running')).toBeInTheDocument();
  });

  // The native engine has no loop to poll: it reports ready once provisioned.
  test('flips to listening when the native engine reports ready, with no poll ever', async () => {
    jest.useFakeTimers();
    mockGet({ configured: true, status: { runtime: { engine: 'native', ready: false } } });
    axios.post.mockResolvedValue({ data: { ok: true } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    fireEvent.click(screen.getByRole('button', { name: /^run it here$/i }));
    await screen.findByTestId('byo-hosted-starting');

    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.getByTestId('byo-hosted-starting')).toBeInTheDocument();

    mockGet({ configured: true, status: { runtime: { engine: 'native', ready: true } } });
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.getByTestId('byo-hosted-running')).toBeInTheDocument();
  });

  test('surfaces the beta cap from the install gate instead of a generic failure', async () => {
    mockGet({ configured: true });
    axios.post.mockImplementation((url) => {
      if (url === '/api/registry/install') {
        return Promise.reject({ response: { data: { code: 'hosted_cap_reached', used: 1, cap: 1 } } });
      }
      return Promise.resolve({ data: { ok: true } });
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    fireEvent.click(screen.getByRole('button', { name: /^run it here$/i }));
    await screen.findByText(/already have a hosted agent \(beta allows 1\)/i);
    expect(axios.post.mock.calls.some(([url]) => url === '/api/hosted/provision')).toBe(false);
  });

  test('a persona hired as a webhook seat carries the sentence too (#1649)', async () => {
    mockGet({ configured: false });
    axios.post.mockResolvedValue({ data: { token: 'cm_agent_x', agentName: 'planner-1' } });
    window.history.pushState({}, '', '/v2/agents/byo?persona=planner&pod=p1');
    renderPage();
    await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /install \+ generate token/i }));
    await waitFor(() => expect(axios.post.mock.calls.some(([url]) => url === '/api/registry/install')).toBe(true));
    const installCall = axios.post.mock.calls.find(([url]) => url === '/api/registry/install');
    expect(installCall[1]).toMatchObject({
      description: 'Sequences the board. What runs in parallel, what blocks what, who is waiting on whom.',
      config: { persona: 'planner', runtime: { runtimeType: 'webhook' } },
    });
    window.history.pushState({}, '', '/');
  });

  test('without hosting the page is the BYO page: no mode picker, webhook install', async () => {
    mockGet({ configured: false });
    axios.post
      .mockResolvedValueOnce({ data: { ok: true } })
      .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } });
    renderPage();
    await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
    expect(screen.queryByTestId('byo-mode-hosted')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /install \+ generate token/i }));
    await screen.findByText(/token issued for/i);
    expect(axios.post.mock.calls[0][1]).toMatchObject({ config: { runtime: { runtimeType: 'webhook' } } });
  });
});
