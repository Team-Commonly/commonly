// @ts-nocheck
// F579: a first-run walk connected a Claude Code agent through this page, came
// back to it, and saw only a fresh form with the next name (`…-claude-2`).
// Nothing said the agent they had just connected existed, so a first-timer
// reads "it didn't work" and makes a second one. The page now lists the
// person's own bring-your-own agents in the pod first, with the roster's
// connection state, and keeps the add form below, labelled as a new agent.
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import V2AgentBYO, { YOUR_AGENTS_READ_LIMIT_MS } from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
jest.mock('../components/V2NavRail', () => () => null);
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

const POD = 'aa01';
const pods = [{ _id: POD, name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } }];
const NOW = new Date().toISOString();

const byo = (row) => ({
  instanceId: 'default',
  installedBy: 'u1',
  runtime: { runtimeType: 'webhook', host: 'byo' },
  ...row,
});

let roster = [];
let podList = pods;
// What a pod's roster read answers; the default is `roster` for POD.
let rosterReply = null;
const mockGet = () => {
  axios.get.mockImplementation((url) => {
    const rosterMatch = url.match(/^\/api\/registry\/pods\/([^/]+)\/agents$/);
    if (rosterMatch && rosterReply) return rosterReply(rosterMatch[1]);
    if (url === `/api/registry/pods/${POD}/agents`) return Promise.resolve({ data: { agents: roster } });
    if (url.startsWith('/api/registry/agents/next-free-name?')) {
      return Promise.resolve({ data: { name: `${new URLSearchParams(url.split('?')[1]).get('base')}-2` } });
    }
    if (url.startsWith('/api/hosted/availability')) return Promise.resolve({ data: { configured: false, caps: { agentsPerUser: 3, turnsPerDay: 20 } } });
    if (url === '/api/pods') return Promise.resolve({ data: podList });
    return Promise.resolve({ data: {} });
  });
};

const Where = () => {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
};

const renderAt = (path = `/v2/agents/byo?pod=${POD}`) => {
  // The page reads its link from the address bar.
  window.history.pushState({}, '', path);
  return render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/v2/agents/byo" element={<V2AgentBYO />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
  );
};

const formReady = async () => {
  const action = await screen.findByRole('button', { name: /get my connect command/i });
  await waitFor(() => expect(action).toBeEnabled());
  return action;
};

const rosterRead = () => axios.get.mock.calls.some(([url]) => url === `/api/registry/pods/${POD}/agents`);

afterEach(() => { window.history.pushState({}, '', '/'); });

beforeEach(() => {
  roster = [];
  podList = pods;
  rosterReply = null;
  axios.get.mockReset();
  axios.post.mockReset();
  axios.post.mockResolvedValue({ data: {} });
  mockGet();
});

