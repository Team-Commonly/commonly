// @ts-nocheck
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2YourTeamPage from '../components/V2YourTeamPage';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const axios = jest.requireMock('axios').default;

const agent = (overrides) => ({
  name: 'agent',
  instanceId: 'default',
  userId: 'user-x',
  podId: 'pod-1',
  podName: 'Launch — plan',
  description: 'Drafts the launch notes',
  ...overrides,
});

const agents = [
  agent({ name: 'scout', displayName: 'Scout', userId: 'user-scout', installedBy: 'me', runtime: { runtimeType: 'hosted' } }),
  agent({ name: 'codex', displayName: 'Codex', userId: 'user-codex', runtime: { runtimeType: 'codex' } }),
  agent({ name: 'laptop', displayName: 'Laptop', userId: 'user-laptop', runtime: { runtimeType: 'native', host: 'byo' } }),
  agent({ name: 'hook', displayName: 'Hook', userId: 'user-hook', runtime: { runtimeType: 'webhook' } }),
  agent({ name: 'mystery', displayName: 'Mystery', userId: 'user-mystery', runtime: { runtimeType: 'something-new' } }),
];

const renderPage = () => render(
  <AuthContext.Provider value={{ user: { _id: 'me', role: 'user', entitlements: {} } }}>
    <MemoryRouter>
      <V2YourTeamPage />
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('V2YourTeamPage location mark and hosted meter', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'test-token');
    axios.get.mockImplementation(async (url, opts = {}) => {
      if (url === '/api/pods') return { data: [{ _id: 'pod-1', name: 'Launch — plan' }] };
      if (url === '/api/registry/pods/pod-1/agents') return { data: { agents } };
      if (url.startsWith('/api/v1/tasks/')) return { data: { tasks: [] } };
      if (url === '/api/activity/decision-queue') return { data: { items: [] } };
      if (url === '/api/hosted/status') {
        return { data: { agentName: opts.params.agentName, meter: { allowed: true, used: 12, cap: 30 } } };
      }
      throw new Error(`unexpected GET ${url}`);
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('marks each seat by where its runtime runs, and gives an unknown runtime no mark', async () => {
    renderPage();
    const cardOf = async (name) => (await screen.findByText(name)).closest('article');
    expect(within(await cardOf('Scout')).getByRole('img', { name: 'Runs on Commonly' })).toBeInTheDocument();
    expect(within(await cardOf('Codex')).getByRole('img', { name: 'Runs on Commonly' })).toBeInTheDocument();
    expect(within(await cardOf('Laptop')).getByRole('img', { name: 'Runs on your computer' })).toBeInTheDocument();
    expect(within(await cardOf('Hook')).getByRole('img', { name: 'Runs on your computer' })).toBeInTheDocument();
    expect(within(await cardOf('Mystery')).queryByRole('img', { name: /Runs on/ })).toBeNull();
    // The own-agent tile is the viewer's own machine by definition.
    expect(screen.getByTestId('team-own-card').querySelector('[role="img"]')).not.toBeNull();
  });

  it('shows the server meter on the hosted card only, and only reads it for hosted seats', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('team-card-meter')).toBeInTheDocument());
    const scoutCard = (await screen.findByText('Scout')).closest('article');
    expect(within(scoutCard).getByText('12/30 today')).toBeInTheDocument();
    expect(screen.getAllByTestId('team-card-meter')).toHaveLength(1);
    const statusCalls = axios.get.mock.calls.filter(([url]) => url === '/api/hosted/status');
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0][1].params).toEqual({ agentName: 'scout', instanceId: 'default' });
  });
});
