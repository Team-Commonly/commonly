// @ts-nocheck
// Keep setup request assertions independent of funnel telemetry.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
// TASK-645 item 3 and 4: the two connect paths. The run command is the quick
// try and dies with its Terminal; the daemon is the one that keeps an agent
// running. Each state is pinned by its own copy, so a rewording can't drop it.
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../components/V2NavRail', () => () => null);
jest.mock('../hooks/useV2PodAttention', () => ({
  ...jest.requireActual('../hooks/useV2PodAttention'),
  useV2PodAttention: () => ({ items: [], count: null, countByPod: {}, refresh: async () => {} }),
}));
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

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const realUserAgent = window.navigator.userAgent;
const setUserAgent = (value) => Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });

const mockPage = ({ machines = [] } = {}) => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/hosted/availability')) return Promise.resolve({ data: { configured: false, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat' }] });
    if (url === '/api/machines') return Promise.resolve({ data: { machines, offlineAfterMs: 90000 } });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    return Promise.resolve({ data: {} });
  });
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } })
    .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } });
};

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

const issueRun = async () => {
  await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
  await screen.findByText(/your connect command for/i);
};

describe('BYO connect paths: run is the quick try, the daemon keeps it running (TASK-645 items 3 and 4)', () => {
  afterEach(() => setUserAgent(realUserAgent));
  beforeEach(() => jest.clearAllMocks());

  test('run path on a Mac: the quick-try line names the daemon, and the command says it stops with its Terminal', async () => {
    setUserAgent(MAC);
    mockPage({ machines: [] });
    renderPage();
    expect(await screen.findByTestId('byo-quick-try')).toHaveTextContent(/stops when that window closes/);
    expect(screen.getByTestId('byo-quick-try')).toHaveTextContent(/Other ways to connect/);

    await issueRun();
    const stops = screen.getByTestId('byo-listen-stops-on-close');
    expect(stops).toHaveTextContent(/stops when this Terminal window closes/);
    expect(stops).toHaveTextContent(/commonly daemon install/);
  });

  test('run path on Windows: no listener command, so no stop-on-close line', async () => {
    setUserAgent(WINDOWS);
    mockPage({ machines: [] });
    renderPage();
    await issueRun();
    expect(screen.queryByTestId('byo-listen-stops-on-close')).toBeNull();
  });

  test('daemon path with no computer: marked recommended, and Reload says the computer appears by name, online', async () => {
    setUserAgent(MAC);
    mockPage({ machines: [] });
    renderPage();
    const add = await screen.findByTestId('byo-add-computer');
    expect(screen.getByTestId('byo-add-computer-recommended')).toHaveTextContent(/Recommended for an agent that keeps running/);
    expect(add).toHaveTextContent(/appears in the list by its name, marked online/);
    expect(add).toHaveTextContent('commonly daemon register && commonly daemon install');
  });

  test('with a computer already added, the quick-try line and the daemon block are both gone', async () => {
    setUserAgent(MAC);
    mockPage({ machines: [{ machineId: 'm1', name: 'Sams-MacBook', status: 'online', lastSeenAt: new Date().toISOString() }] });
    renderPage();
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/machines', expect.anything()));
    expect(screen.queryByTestId('byo-quick-try')).toBeNull();
    expect(screen.queryByTestId('byo-add-computer')).toBeNull();
  });
});