describe('BYO page lists the agents you already connected here (F579)', () => {
  test('no bring-your-own agent of yours in the pod: the page is as before', async () => {
    roster = [
      // Someone else's BYO agent, a hosted one, and a native one are not yours to list.
      byo({ name: 'mia-claude', installedBy: 'u2', connection: { state: 'connected', lastSeenAt: NOW } }),
      { name: 'helper', instanceId: 'default', installedBy: 'u1', runtime: { runtimeType: 'hosted', host: 'cloud' },
        connection: { state: 'available', lastSeenAt: null } },
      { name: 'pod-welcomer', instanceId: 'default', installedBy: 'u1', runtime: { runtimeType: 'native' },
        connection: { state: 'available', lastSeenAt: null } },
    ];
    renderAt();
    await formReady();
    await waitFor(() => expect(rosterRead()).toBe(true));
    expect(screen.queryByTestId('byo-your-agents')).not.toBeInTheDocument();
    expect(screen.queryByText(/add another agent/i)).not.toBeInTheDocument();
  });

  test('a connected agent shows above the form, with its status and Go to pod', async () => {
    roster = [byo({ name: 'sam-claude', displayName: 'sam-claude', connection: { state: 'connected', lastSeenAt: NOW } })];
    renderAt();
    const list = await screen.findByTestId('byo-your-agents');
    const row = within(list).getByTestId('byo-your-agent');
    expect(row).toHaveTextContent('sam-claude');
    expect(row).toHaveTextContent('Connected');
    expect(within(row).queryByRole('button', { name: /^connect$/i })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /reconnect/i })).not.toBeInTheDocument();
    expect(list).toHaveTextContent('Workspace');
    // Above the add form, which says it adds a new one.
    const action = await formReady();
    const addLabel = screen.getByText(/add another agent/i);
    // eslint-disable-next-line no-bitwise
    expect(list.compareDocumentPosition(addLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // eslint-disable-next-line no-bitwise
    expect(addLabel.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: /go to your pod/i }));
    expect(screen.getByTestId('where')).toHaveTextContent(`/v2/pods/${POD}`);
  });

  test('a never-connected agent says so, and Connect opens its own connect link', async () => {
    roster = [byo({ name: 'sam-claude', connection: { state: 'never', lastSeenAt: null },
      fixCommand: 'npx -y @commonlyai/cli@latest agent run sam-claude' })];
    renderAt();
    const row = await screen.findByTestId('byo-your-agent');
    expect(row).toHaveTextContent('Not connected yet');
    expect(row).not.toHaveTextContent(/^Connected/);
    fireEvent.click(within(row).getByRole('button', { name: /^connect$/i }));
    expect(screen.getByTestId('where'))
      .toHaveTextContent(`/v2/agents/byo?pod=${POD}&name=sam-claude&instanceId=default&reconnect=1`);
  });

  test('an agent not seen lately says when, and offers Reconnect', async () => {
    roster = [byo({ name: 'sam-codex', connection: { state: 'stale', lastSeenAt: new Date(Date.now() - 5 * 60000).toISOString() } })];
    renderAt();
    const row = await screen.findByTestId('byo-your-agent');
    expect(row).toHaveTextContent('Not seen in 5 min');
    expect(within(row).getByRole('button', { name: /reconnect/i })).toBeInTheDocument();
  });

  test('the add-another form below still issues a command for a new agent', async () => {
    roster = [byo({ name: 'sam-claude', connection: { state: 'connected', lastSeenAt: NOW } })];
    axios.post.mockImplementation((url) => {
      if (/runtime-tokens/.test(url)) return Promise.resolve({ data: { token: 'cm_agent_new' } });
      return Promise.resolve({ data: { ok: true } });
    });
    renderAt();
    await screen.findByTestId('byo-your-agents');
    const action = await formReady();
    fireEvent.click(action);
    await screen.findByText(/your connect command for/i);
    const install = axios.post.mock.calls.find(([url]) => url === '/api/registry/install');
    expect(install[1].podId).toBe(POD);
    expect(install[1].agentName).not.toBe('sam-claude');
    // The result replaces the page; the list does not sit over it.
    expect(screen.queryByTestId('byo-your-agents')).not.toBeInTheDocument();
  });

  test('a link for one named agent does not list the others', async () => {
    roster = [byo({ name: 'sam-claude', connection: { state: 'connected', lastSeenAt: NOW } })];
    renderAt(`/v2/agents/byo?pod=${POD}&name=sam-claude&reconnect=1`);
    await formReady();
    expect(screen.queryByTestId('byo-your-agents')).not.toBeInTheDocument();
  });

  test('the add form waits for the roster, so the list never pushes it down', async () => {
    let answer;
    rosterReply = () => new Promise((resolve) => { answer = resolve; });
    roster = [byo({ name: 'sam-claude', connection: { state: 'connected', lastSeenAt: NOW } })];
    renderAt();
    await waitFor(() => expect(rosterRead()).toBe(true));
    expect(screen.queryByRole('button', { name: /get my connect command/i })).not.toBeInTheDocument();
    answer({ data: { agents: roster } });
    await screen.findByTestId('byo-your-agents');
    await formReady();
  });

  test('a failed roster read leaves the page as before', async () => {
    rosterReply = () => Promise.reject(new Error('network'));
    renderAt();
    await formReady();
    expect(screen.queryByTestId('byo-your-agents')).not.toBeInTheDocument();
    expect(screen.queryByText(/add another agent/i)).not.toBeInTheDocument();
  });

  test('a computer-run agent has no Connect, and its Reconnect opens the computer path', async () => {
    roster = [
      byo({ name: 'sam-mac', runtime: { runtimeType: 'wrapper', host: 'byo' }, connection: { state: 'never', lastSeenAt: null },
        fixCommand: 'npx -y @commonlyai/cli@latest agent run sam-mac' }),
      byo({ name: 'sam-box', runtime: { runtimeType: 'wrapper' }, connection: { state: 'revoked', lastSeenAt: null } }),
    ];
    renderAt();
    const [never, revoked] = await screen.findAllByTestId('byo-your-agent');
    expect(within(never).queryByRole('button', { name: /^connect$/i })).not.toBeInTheDocument();
    fireEvent.click(within(revoked).getByRole('button', { name: /reconnect/i }));
    expect(screen.getByTestId('where'))
      .toHaveTextContent(`/v2/agents/byo?pod=${POD}&name=sam-box&instanceId=default&reconnect=1&mode=machine`);
  });

  test('switching pods reads that pod, and the old pod\'s rows go at once', async () => {
    const OTHER = 'bb02';
    podList = [...pods, { _id: OTHER, name: 'Side', type: 'chat' }];
    let answerOther;
    rosterReply = (podId) => (podId === POD
      ? Promise.resolve({ data: { agents: [byo({ name: 'sam-claude', connection: { state: 'connected', lastSeenAt: NOW } })] } })
      : new Promise((resolve) => { answerOther = resolve; }));
    renderAt();
    await screen.findByTestId('byo-your-agents');
    fireEvent.change(await screen.findByRole('combobox', { name: /pod it joins/i }), { target: { value: OTHER } });
    expect(screen.queryByTestId('byo-your-agents')).not.toBeInTheDocument();
    await waitFor(() => expect(axios.get.mock.calls.some(([url]) => url === `/api/registry/pods/${OTHER}/agents`)).toBe(true));
    answerOther({ data: { agents: [byo({ name: 'side-codex', connection: { state: 'never', lastSeenAt: null } })] } });
    const row = await screen.findByTestId('byo-your-agent');
    expect(row).toHaveTextContent('side-codex');
    expect(screen.queryByText('sam-claude')).not.toBeInTheDocument();
  });

  test('Install another reads the roster again, so the agent just made is listed', async () => {
    roster = [byo({ name: 'sam-claude', connection: { state: 'connected', lastSeenAt: NOW } })];
    axios.post.mockImplementation((url) => {
      if (/runtime-tokens/.test(url)) return Promise.resolve({ data: { token: 'cm_agent_new' } });
      return Promise.resolve({ data: { ok: true } });
    });
    renderAt();
    await screen.findByTestId('byo-your-agents');
    fireEvent.click(await formReady());
    await screen.findByText(/your connect command for/i);
    const made = axios.post.mock.calls.find(([url]) => url === '/api/registry/install')[1].agentName;
    roster = [...roster, byo({ name: made, connection: { state: 'never', lastSeenAt: null } })];
    fireEvent.click(screen.getByRole('button', { name: /install another/i }));
    await waitFor(() => expect(screen.getAllByTestId('byo-your-agent')).toHaveLength(2));
    expect(screen.getByTestId('byo-your-agents')).toHaveTextContent(made);
  });

  test('the preview names the next agent as new only while the list shows', async () => {
    roster = [byo({ name: 'sam-claude', connection: { state: 'connected', lastSeenAt: NOW } })];
    renderAt();
    await screen.findByTestId('byo-your-agents');
    expect(screen.getByTestId('byo-preview')).toHaveTextContent(/your new agent/i);
  });

  test('with no list the preview says your agent, as before', async () => {
    renderAt();
    await formReady();
    expect(screen.getByTestId('byo-preview')).not.toHaveTextContent(/your new agent/i);
    expect(screen.getByTestId('byo-preview')).toHaveTextContent(/your agent/i);
  });

  test('Connect opens that agent\'s own connect page, not the same form again', async () => {
    // A real address bar: the page reads its link from window.location.
    roster = [byo({ name: 'sam-codex', connection: { state: 'never', lastSeenAt: null },
      fixCommand: 'npx -y @commonlyai/cli@latest agent run sam-codex' })];
    window.history.pushState({}, '', `/v2/agents/byo?pod=${POD}`);
    render(
      <AuthContext.Provider value={authValue}>
        <BrowserRouter>
          <Routes>
            <Route path="/v2/agents/byo" element={<V2AgentBYO />} />
          </Routes>
        </BrowserRouter>
      </AuthContext.Provider>,
    );
    const row = await screen.findByTestId('byo-your-agent');
    fireEvent.click(within(row).getByRole('button', { name: /^connect$/i }));
    await waitFor(() => expect(screen.getByPlaceholderText('my-mcp-agent')).toHaveValue('sam-codex'));
    expect(screen.queryByTestId('byo-your-agents')).not.toBeInTheDocument();
  });

  test('a roster read that hangs still shows the connect command within the bound, and a late answer is dropped', async () => {
    jest.useFakeTimers();
    try {
      let answer;
      rosterReply = () => new Promise((resolve) => { answer = resolve; });
      renderAt();
      await waitFor(() => expect(rosterRead()).toBe(true));
      expect(screen.queryByRole('button', { name: /get my connect command/i })).not.toBeInTheDocument();
      act(() => { jest.advanceTimersByTime(YOUR_AGENTS_READ_LIMIT_MS); });
      await formReady();
      expect(screen.queryByTestId('byo-your-agents')).not.toBeInTheDocument();
      // The answer arrives after the form painted: it does not drop in above it.
      await act(async () => {
        answer({ data: { agents: [byo({ name: 'sam-claude', connection: { state: 'connected', lastSeenAt: NOW } })] } });
      });
      expect(screen.queryByTestId('byo-your-agents')).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
