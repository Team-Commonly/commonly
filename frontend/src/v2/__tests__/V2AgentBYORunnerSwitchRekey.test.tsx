// @ts-nocheck
// Keep setup request assertions independent of funnel telemetry.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
// TASK-645 item 5, Vera's HOLD on #3019: the runner is the one choice that
// names the install, so a runner switch must not leave a key-replacement prompt
// for the other runner's name, and the picker must not move while an issue is in flight.
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

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={['/']}>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

const tokenCalls = () => axios.post.mock.calls.filter(([url]) => /runtime-tokens/.test(url));

// sam-claude already holds a key, so the first issue answers existing:true.
const mockAlreadyKeyed = (tokenReply) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat' }] });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    return Promise.resolve({ data: {} });
  });
  axios.post.mockImplementation((url) => {
    if (url === '/api/registry/install') return Promise.reject({ response: { data: { error: 'Agent already installed in this pod' } } });
    if (/runtime-tokens/.test(url)) return tokenReply();
    return Promise.resolve({ data: {} });
  });
};

describe('BYO runner switch and key replacement (TASK-645 item 5, #3019 HOLD)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('switching runner clears the replace-key prompt, so it cannot rotate the other runner’s key', async () => {
    mockAlreadyKeyed(() => Promise.resolve({ data: { existing: true } }));
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
    await screen.findByTestId('byo-replace-key-confirmation');
    expect(screen.getByTestId('byo-replace-key-confirmation')).toHaveTextContent('sam-claude');

    fireEvent.click(screen.getByTestId('byo-runner-codex'));

    expect(screen.queryByTestId('byo-replace-key-confirmation')).toBeNull();
    expect(screen.queryByRole('button', { name: /replace the running agent.s key/i })).toBeNull();
    // No force-rotation was sent for sam-claude.
    expect(tokenCalls().some(([, body]) => body && body.force)).toBe(false);
  });

  test('the runner picker is disabled while an issue is in flight', async () => {
    let release;
    mockAlreadyKeyed(() => new Promise((resolve) => { release = resolve; }));
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
    await waitFor(() => expect(tokenCalls()).toHaveLength(1));

    expect(screen.getByTestId('byo-runner-claude')).toBeDisabled();
    expect(screen.getByTestId('byo-runner-codex')).toBeDisabled();

    release({ data: { existing: true } });
    await screen.findByTestId('byo-replace-key-confirmation');
    expect(screen.getByTestId('byo-runner-codex')).toBeEnabled();
  });
});
