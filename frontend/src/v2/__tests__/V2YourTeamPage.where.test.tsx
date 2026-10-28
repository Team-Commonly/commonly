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
  agent({ name: 'scout', displayName: 'Scout', userId: 'user-scout', runtime: { runtimeType: 'hosted' } }),
  agent({ name: 'codex', displayName: 'Codex', userId: 'user-codex', runtime: { runtimeType: 'codex' } }),
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

  it('marks a hosted seat as running on Commonly and a local seat as running on the computer', async () => {
    renderPage();
    const hosted = await screen.findByRole('img', { name: 'Runs on Commonly' });
    const local = await screen.findByRole('img', { name: 'Runs on your computer' });
    expect(hosted.closest('article')).toHaveTextContent('Scout');
    expect(local.closest('article')).toHaveTextContent('Codex');
  });

  it('shows the server meter on the hosted card only, and only reads it for hosted seats', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('team-card-meter')).toBeInTheDocument());
    const scoutCard = screen.getByRole('img', { name: 'Runs on Commonly' }).closest('article');
    expect(within(scoutCard).getByText('12/30 today')).toBeInTheDocument();
    expect(screen.getAllByTestId('team-card-meter')).toHaveLength(1);
    const statusCalls = axios.get.mock.calls.filter(([url]) => url === '/api/hosted/status');
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0][1].params).toEqual({ agentName: 'scout', instanceId: 'default' });
  });
});
