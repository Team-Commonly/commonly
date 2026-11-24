// @ts-nocheck
// Where the server issues a connect code, the page shows one line that carries
// the code instead of the agent's key, says so, and offers a new line once the
// code runs out before the agent connects.
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

// Keep setup request assertions independent of funnel telemetry.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));

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

// What /api/users/me/agent-connection answers: an object, or an Error to fail the read.
let connection: object | Error = {};
const issueWithCode = async (tokenData) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/users/me/agent-connection') return connection instanceof Error ? Promise.reject(connection) : Promise.resolve({ data: connection });
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

beforeEach(() => { axios.get.mockReset(); axios.post.mockReset(); connection = {}; });

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

  test('without a code (an instance that doesn\'t issue them) the three lines and their copy stay', async () => {
    await issueWithCode({ token: 'cm_agent_test_token' });
    expect(listenBox().textContent.split('\n')).toHaveLength(3);
    expect(screen.getByText(/run all three lines in one window/i)).toBeInTheDocument();
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

  const expired = () => ({ token: 'cm_agent_test_token', connectCode: CODE, connectCodeExpiresAt: new Date(Date.now() - 1000).toISOString() });

  test('asking for a new line after the agent connected shows it connected, and its key is not replaced', async () => {
    await issueWithCode(expired());
    await screen.findByTestId('byo-line-expired');
    const name = within(screen.getByTestId('byo-line-expired')).getByText(/ran out before/i).textContent.match(/before (\S+) connected/)[1];
    connection = { connected: true, connectedAgent: { agentName: name }, lastUsedAt: new Date().toISOString() };
    await act(async () => { fireEvent.click(screen.getByTestId('byo-line-new')); });
    await waitFor(() => expect(screen.queryByTestId('byo-line-expired')).not.toBeInTheDocument());
    expect(tokenBodies()).toHaveLength(1);
  });

  test('a key used since the line was made (the MCP or Cursor setup, say) is replaced only on a second press', async () => {
    await issueWithCode(expired());
    await screen.findByTestId('byo-line-expired');
    connection = { connected: false, lastToolUseAt: new Date().toISOString() };
    await act(async () => { fireEvent.click(screen.getByTestId('byo-line-new')); });
    await waitFor(() => expect(screen.getByTestId('byo-line-expired')).toHaveTextContent(/anything using it stops/i));
    expect(tokenBodies()).toHaveLength(1);
    axios.post.mockResolvedValueOnce({ data: { token: 'cm_agent_new', connectCode: CODE2, connectCodeExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } });
    fireEvent.click(screen.getByRole('button', { name: /replace the key/i }));
    await waitFor(() => expect(listenBox().textContent).toContain(`--connect ${CODE2}`));
    expect(tokenBodies()[1]).toMatchObject({ force: true, connectCode: true });
  });

  test('when the check can\'t be read, nothing is replaced', async () => {
    await issueWithCode(expired());
    await screen.findByTestId('byo-line-expired');
    connection = new Error('network');
    await act(async () => { fireEvent.click(screen.getByTestId('byo-line-new')); });
    await waitFor(() => expect(screen.getByTestId('byo-line-expired')).toHaveTextContent(/couldn.t check/i));
    expect(tokenBodies()).toHaveLength(1);
  });

  test('on Windows the copied line ends in a newline, so the paste runs', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) } });
    await issueWithCode({ token: 'cm_agent_test_token', connectCode: CODE, connectCodeExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    fireEvent.click(screen.getByTestId('byo-setup-os-windows'));
    const copyButton = within(screen.getByTestId('byo-listen')).getAllByRole('button', { name: 'Copy' })[0];
    await act(async () => { fireEvent.click(copyButton); });
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = navigator.clipboard.writeText.mock.calls[0][0];
    expect(copied).toMatch(/--unsandboxed\n$/);
    expect(copied.split('\n')).toHaveLength(2);
  });

  test('while the code still works, the page keeps watching past 15 minutes and sees a late check-in', async () => {
    jest.useFakeTimers();
    try {
      await issueWithCode({ token: 'cm_agent_test_token', connectCode: CODE, connectCodeExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
      const name = screen.getByTestId('byo-listen-waiting').textContent.match(/for (\S+) to check in/)[1];
      for (let i = 0; i < 20; i += 1) await act(async () => { jest.advanceTimersByTime(60_000); });
      expect(screen.getByTestId('byo-listen-waiting')).not.toHaveTextContent(/still no check-in/i);
      connection = { connected: true, connectedAgent: { agentName: name }, lastUsedAt: new Date().toISOString() };
      await act(async () => { jest.advanceTimersByTime(8_000); });
      await waitFor(() => expect(screen.getByTestId('byo-listen-ok')).toBeInTheDocument());
    } finally {
      jest.useRealTimers();
    }
  });
});

// F569: past the watch window the page said "this page will confirm it" but had
// stopped checking, so an agent that connected late never turned green.
describe('BYO after the watch window', () => {
  const { recordByoStep } = jest.requireMock('../utils/byoTelemetry');
  const polls = () => axios.get.mock.calls.filter(([url]) => url === '/api/users/me/agent-connection').length;
  const minutes = async (n) => { for (let i = 0; i < n; i += 1) await act(async () => { jest.advanceTimersByTime(60_000); }); };
  const setVisibility = (state) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  const agentName = () => screen.getByTestId('byo-listen-waiting').textContent.match(/for (\S+) to check in/)[1];

  beforeEach(() => { jest.useFakeTimers(); recordByoStep.mockClear(); });
  afterEach(() => { jest.useRealTimers(); setVisibility('visible'); });

  test.each([
    ['the four lines (no code)', { token: 'cm_agent_test_token' }, 16],
    ['the one line (a code good for 30 minutes)', { token: 'cm_agent_test_token', connectCode: CODE, connectCodeExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }, 32],
  ])('with %s, an agent that checks in after the window still turns green', async (_label, tokenData, past) => {
    await issueWithCode(tokenData);
    const name = agentName();
    await minutes(past);
    expect(screen.getByTestId('byo-listen-waiting')).toHaveTextContent(/still no check-in/i);
    connection = { connected: true, connectedAgent: { agentName: name }, lastUsedAt: new Date().toISOString() };
    await minutes(1);
    await waitFor(() => expect(screen.getByTestId('byo-listen-ok')).toBeInTheDocument());
    expect(recordByoStep.mock.calls.filter((c) => JSON.stringify(c).includes('listen-timeout'))).toHaveLength(1);
  });

  test('after the window it checks every 30 seconds, and not at all while the tab is hidden', async () => {
    await issueWithCode({ token: 'cm_agent_test_token' });
    const name = agentName();
    await minutes(16);
    const atTimeout = polls();
    await minutes(5);
    expect(polls() - atTimeout).toBe(10);
    setVisibility('hidden');
    const hiddenFrom = polls();
    await minutes(10);
    expect(polls()).toBe(hiddenFrom);
    connection = { connected: true, connectedAgent: { agentName: name }, lastUsedAt: new Date().toISOString() };
    setVisibility('visible');
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await waitFor(() => expect(screen.getByTestId('byo-listen-ok')).toBeInTheDocument());
  });
});

