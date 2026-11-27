// @ts-nocheck
// F642: people run the one foreground listener, close the terminal, and the
// agent stops. The push to keep it running moves to the moment it works: once
// the page sees the agent listening, it leads with the daemon setup line, the
// same one the CLI prints from npx. A person who already added a computer is
// not handed a second setup line.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';
import i18n, { i18nReady } from '../../i18n';
import getApiBaseUrl from '../../utils/apiBaseUrl';

jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn(), recordByoStepOnce: jest.fn() }));
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

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const realUserAgent = window.navigator.userAgent;
const setUserAgent = (value) => Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
const API = getApiBaseUrl().replace(/\/+$/, '');

let machines = [];
let connected = false;

const issue = async (buttonName = /^Get my connect command/) => {
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } })
    .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } });
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter><V2AgentBYO /></MemoryRouter>
    </AuthContext.Provider>,
  );
  fireEvent.click(await screen.findByTestId('byo-mode-byo'));
  const install = await screen.findByRole('button', { name: buttonName });
  await waitFor(() => expect(install).toBeEnabled());
  fireEvent.click(install);
  return screen.findByTestId('byo-listen');
};

// The agent's listener checks in: the page's next poll turns it green.
const goGreen = async () => {
  connected = true;
  await act(async () => { jest.advanceTimersByTime(4000); });
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByTestId('byo-listen-ok')).toBeInTheDocument();
};

beforeAll(async () => { await i18nReady; });
beforeEach(() => {
  machines = [];
  connected = false;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) } });
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/hosted/availability')) return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', joinPolicy: 'invite-only', publicRead: false, communityListed: false, createdBy: { _id: 'u1' } }] });
    if (url === '/api/machines') return Promise.resolve({ data: { machines, offlineAfterMs: 90000 } });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    if (url === '/api/users/me/agent-connection') {
      return Promise.resolve({
        data: connected
          ? {
            issued: true,
            connected: true,
            lastUsedAt: new Date(Date.now() + 1000).toISOString(),
            connectedAgent: { agentName: 'sam-claude', instanceId: 'default', podId: 'p1' },
          }
          : { issued: true, connected: false },
      });
    }
    return Promise.resolve({ data: {} });
  });
});
afterEach(async () => {
  jest.useRealTimers();
  jest.clearAllMocks();
  setUserAgent(realUserAgent);
  await act(async () => { await i18n.changeLanguage('en'); });
});

describe('Keep it running on this computer', () => {
  test('is absent while the page waits for the listener', async () => {
    jest.useFakeTimers();
    setUserAgent(MAC);
    await issue();
    expect(screen.queryByTestId('byo-keep-running')).toBeNull();
  });

  test('leads the result once the listener is green, with the setup line for this instance and a Copy button', async () => {
    jest.useFakeTimers();
    setUserAgent(MAC);
    await issue();
    await goGreen();
    const block = screen.getByTestId('byo-keep-running');
    expect(within(block).getByRole('heading')).toHaveTextContent('Keep it running on this computer');
    const line = `npx -y @commonlyai/cli@latest daemon setup --instance ${API}`;
    expect(block.querySelector('pre')).toHaveTextContent(line);
    expect(block.querySelector('pre').textContent).not.toContain('--unsandboxed');
    // It leads: above the listener block.
    const listen = screen.getByTestId('byo-listen');
    expect(block.compareDocumentPosition(listen) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { fireEvent.click(within(block).getByRole('button', { name: 'Copy' })); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(line);
    // The block says the window must stay open, so the older note doesn't repeat it.
    expect(screen.queryByTestId('byo-listen-stops-on-close')).toBeNull();
  });

  test('on Windows the line names npx.cmd and carries --unsandboxed', async () => {
    jest.useFakeTimers();
    setUserAgent(WINDOWS);
    await issue();
    await goGreen();
    expect(screen.getByTestId('byo-keep-running').querySelector('pre'))
      .toHaveTextContent(`npx.cmd -y @commonlyai/cli@latest daemon setup --instance ${API} --unsandboxed`);
  });

  test('is absent for a person who already added a computer', async () => {
    jest.useFakeTimers();
    machines = [{ id: 'm1', machineId: 'mach-a', name: 'Sam’s MacBook', status: 'online', agentStates: [] }];
    setUserAgent(MAC);
    await issue();
    await goGreen();
    expect(screen.queryByTestId('byo-keep-running')).toBeNull();
  });

  test('zh-CN reads in Chinese', async () => {
    jest.useFakeTimers();
    setUserAgent(MAC);
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    await issue(/^获取/);
    await goGreen();
    const block = screen.getByTestId('byo-keep-running');
    expect(within(block).getByRole('heading')).toHaveTextContent('让它在这台电脑上一直运行');
    expect(block).toHaveTextContent('守护进程');
    expect(within(block).getByRole('button', { name: '复制' })).toBeInTheDocument();
  });
});
