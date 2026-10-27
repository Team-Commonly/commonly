// @ts-nocheck
// ADR-023 W2 "Run it here" on the BYO page. The instance reports whether it
// can host; when it can, the page asks where the agent should run with
// nothing preselected (ruled 2026-10-14), and choosing "Run it here" installs
// with runtimeType 'hosted', asks the kernel to provision, and never renders a
// token. When it cannot, the page is exactly the BYO page it was.
import React, { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
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
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
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

beforeEach(() => {
  sessionStorage.clear();
  window.matchMedia = jest.fn().mockReturnValue({ matches: true });
  jest.useFakeTimers(); mockGet({ configured: true });
  axios.post.mockImplementation((url) => Promise.resolve({ data: url.includes('runtime-tokens') ? { token: 'fixture-only-key' } : { ready: true } }));
});
afterEach(() => { jest.useRealTimers(); jest.resetAllMocks(); });
const issue = async () => {
  const view = renderPage(); await screen.findByTestId('byo-mode-byo'); fireEvent.click(screen.getByTestId('byo-mode-byo'));
  await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /get my connect command/i })); await screen.findByText(/your connect command for/i);
  return view;
};
const offer = () => screen.queryByRole('button', { name: 'Run it here instead' });
const tick = async (ms) => act(async () => { jest.advanceTimersByTime(ms); });
test('30s offer starts a distinct hosted identity in the same pod', async () => {
  await issue(); await tick(29999); expect(offer()).not.toBeInTheDocument(); await tick(1); fireEvent.click(offer());
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/hosted/provision', { agentName: 'sam-agent' }, expect.anything()));
  expect(axios.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({ agentName: 'sam-agent', podId: 'p1', config: { runtime: { runtimeType: 'hosted' } } }), expect.anything());
  await waitFor(() => expect(screen.queryByText(/your connect command for/i)).not.toBeInTheDocument());
});
test('exit intent offers immediately; manual copy dismisses permanently', async () => {
  await issue(); fireEvent.mouseLeave(document.documentElement, { clientY: 0 }); expect(offer()).toBeInTheDocument();
  fireEvent.copy(screen.getByTestId('byo-listen').querySelector('.v2-byo__command')); await tick(60000); fireEvent.mouseLeave(document.documentElement, { clientY: 0 }); expect(offer()).not.toBeInTheDocument();
});
test('button copy suppresses the offer beyond the Copied label', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) } });
  await issue(); await act(async () => fireEvent.click(screen.getByTestId('byo-listen').querySelector('button.v2-byo__copy'))); await tick(60000); expect(offer()).not.toBeInTheDocument();
  expect(axios.post).toHaveBeenCalledWith('/api/stats/byo-step', { step: 'cli-command-copied' }, expect.anything());
});
test('hosting errors preserve the command and a retryable offer', async () => {
  await issue(); axios.post.mockImplementation((url) => url === '/api/registry/install' ? Promise.reject({ response: { data: { code: 'hosted_cap_reached', cap: 1 } } }) : Promise.resolve({ data: {} }));
  await tick(30000); fireEvent.click(offer()); expect(await screen.findByRole('alert')).toHaveTextContent(/hosted/i); expect(screen.getByText(/your connect command for/i)).toBeInTheDocument(); expect(offer()).toBeEnabled();
  expect(axios.post.mock.calls.some(([url]) => url === '/api/hosted/provision')).toBe(false);
});
test('page entry is recorded once under StrictMode; command rendering is separate and contains no key', async () => {
  render(<StrictMode><AuthContext.Provider value={authValue}><MemoryRouter><V2AgentBYO /></MemoryRouter></AuthContext.Provider></StrictMode>);
  await screen.findByTestId('byo-mode-byo'); fireEvent.click(screen.getByTestId('byo-mode-byo'));
  await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: /get my connect command/i })); await screen.findByText(/your connect command for/i);
  expect(axios.post.mock.calls.filter(([url]) => url === '/api/stats/byo-step').map(([, body]) => body)).toEqual([{ step: 'page-viewed' }, { step: 'seat-created' }]);
});
test('a failed clipboard write leaves the fallback available', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockRejectedValue(new Error('Denied')) } });
  await issue(); await act(async () => fireEvent.click(screen.getByTestId('byo-listen').querySelector('button.v2-byo__copy'))); await tick(30000); expect(offer()).toBeInTheDocument();
});
test('unavailable hosting never gets offered', async () => {
  mockGet({ configured: false }); renderPage();
  await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /get my connect command/i })); await screen.findByText(/your connect command for/i);
  await tick(30000); fireEvent.mouseLeave(document.documentElement, { clientY: 0 }); expect(offer()).not.toBeInTheDocument();
});
test('an agent that connects before the deadline needs no hosted offer', async () => {
  await issue(); const get = axios.get.getMockImplementation();
  axios.get.mockImplementation((url) => url === '/api/users/me/agent-connection' ? Promise.resolve({ data: { connected: true, connectedAgent: { agentName: 'sam-claude' }, lastUsedAt: new Date(Date.now() + 1).toISOString() } }) : get(url));
  await tick(4000); await screen.findByTestId('byo-listen-ok'); await tick(30000); expect(offer()).not.toBeInTheDocument();
});
test('double activation waits for one name lookup and one hosted provision', async () => {
  await issue(); await tick(30000); const get = axios.get.getMockImplementation(); let resolveName;
  axios.get.mockImplementation((url) => url.startsWith('/api/registry/agents/next-free-name?') ? new Promise(resolve => { resolveName = resolve; }) : get(url));
  const button = offer(); fireEvent.click(button); fireEvent.click(button);
  expect(button).toBeDisabled(); await act(async () => resolveName({ data: { name: 'sam-agent' } }));
  await waitFor(() => expect(axios.post.mock.calls.filter(([url]) => url === '/api/hosted/provision')).toHaveLength(1));
});
test('name lookup failure never provisions or changes the issued command', async () => {
  await issue(); await tick(30000); const get = axios.get.getMockImplementation();
  axios.get.mockImplementation((url) => url.startsWith('/api/registry/agents/next-free-name?') ? Promise.reject(new Error('Offline')) : get(url));
  fireEvent.click(offer()); expect(await screen.findByRole('alert')).toHaveTextContent(/name/i);
  expect(screen.getByText(/your connect command for/i)).toBeInTheDocument(); expect(offer()).toBeEnabled(); expect(axios.post.mock.calls.some(([url]) => url === '/api/hosted/provision')).toBe(false);
});
test('offer follows every command and existing control and stays absent after remount in the same session', async () => {
  const view = await issue(); await tick(30000);
  const row = screen.getByRole('status', { name: 'Run it here instead' });
  expect(row.parentElement.lastElementChild).toBe(row);
  document.querySelectorAll('.v2-byo__command, .v2-byo__memory-text, .v2-byo__cta-row').forEach((command) => {
    expect(command.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  view.unmount(); await issue(); await tick(30000); fireEvent.mouseLeave(document.documentElement, { clientY: 0 }); expect(offer()).not.toBeInTheDocument();
});
test('copy before the offer also suppresses it across a remount', async () => {
  const view = await issue(); fireEvent.copy(screen.getByTestId('byo-listen').querySelector('.v2-byo__command'));
  view.unmount(); await issue(); await tick(30000); expect(offer()).not.toBeInTheDocument();
});
test('phone exit does not trigger the offer; its timer still does', async () => {
  window.matchMedia = jest.fn().mockReturnValue({ matches: false });
  await issue(); fireEvent.mouseLeave(document.documentElement, { clientY: 0 }); expect(offer()).not.toBeInTheDocument(); await tick(30000); expect(offer()).toBeInTheDocument();
});
test('failed provisioning retries the same allocated hosted identity instead of consuming another cap slot', async () => {
  await issue(); await tick(30000); const get = axios.get.getMockImplementation(); let lookups = 0; let installs = 0; let provisions = 0;
  axios.get.mockImplementation((url) => url.startsWith('/api/registry/agents/next-free-name?') ? Promise.resolve({ data: { name: ++lookups === 1 ? 'sam-agent' : 'sam-agent-2' } }) : get(url));
  axios.post.mockImplementation((url) => {
    if (url === '/api/registry/install' && ++installs > 1) return Promise.reject({ response: { data: { error: 'Agent already installed in this pod' } } });
    if (url === '/api/hosted/provision' && ++provisions === 1) return Promise.reject({ response: { data: { error: 'Runtime temporarily unreachable' } } });
    return Promise.resolve({ data: { ready: true } });
  });
  fireEvent.click(offer()); await screen.findByRole('alert'); fireEvent.click(offer());
  await waitFor(() => expect(screen.queryByText(/your connect command for/i)).not.toBeInTheDocument());
  expect(lookups).toBe(1);
  expect(axios.post.mock.calls.filter(([url]) => url === '/api/hosted/provision').map(([,body]) => body.agentName)).toEqual(['sam-agent', 'sam-agent']);
});
test('copying a heading or memory text does not count as copying the command', async () => {
  await issue(); fireEvent.copy(screen.getByText(/your connect command for/i));
  fireEvent.copy(document.querySelector('.v2-byo__memory-text'));
  await tick(30000); expect(offer()).toBeInTheDocument();
});

const offerEvents = () => axios.post.mock.calls
  .filter(([url, body]) => url === '/api/stats/byo-step' && body.step.startsWith('hosted-offer-'))
  .map(([, body]) => body);
test.each(['timer', 'exit'])('records offer shown once via %s despite later timers and exit intent', async (trigger) => {
  const view = await issue();
  expect(offerEvents()).toEqual([]);
  if (trigger === 'timer') await tick(30000);
  else fireEvent.mouseLeave(document.documentElement, { clientY: 0 });
  expect(offer()).toBeInTheDocument();
  await tick(60000);
  fireEvent.mouseLeave(document.documentElement, { clientY: 0 });
  expect(offerEvents()).toEqual([{ step: 'hosted-offer-shown' }]);
  view.unmount(); await issue(); await tick(30000);
  expect(offerEvents()).toEqual([{ step: 'hosted-offer-shown' }]);
});
test('records accepted offer activation once while hosted lookup is pending', async () => {
  await issue(); await tick(30000);
  const get = axios.get.getMockImplementation(); let resolveName;
  axios.get.mockImplementation((url) => url.startsWith('/api/registry/agents/next-free-name?')
    ? new Promise(resolve => { resolveName = resolve; }) : get(url));
  const button = offer(); fireEvent.click(button); fireEvent.click(button);
  expect(offerEvents()).toEqual([{ step: 'hosted-offer-shown' }, { step: 'hosted-offer-clicked' }]);
  await act(async () => resolveName({ data: { name: 'sam-agent' } }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/hosted/provision', { agentName: 'sam-agent' }, expect.anything()));
});
test('copy suppression emits neither hosted-offer event', async () => {
  await issue(); fireEvent.copy(screen.getByTestId('byo-listen').querySelector('.v2-byo__command'));
  await tick(60000); fireEvent.mouseLeave(document.documentElement, { clientY: 0 });
  expect(offerEvents()).toEqual([]);
});
