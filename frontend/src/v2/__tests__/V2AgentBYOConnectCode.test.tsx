// @ts-nocheck
// Keep setup request assertions independent of funnel telemetry.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
// Where the server issues a connect code, the page shows one line that carries
// the code instead of the agent's key, says so, and offers a new line once the
// code runs out before the agent connects.
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

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


const CODE = 'cmc_' + 'A1b2C3d4E5f6G7h8I9j0K-';
const CODE2 = 'cmc_' + 'Z9y8X7w6V5u4T3s2R1q0P_';

const issueWithCode = async (tokenData) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat' }] });
    if (url.startsWith('/api/hosted/availability')) return Promise.resolve({ data: { configured: false, caps: { agentsPerUser: 3, turnsPerDay: 20 } } });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    return Promise.resolve({ data: {} });
  });
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } }) // /api/registry/install
    .mockResolvedValueOnce({ data: tokenData }); // runtime-tokens
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter>
        <V2AgentBYO />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
  await screen.findByText(/your connect command for/i);
};
const tokenBodies = () => axios.post.mock.calls.filter(([url]) => /runtime-tokens/.test(url)).map(([, body]) => body);
const listenBox = () => document.querySelector('.v2-byo__command .v2-byo__pre');

beforeEach(() => { axios.get.mockReset(); axios.post.mockReset(); });

describe('BYO one-line connect', () => {
  test('the page asks for a code, and with one shows a single line with the code and no key', async () => {
    await issueWithCode({ token: 'cm_agent_test_token', connectCode: CODE, connectCodeExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    expect(tokenBodies()[0]).toMatchObject({ connectCode: true });
    const line = listenBox().textContent;
    expect(line).not.toContain('\n');
    expect(line).toContain(`--connect ${CODE}`);
    expect(line).not.toContain('cm_agent_test_token');
    expect(screen.getByText(/paste the line into a terminal window/i)).toBeInTheDocument();
    expect(screen.getByTestId('byo-key-once')).toHaveTextContent(/connect code, not .*key/i);
    expect(screen.queryByTestId('byo-line-expired')).not.toBeInTheDocument();
  });

  test('without a code (an instance that doesn\'t issue them) the four lines and their copy stay', async () => {
    await issueWithCode({ token: 'cm_agent_test_token' });
    expect(listenBox().textContent.split('\n')).toHaveLength(4);
    expect(screen.getByText(/run all four lines in one window/i)).toBeInTheDocument();
    expect(screen.getByTestId('byo-key-once')).toHaveTextContent(/private key we show only once/i);
  });

  test('a code that ran out before the agent connected says so, and one press gives a new line', async () => {
    await issueWithCode({ token: 'cm_agent_test_token', connectCode: CODE, connectCodeExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const notice = await screen.findByTestId('byo-line-expired');
    expect(notice).toHaveTextContent(/ran out before/i);
    axios.post.mockResolvedValueOnce({ data: { token: 'cm_agent_new', connectCode: CODE2, connectCodeExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } });
    fireEvent.click(screen.getByTestId('byo-line-new'));
    await waitFor(() => expect(listenBox().textContent).toContain(`--connect ${CODE2}`));
    expect(tokenBodies()[1]).toMatchObject({ force: true, connectCode: true });
    expect(screen.queryByTestId('byo-line-expired')).not.toBeInTheDocument();
  });
});
