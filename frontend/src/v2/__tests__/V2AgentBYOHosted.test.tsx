// @ts-nocheck
// ADR-023 W2 "Run it here" on the BYO page. The instance reports whether it
// can host; when it can, the page defaults to the hosted path, installs with
// runtimeType 'hosted', asks the kernel to provision, and never renders a
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
  test('defaults to hosted when available: install hosted → provision → live screen, no token shown', async () => {
    mockGet({ configured: true, status: { runtime: { lastPollAt: 1 } } });
    axios.post.mockResolvedValue({ data: { ok: true } });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByText(/beta: 200 turns a day/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^run it here$/i }));

    await screen.findByTestId('byo-hosted-result');
    const installCall = axios.post.mock.calls.find(([url]) => url === '/api/registry/install');
    expect(installCall[1]).toMatchObject({ agentName: 'sam-agent', podId: 'p1', config: { runtime: { runtimeType: 'hosted' } } });
    expect(axios.post).toHaveBeenCalledWith('/api/hosted/provision', { agentName: 'sam-agent' }, expect.anything());
    expect(axios.post.mock.calls.some(([url]) => /runtime-tokens/.test(url))).toBe(false);
    expect(screen.queryByText(/cm_agent/)).not.toBeInTheDocument();
    expect(screen.getByText(/sam-agent is live in Workspace/i)).toBeInTheDocument();
  });

  test('flips from starting to listening once the runtime reports a poll', async () => {
    jest.useFakeTimers();
    mockGet({ configured: true, status: { runtime: { lastPollAt: null } } });
    axios.post.mockResolvedValue({ data: { ok: true } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('byo-mode-hosted')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^run it here$/i }));
    await screen.findByTestId('byo-hosted-starting');

    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.getByTestId('byo-hosted-starting')).toBeInTheDocument();

    mockGet({ configured: true, status: { runtime: { lastPollAt: 123 } } });
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
    fireEvent.click(screen.getByRole('button', { name: /^run it here$/i }));
    await screen.findByText(/already have a hosted agent \(beta allows 1\)/i);
    expect(axios.post.mock.calls.some(([url]) => url === '/api/hosted/provision')).toBe(false);
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
