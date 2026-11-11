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

const mockServer = () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'abc1', name: 'Workspace', type: 'chat' }] });
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
});
