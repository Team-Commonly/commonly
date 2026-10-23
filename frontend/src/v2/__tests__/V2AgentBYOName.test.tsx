// @ts-nocheck
// The default agent name follows where it runs (C14 rehearsal, 2026-10-20).
// "Run it here" takes `<user>-agent`. When "Use my own agent" defaulted to the
// same name, a person who had just started a hosted agent was refused at the
// token step with "Commonly runs this agent, so it has no runtime token": the
// own agent shared the hosted one's name.
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';
import { PERSONA_CARDS } from '../agents/personaCatalogData';

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

const pods = [{ _id: 'p1', name: 'Workspace', type: 'chat' }];

// Hosting on, so the page asks where the agent runs.
const mockGet = (roster = []) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/registry/pods/p1/agents') return Promise.resolve({ data: { agents: roster } });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 30 } } });
    }
    if (url === '/api/pods') return Promise.resolve({ data: pods });
    return Promise.resolve({ data: {} });
  });
};

const renderAt = (path = '/v2/agents/byo') => {
  window.history.pushState({}, '', path);
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={[path]}>
        <V2AgentBYO />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
};

const nameInput = () => screen.getByPlaceholderText('my-mcp-agent');

afterEach(() => {
  jest.clearAllMocks();
  authValue.currentUser.username = 'sam';
  window.history.pushState({}, '', '/');
});

describe('BYO default agent name follows where it runs', () => {
  test('reconnect deep link keeps the name and rotates a revoked key with one action', async () => {
    mockGet([{ name: 'local', installedBy: 'u1', runtime: { runtimeType: 'webhook' },
      connection: { state: 'revoked', lastSeenAt: null } }]);
    axios.post.mockResolvedValue({ data: { token: 'cm_agent_new' } });
    renderAt('/v2/agents/byo?pod=p1&name=local&reconnect=1');
    await waitFor(() => expect(screen.getByTestId('byo-connection-state'))
      .toHaveTextContent('Disconnected: key revoked'), { timeout: 5000 });
    expect(nameInput()).toHaveValue('local');
    expect(axios.get.mock.calls.some(([url]) => url.startsWith('/api/registry/agents/next-free-name?'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/registry/pods/p1/agents/local/runtime-tokens',
      { label: 'BYO MCP — replacement', force: true }, expect.anything(),
    ));
  });

  test('compact BYO never offers a non-owner a forced key rotation', async () => {
    mockGet([{ name: 'local', installedBy: 'someone-else', runtime: { runtimeType: 'webhook' },
      connection: { state: 'revoked', lastSeenAt: null } }]);
    renderAt('/v2/agents/byo?pod=p1&name=local&from=card');
    await waitFor(() => expect(screen.getByTestId('byo-connection-state'))
      .toHaveTextContent('Disconnected: key revoked'), { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect agent' })).toBeNull();
  });

  test('wrapper Reconnect requests a daemon rekey instead of repeating placement', async () => {
    mockGet([{ name: 'local', installedBy: 'u1', runtime: { runtimeType: 'wrapper' },
      connection: { state: 'revoked', lastSeenAt: null } }]);
    axios.post.mockResolvedValue({ data: { requestedAt: '2026-10-23T16:30:00Z' } });
    renderAt('/v2/agents/byo?pod=p1&name=local&mode=machine&reconnect=1');
    const action = await screen.findByRole('button', { name: 'Reconnect' }, { timeout: 5000 });
    fireEvent.click(action);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/agent-binding/reconnect',
      { agentName: 'local', instanceId: 'default' }, expect.anything(),
    ));
    expect(axios.post.mock.calls.some(([url]) => url === '/api/agent-binding/request')).toBe(false);
    expect(await screen.findByTestId('byo-reconnect-result')).toHaveTextContent('Waiting for your computer');
  });
  test('trims a long username before asking for a name suggestion', async () => {
    authValue.currentUser.username = 'a'.repeat(60);
    mockGet();
    renderAt();
    await waitFor(() => expect(axios.get.mock.calls.some(([url]) => url.startsWith('/api/registry/agents/next-free-name?'))).toBe(true));
    const lookup = axios.get.mock.calls.find(([url]) => url.startsWith('/api/registry/agents/next-free-name?'))[0];
    expect(new URLSearchParams(lookup.split('?')[1]).get('base')).toHaveLength(64);
  });

  test('hosted keeps <user>-agent; your own agent is <user>-claude', async () => {
    mockGet();
    renderAt();
    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    expect(nameInput()).toHaveValue('sam-agent');

    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    expect(nameInput()).toHaveValue('sam-agent');

    fireEvent.click(screen.getByTestId('byo-mode-byo'));
    expect(nameInput()).toHaveValue('sam-claude');

    // And back: the defaults never leave the two modes on one name.
    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    expect(nameInput()).toHaveValue('sam-agent');
  });

  test('a Codex link defaults your own agent to <user>-codex', async () => {
    mockGet();
    renderAt('/v2/agents/byo?adapter=codex');
    await waitFor(() => expect(screen.getByTestId('byo-mode-byo')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-byo'));
    expect(nameInput()).toHaveValue('sam-codex');
  });

  // sprint-review on #2365: with ?persona= and no ?name=, nothing marks the
  // name as chosen, so only the persona branch's place in defaultNameFor keeps
  // a mode click from renaming it.
  test('a persona link without ?name= keeps the persona name through both modes', async () => {
    const card = PERSONA_CARDS.find((c) => c.availability === 'connect');
    mockGet();
    renderAt(`/v2/agents/byo?persona=${card.key}`);
    await waitFor(() => expect(screen.getByTestId('byo-mode-byo')).toBeInTheDocument());
    expect(nameInput()).toHaveValue(`sam-${card.key}`);
    fireEvent.click(screen.getByTestId('byo-mode-byo'));
    expect(nameInput()).toHaveValue(`sam-${card.key}`);
    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    expect(nameInput()).toHaveValue(`sam-${card.key}`);
  });

  test('a name the person typed is never replaced by a mode switch', async () => {
    mockGet();
    renderAt();
    await waitFor(() => expect(screen.getByTestId('byo-mode-byo')).toBeInTheDocument());
    fireEvent.change(nameInput(), { target: { value: 'my-reviewer' } });
    fireEvent.click(screen.getByTestId('byo-mode-byo'));
    expect(nameInput()).toHaveValue('my-reviewer');
    fireEvent.click(screen.getByTestId('byo-mode-hosted'));
    expect(nameInput()).toHaveValue('my-reviewer');
  });

  test("a name that is the person's hosted agent's is explained, not 'has no runtime token'", async () => {
    mockGet();
    axios.post
      .mockResolvedValueOnce({ data: { ok: true } }) // /api/registry/install ("already installed" tolerance aside)
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: {
            code: 'in_process_agent_no_token',
            error: 'Commonly runs this agent, so it has no runtime token. To run an agent yourself, connect your own agent instead.',
          },
        },
      });
    renderAt();
    await waitFor(() => expect(screen.getByTestId('byo-mode-byo')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('byo-mode-byo'));
    fireEvent.change(nameInput(), { target: { value: 'sam-agent' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
    expect(await screen.findByText(/sam-agent is your hosted agent's name/)).toBeInTheDocument();
    expect(screen.queryByText(/has no runtime token/)).toBeNull();
  });
});
