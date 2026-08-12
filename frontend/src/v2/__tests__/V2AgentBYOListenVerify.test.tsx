// @ts-nocheck
// The listening-verification loop on the BYO page (#887 class, second half).
// #888 made the listening step legible; this pins the step being CHECKABLE:
// the page polls /api/users/me/agent-connection until THIS agent's runtime
// token authenticates after issuance, then flips the step to a checkmark and
// drops the departure warning. The time-fence and name-match keep a
// pre-existing connected agent from ever flipping the checkmark for the one
// just issued.
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

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

const issueToken = async () => {
  axios.get.mockResolvedValueOnce({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat' }] });
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } }) // /api/registry/install
    .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } }); // runtime-tokens

  renderPage();
  await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /install \+ generate token/i }));
  await screen.findByText(/token issued for/i);
};

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('V2AgentBYO listening verification', () => {
  test('waits, then flips to verified when THIS agent checks in after issuance', async () => {
    jest.useFakeTimers();
    await issueToken();

    // Pre-flip: waiting indicator + honest departure warning are visible.
    expect(screen.getByTestId('byo-listen-waiting')).toBeInTheDocument();
    expect(screen.getByTestId('byo-cta-warning')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-listen-ok')).not.toBeInTheDocument();

    // First poll: a DIFFERENT (pre-existing) agent is connected — must NOT flip.
    axios.get.mockResolvedValueOnce({
      data: {
        issued: true,
        connected: true,
        lastUsedAt: new Date().toISOString(),
        connectedAgent: { agentName: 'old-agent', instanceId: 'default', podId: 'p9' },
      },
    });
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.queryByTestId('byo-listen-ok')).not.toBeInTheDocument();

    // Second poll: the just-issued agent (sam-agent) authenticates.
    axios.get.mockResolvedValueOnce({
      data: {
        issued: true,
        connected: true,
        lastUsedAt: new Date().toISOString(),
        connectedAgent: { agentName: 'sam-agent', instanceId: 'default', podId: 'p1' },
      },
    });
    await act(async () => { jest.advanceTimersByTime(4000); });

    expect(screen.getByTestId('byo-listen-ok')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-cta-warning')).not.toBeInTheDocument();
    expect(screen.queryByTestId('byo-listen-waiting')).not.toBeInTheDocument();

    // Polling stops after success — no further connection reads.
    const readsAfterFlip = axios.get.mock.calls.filter(
      ([url]) => url === '/api/users/me/agent-connection',
    ).length;
    await act(async () => { jest.advanceTimersByTime(12000); });
    expect(axios.get.mock.calls.filter(
      ([url]) => url === '/api/users/me/agent-connection',
    ).length).toBe(readsAfterFlip);
  });

  test('a transient poll failure keeps waiting rather than erroring', async () => {
    jest.useFakeTimers();
    await issueToken();

    axios.get.mockRejectedValueOnce(new Error('network blip'));
    await act(async () => { jest.advanceTimersByTime(4000); });

    expect(screen.getByTestId('byo-listen-waiting')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-listen-ok')).not.toBeInTheDocument();
  });

  test('the listen snippet carries the CLI install line for first-time machines', async () => {
    jest.useFakeTimers();
    await issueToken();
    expect(screen.getByText(/npm i -g @commonlyai\/cli/)).toBeInTheDocument();
  });
});
