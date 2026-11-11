// @ts-nocheck
// F306 part 2: a Connect link for a second instance (the same name with another
// instanceId) must set up that instance. The page used to install and key the
// default one, so the instance on the card never got a key and a sibling did.
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
jest.mock('../components/V2NavRail', () => () => null);
jest.mock('../hooks/useV2PodAttention', () => ({
  ...jest.requireActual('../hooks/useV2PodAttention'),
  useV2PodAttention: () => ({ items: [], count: null, countByPod: {}, refresh: async () => {} }),
}));
jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

const axios = jest.requireMock('axios').default;

const authValue = {
  currentUser: { _id: 'u1', username: 'sam' },
  user: { _id: 'u1', username: 'sam' },
  token: 'user-jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={['/']}>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

const MACBOOK = { machineId: 'm1', name: 'Sams-MacBook', status: 'online', lastSeenAt: new Date().toISOString() };
// F427: a daemon on CLI 0.1.328 or later keeps a key per instance.
const STUDIO = { machineId: 'm2', name: 'Sams-Studio', status: 'online', lastSeenAt: new Date().toISOString(), cliVersion: '0.1.328' };

const mockServer = ({ machines = [] } = {}) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'abc1', name: 'Workspace', type: 'chat' }] });
    if (url === '/api/machines') return Promise.resolve({ data: { machines, offlineAfterMs: 90000 } });
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    }
    if (url.startsWith('/api/registry/agents/next-free-name?')) {
      return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    }
    return Promise.resolve({ data: {} });
  });
  axios.post.mockImplementation((url) => {
    if (url === '/api/registry/install') return Promise.reject({ response: { data: { error: 'Agent already installed in this pod' } } });
    if (/runtime-tokens/.test(url)) return Promise.resolve({ data: { token: 'cm_agent_test' } });
    return Promise.resolve({ data: {} });
  });
};

const installBodies = () => axios.post.mock.calls.filter(([url]) => url === '/api/registry/install').map(([, body]) => body);
const tokenBodies = () => axios.post.mock.calls.filter(([url]) => /runtime-tokens/.test(url)).map(([, body]) => body);

describe('Bring your own for a second instance (F306 part 2)', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => window.history.pushState({}, '', '/'));

  test('installs and keys that instance, and the command names it', async () => {
    mockServer();
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
    renderPage();
    // Hosting runs a default instance only, so it isn't offered here.
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    expect(screen.queryByTestId('byo-mode-hosted')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));

    await waitFor(() => expect(tokenBodies()).toHaveLength(1));
    expect(installBodies()[0]).toMatchObject({ agentName: 'sam-claude', instanceId: 'nova' });
    expect(tokenBodies()[0]).toMatchObject({ instanceId: 'nova' });
    await waitFor(() => expect(screen.getByText(/commonly agent run sam-claude --instance-id nova --adapter claude/)).toBeInTheDocument());
  });

  test('a renamed agent is a new one: no instance is sent and the command names none', async () => {
    mockServer();
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    const nameInput = screen.getByDisplayValue('sam-claude');
    fireEvent.change(nameInput, { target: { value: 'other-claude' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));

    await waitFor(() => expect(tokenBodies()).toHaveLength(1));
    expect(installBodies()[0].instanceId).toBeUndefined();
    expect(tokenBodies()[0].instanceId).toBeUndefined();
    await waitFor(() => expect(screen.getByText(/commonly agent run other-claude --adapter claude/)).toBeInTheDocument());
  });

  test('a key replacement after a rename is for the default instance, never the link\'s', async () => {
    mockServer();
    const issue = axios.post.getMockImplementation();
    axios.post.mockImplementation((url, body) => (/runtime-tokens/.test(url) && !body?.force
      ? Promise.resolve({ data: { existing: true } }) : issue(url, body)));
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    fireEvent.change(screen.getByDisplayValue('sam-claude'), { target: { value: 'other-claude' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
    const confirm = await screen.findByTestId('byo-replace-key-confirmation');
    fireEvent.click(within(confirm).getAllByRole('button')[0]);

    await waitFor(() => expect(tokenBodies()).toHaveLength(2));
    expect(tokenBodies()[1]).toMatchObject({ force: true, instanceId: 'default' });
    await waitFor(() => expect(screen.getByText(/commonly agent run other-claude --adapter claude/)).toBeInTheDocument());
  });

  test('a key replacement on the link\'s own name is for that instance', async () => {
    mockServer();
    const issue = axios.post.getMockImplementation();
    axios.post.mockImplementation((url, body) => (/runtime-tokens/.test(url) && !body?.force
      ? Promise.resolve({ data: { existing: true } }) : issue(url, body)));
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
    const confirm = await screen.findByTestId('byo-replace-key-confirmation');
    fireEvent.click(within(confirm).getAllByRole('button')[0]);

    await waitFor(() => expect(tokenBodies()).toHaveLength(2));
    expect(tokenBodies()[1]).toMatchObject({ force: true, instanceId: 'nova' });
    await waitFor(() => expect(screen.getByText(/commonly agent run sam-claude --instance-id nova --adapter claude/)).toBeInTheDocument());
  });

  test('after a rename, Reconnect shows and re-keys only the renamed agent\'s default instance', async () => {
    mockServer();
    const plain = axios.get.getMockImplementation();
    axios.get.mockImplementation((url) => (/\/api\/registry\/pods\/abc1\/agents/.test(url)
      ? Promise.resolve({ data: { agents: [
        { name: 'other-claude', instanceId: 'nova', installedBy: 'u1', runtime: { runtimeType: 'webhook' }, connection: { state: 'revoked' } },
        { name: 'other-claude', instanceId: 'default', installedBy: 'u1', runtime: { runtimeType: 'webhook' },
          connection: { state: 'stale', lastSeenAt: new Date(Date.now() - 8 * 60000).toISOString() } },
      ] } })
      : plain(url)));
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    fireEvent.change(screen.getByDisplayValue('sam-claude'), { target: { value: 'other-claude' } });
    const reconnect = await screen.findByRole('button', { name: 'Reconnect' });
    // The card shows the default instance's state, the one Reconnect re-keys.
    await screen.findByText(/8 min/);
    expect(screen.queryByText(/revoked/i)).toBeNull();
    await waitFor(() => expect(reconnect).toBeEnabled());
    fireEvent.click(reconnect);

    await waitFor(() => expect(tokenBodies()).toHaveLength(1));
    expect(tokenBodies()[0]).toMatchObject({ force: true, instanceId: 'default' });
    expect(installBodies()).toHaveLength(0);
  });

  test('the default instance\'s link is unchanged', async () => {
    mockServer();
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=default&reconnect=1');
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
    await waitFor(() => expect(tokenBodies()).toHaveLength(1));
    expect(installBodies()[0].instanceId).toBeUndefined();
    expect(tokenBodies()[0].instanceId).toBeUndefined();
    await waitFor(() => expect(screen.getByText(/commonly agent run sam-claude --adapter claude/)).toBeInTheDocument());
  });

  // A daemon older than CLI 0.1.328 keeps one local key per agent name, so a
  // computer running the default instance refuses a second one (F427). Such a
  // computer isn't offered, and the page says how to update it instead.
  test('a computer on an older CLI is not offered for a second instance; the page says how to update it', async () => {
    mockServer({ machines: [{ ...MACBOOK, cliVersion: '0.1.327' }] });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    expect(screen.queryByTestId('byo-mode-machine')).toBeNull();
    expect(await screen.findByText('Update your computer')).toBeInTheDocument();
    expect(screen.getByTestId('byo-add-computer')).toHaveTextContent('daemon setup');
    expect(screen.queryByTestId('byo-quick-try')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
    await waitFor(() => expect(screen.getByText(/commonly agent run sam-claude --instance-id nova/)).toBeInTheDocument());
    expect(screen.queryByTestId('byo-result-on-my-computer')).toBeNull();
    // The line that says "choose On my computer" would point at nothing.
    expect(screen.queryByTestId('byo-listen-stops-on-close')).toBeNull();
  });

  test('a computer whose daemon reports no version reads as older', async () => {
    mockServer({ machines: [MACBOOK] });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    expect(await screen.findByText('Update your computer')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-mode-machine')).toBeNull();
  });

  test('a second instance is placed on a computer whose daemon keeps a key per instance', async () => {
    mockServer({ machines: [STUDIO] });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
    renderPage();
    fireEvent.click(await screen.findByTestId('byo-mode-machine'));
    expect(screen.queryByTestId('byo-add-computer')).toBeNull();
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());
    fireEvent.click(screen.getByText('Add to this computer'));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/agent-binding/request', expect.objectContaining({
      agentName: 'sam-claude', instanceId: 'nova', machineId: 'm2',
    }), expect.anything()));
  });

  // After placing, the page polls the computer until the placed instance runs.
  // The default instance, running there under the same name, is not it.
  const placeOnStudio = async (agentStates) => {
    mockServer({ machines: [{ ...STUDIO, agentStates }] });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
    renderPage();
    fireEvent.click(await screen.findByTestId('byo-mode-machine'));
    await waitFor(() => expect(screen.getByText('Add to this computer')).toBeEnabled());
    fireEvent.click(screen.getByText('Add to this computer'));
    await screen.findByText(/Waiting for the daemon on/);
  };

  test('a running default instance does not mark the placed second instance as running', async () => {
    await placeOnStudio([
      { agentName: 'sam-claude', instanceId: 'default', state: 'running' },
      { agentName: 'sam-claude', instanceId: 'nova', state: 'stopped' },
    ]);
    await new Promise((r) => { setTimeout(r, 4600); });
    expect(screen.queryByText(/Running on/)).toBeNull();
    expect(screen.getByText(/Waiting for the daemon on/)).toBeInTheDocument();
  }, 15000);

  test('the placed second instance reads as running once its own seat runs', async () => {
    await placeOnStudio([
      { agentName: 'sam-claude', instanceId: 'default', state: 'stopped' },
      { agentName: 'sam-claude', instanceId: 'nova', state: 'running' },
    ]);
    expect(await screen.findByText(/Running on/, {}, { timeout: 6000 })).toBeInTheDocument();
  }, 15000);

  test('with an older and a newer computer, only the newer one is listed and chosen', async () => {
    mockServer({ machines: [{ ...MACBOOK, cliVersion: '0.1.300' }, STUDIO] });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
    renderPage();
    fireEvent.click(await screen.findByTestId('byo-mode-machine'));
    const select = await screen.findByTestId('byo-machine-select');
    expect(within(select).getAllByRole('option').map((o) => o.value)).toEqual(['m2']);
    expect(select).toHaveValue('m2');
    expect(screen.queryByText('Update your computer')).toBeNull();
  });

  test('the default instance is offered every computer, whatever its version', async () => {
    mockServer({ machines: [MACBOOK, STUDIO] });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=default&reconnect=1');
    renderPage();
    fireEvent.click(await screen.findByTestId('byo-mode-machine'));
    const select = await screen.findByTestId('byo-machine-select');
    expect(within(select).getAllByRole('option').map((o) => o.value)).toEqual(['m1', 'm2']);
  });

  test('a computer link for a second instance opens on Bring your own instead', async () => {
    mockServer({ machines: [MACBOOK] });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&mode=machine');
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    expect(screen.queryByTestId('byo-mode-machine')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
    await waitFor(() => expect(tokenBodies()).toHaveLength(1));
    expect(axios.post.mock.calls.some(([url]) => url === '/api/agent-binding/request')).toBe(false);
  });

  test('the default instance still gets "On my computer"', async () => {
    mockServer({ machines: [MACBOOK] });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=default&reconnect=1');
    renderPage();
    expect(await screen.findByTestId('byo-mode-machine')).toBeInTheDocument();
  });

  // A wrapper's Reconnect link (Your Team, Settings) restarts the seat on its
  // own computer; it isn't a new placement, so it keeps the computer mode.
  test.each([['claude'], ['opencode']])('a second instance\'s wrapper Reconnect still reconnects (%s), with no computer listed', async (adapter) => {
    mockServer({ machines: [] });
    const plain = axios.get.getMockImplementation();
    axios.get.mockImplementation((url) => (/\/api\/registry\/pods\/abc1\/agents/.test(url)
      ? Promise.resolve({ data: { agents: [{ name: 'sam-claude', instanceId: 'nova', installedBy: 'u1',
        runtime: { runtimeType: 'wrapper', adapter }, connection: { state: 'revoked', lastSeenAt: null } }] } })
      : plain(url)));
    axios.post.mockResolvedValue({ data: { requestedAt: '2026-11-11T14:00:00Z' } });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1&mode=machine');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }, { timeout: 5000 }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/agent-binding/reconnect', { agentName: 'sam-claude', instanceId: 'nova' }, expect.anything(),
    ));
    expect(axios.post.mock.calls.some(([url]) => url === '/api/agent-binding/request')).toBe(false);
  });

  test('a Reconnect link for a second instance that is not on a computer offers no computer to place it on', async () => {
    mockServer({ machines: [MACBOOK] });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1&mode=machine');
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    expect(screen.queryByTestId('byo-machine-select')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
    await waitFor(() => expect(tokenBodies()).toHaveLength(1));
    expect(axios.post.mock.calls.some(([url]) => url === '/api/agent-binding/request')).toBe(false);
  });

  test('a computer link to a connected second-instance wrapper, without reconnect, offers no older computer to place it on', async () => {
    mockServer({ machines: [MACBOOK] });
    const plain = axios.get.getMockImplementation();
    axios.get.mockImplementation((url) => (/\/api\/registry\/pods\/abc1\/agents/.test(url)
      ? Promise.resolve({ data: { agents: [{ name: 'sam-claude', instanceId: 'nova', installedBy: 'u1',
        runtime: { runtimeType: 'wrapper', adapter: 'claude' }, connection: { state: 'connected', lastSeenAt: new Date().toISOString() } }] } })
      : plain(url)));
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&mode=machine');
    renderPage();
    await waitFor(() => expect(axios.get.mock.calls.some(([url]) => /\/api\/registry\/pods\/abc1\/agents/.test(url))).toBe(true));
    await new Promise((r) => { setTimeout(r, 400); });
    expect(screen.queryByTestId('byo-machine-select')).toBeNull();
    expect(screen.queryByRole('button', { name: /^assign/i })).toBeNull();
  });

  // On a computer that keeps a key per instance, the same link offers that
  // computer, as it does for the default instance: placing it there moves it.
  test('a computer link to a connected second-instance wrapper, without reconnect, offers a 0.1.328 computer', async () => {
    mockServer({ machines: [STUDIO] });
    const plain = axios.get.getMockImplementation();
    axios.get.mockImplementation((url) => (/\/api\/registry\/pods\/abc1\/agents/.test(url)
      ? Promise.resolve({ data: { agents: [{ name: 'sam-claude', instanceId: 'nova', installedBy: 'u1',
        runtime: { runtimeType: 'wrapper', adapter: 'claude' }, connection: { state: 'connected', lastSeenAt: new Date().toISOString() } }] } })
      : plain(url)));
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&mode=machine');
    renderPage();
    const select = await screen.findByTestId('byo-machine-select');
    expect(within(select).getAllByRole('option').map((o) => o.value)).toEqual(['m2']);
  });

  // A wrapper Reconnect places nothing, and the instance may run on an older
  // computer, so the picker lists every computer there.
  test('a second instance\'s wrapper Reconnect lists every computer, older ones included', async () => {
    mockServer({ machines: [{ ...MACBOOK, cliVersion: '0.1.300' }, STUDIO] });
    const plain = axios.get.getMockImplementation();
    axios.get.mockImplementation((url) => (/\/api\/registry\/pods\/abc1\/agents/.test(url)
      ? Promise.resolve({ data: { agents: [{ name: 'sam-claude', instanceId: 'nova', installedBy: 'u1',
        runtime: { runtimeType: 'wrapper', adapter: 'claude' }, connection: { state: 'revoked', lastSeenAt: null } }] } })
      : plain(url)));
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1&mode=machine');
    renderPage();
    await screen.findByRole('button', { name: 'Reconnect' }, { timeout: 5000 });
    const select = await screen.findByTestId('byo-machine-select');
    expect(within(select).getAllByRole('option').map((o) => o.value)).toEqual(['m1', 'm2']);
    expect(screen.queryByText('Update your computer')).toBeNull();
  });

  // With no computer on file, the add-a-computer block and the quick-try hint
  // lead the form. A computer set up now runs the current CLI, which takes a
  // second instance, so it gets them too.
  test('with no computer on file, a second instance gets the add-a-computer block and quick-try hint', async () => {
    mockServer({ machines: [] });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    expect(screen.getByText('Add a computer')).toBeInTheDocument();
    expect(screen.getByTestId('byo-quick-try')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
    await waitFor(() => expect(screen.getByText(/commonly agent run sam-claude --instance-id nova/)).toBeInTheDocument());
    expect(screen.getByTestId('byo-listen-stops-on-close')).toBeInTheDocument();
  });

  test('with no computer on file, the default instance still gets the add-a-computer block', async () => {
    mockServer({ machines: [] });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=default&reconnect=1');
    renderPage();
    expect(await screen.findByTestId('byo-add-computer')).toBeInTheDocument();
  });

  // reconnect=1 alone keeps a connected wrapper on its computer: Settings'
  // regenerate-key link is that case.
  test('a connected second-instance wrapper\'s explicit Reconnect link reconnects it, with no placement or new key', async () => {
    mockServer({ machines: [] });
    const plain = axios.get.getMockImplementation();
    axios.get.mockImplementation((url) => (/\/api\/registry\/pods\/abc1\/agents/.test(url)
      ? Promise.resolve({ data: { agents: [{ name: 'sam-claude', instanceId: 'nova', installedBy: 'u1',
        runtime: { runtimeType: 'wrapper', adapter: 'opencode' }, connection: { state: 'connected', lastSeenAt: new Date().toISOString() } }] } })
      : plain(url)));
    axios.post.mockResolvedValue({ data: { requestedAt: '2026-11-11T14:00:00Z' } });
    window.history.pushState({}, '', '/?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1&mode=machine');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }, { timeout: 5000 }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/agent-binding/reconnect', { agentName: 'sam-claude', instanceId: 'nova' }, expect.anything(),
    ));
    expect(axios.post.mock.calls.some(([url]) => url === '/api/agent-binding/request')).toBe(false);
    expect(tokenBodies()).toHaveLength(0);
  });
});
