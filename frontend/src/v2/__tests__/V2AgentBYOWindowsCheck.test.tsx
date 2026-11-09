// @ts-nocheck
// F342: three outside Windows visitors copied the setup command and their token
// never made a call. The CLI works on Windows (CI-verified), so they stop before
// it runs: no Node, Command Prompt instead of PowerShell, or never ran it. The
// page now says what to check before the paste, and after the copy asks why the
// agent isn't answering, with fixed reasons only.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';
import i18n, { i18nReady } from '../../i18n';
import { recordByoStep } from '../utils/byoTelemetry';

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
const stalls = () => recordByoStep.mock.calls.filter(([, step]) => step === 'listen-stall-reported');

const issue = async () => {
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } })
    .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } });
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter><V2AgentBYO /></MemoryRouter>
    </AuthContext.Provider>,
  );
  fireEvent.click(await screen.findByTestId('byo-mode-byo'));
  const install = await screen.findByRole('button', { name: /^Get my connect command/ });
  await waitFor(() => expect(install).toBeEnabled());
  fireEvent.click(install);
  return screen.findByTestId('byo-listen');
};

const copyListen = async () => {
  const button = within(screen.getByTestId('byo-listen')).getAllByRole('button', { name: 'Copy' })[0];
  await act(async () => { fireEvent.click(button); });
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
};
const { within } = require('@testing-library/react');
const pastMissedWindow = async () => { await act(async () => { jest.advanceTimersByTime(3 * 60 * 1000 + 1000); }); };

beforeAll(async () => { await i18nReady; });
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) } });
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/hosted/availability')) return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', joinPolicy: 'invite-only', publicRead: false, communityListed: false, createdBy: { _id: 'u1' } }] });
    if (url === '/api/machines') return Promise.resolve({ data: { machines: [], offlineAfterMs: 90000 } });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    return Promise.resolve({ data: {} });
  });
});
afterEach(async () => {
  jest.useRealTimers();
  jest.clearAllMocks();
  setUserAgent(realUserAgent);
  await act(async () => { await i18n.changeLanguage('en'); });
});

describe('Windows check line before the paste', () => {
  test('shows on the Windows tab, above the lines, with node -v as code', async () => {
    setUserAgent(WINDOWS);
    await issue();
    const check = screen.getByTestId('byo-listen-windows-check');
    expect(check).toHaveTextContent('Use PowerShell, not Command Prompt (cmd)');
    expect(check).toHaveTextContent('v22 or later');
    expect(check.querySelector('code')).toHaveTextContent('node -v');
    const lines = screen.getByTestId('byo-listen').querySelector('.v2-byo__pre');
    expect(check.compareDocumentPosition(lines) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test.each([['mac', MAC, 'byo-setup-os-mac'], ['linux', 'Mozilla/5.0 (X11; Linux x86_64)', 'byo-setup-os-linux']])(
    'is absent on %s', async (_os, ua) => {
      setUserAgent(ua);
      await issue();
      expect(screen.queryByTestId('byo-listen-windows-check')).toBeNull();
    });

  test('switching to Windows shows it', async () => {
    setUserAgent(MAC);
    await issue();
    fireEvent.click(screen.getByTestId('byo-setup-os-windows'));
    expect(screen.getByTestId('byo-listen-windows-check')).toBeInTheDocument();
  });

  test('zh-CN reads in Chinese', async () => {
    setUserAgent(WINDOWS);
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    axios.post.mockResolvedValueOnce({ data: { ok: true } }).mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } });
    render(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter><V2AgentBYO /></MemoryRouter>
      </AuthContext.Provider>,
    );
    fireEvent.click(await screen.findByTestId('byo-mode-byo'));
    const install = await screen.findByRole('button', { name: /^获取/ });
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    const check = await screen.findByTestId('byo-listen-windows-check');
    expect(check).toHaveTextContent('请用 PowerShell');
    expect(check).toHaveTextContent('v22 或更高');
    expect(check.querySelector('code')).toHaveTextContent('node -v');
  });
});

describe('Why isn’t it answering?', () => {
  test('is hidden until the listen line was copied and the missed window is over', async () => {
    jest.useFakeTimers();
    setUserAgent(WINDOWS);
    await issue();
    await pastMissedWindow();
    expect(screen.queryByTestId('byo-listen-stall')).toBeNull(); // not copied yet
    await copyListen();
    expect(screen.getByTestId('byo-listen-stall')).toBeInTheDocument();
  });

  test('is hidden before the window is over, even after the copy', async () => {
    jest.useFakeTimers();
    setUserAgent(WINDOWS);
    await issue();
    await copyListen();
    expect(screen.queryByTestId('byo-listen-stall')).toBeNull();
  });

  test('is absent on Mac', async () => {
    jest.useFakeTimers();
    setUserAgent(MAC);
    await issue();
    await copyListen();
    await pastMissedWindow();
    expect(screen.queryByTestId('byo-listen-stall')).toBeNull();
  });

  test.each([
    ['node-missing', 'Install Node 22+ from nodejs.org'],
    ['not-run', 'Paste all four lines into one PowerShell window.'],
    ['other', 'Send us what it printed with the Feedback button.'],
  ])('%s posts the fixed reason once and shows its help', async (reason, help) => {
    jest.useFakeTimers();
    setUserAgent(WINDOWS);
    await issue();
    await copyListen();
    await pastMissedWindow();
    expect(screen.getByTestId('byo-listen-stall')).toHaveTextContent('Why isn’t it answering?');
    fireEvent.click(screen.getByTestId(`byo-listen-stall-${reason}`));
    expect(recordByoStep).toHaveBeenCalledWith(
      expect.anything(), 'listen-stall-reported', expect.objectContaining({ reason, setupOs: 'windows' }),
    );
    expect(screen.getByTestId('byo-listen-stall-help')).toHaveTextContent(help);
    // The buttons are gone, so a second report cannot be made.
    for (const r of ['node-missing', 'not-run', 'other']) {
      expect(screen.queryByTestId(`byo-listen-stall-${r}`)).toBeNull();
    }
    expect(stalls()).toHaveLength(1);
  });

  test('the three choices read apart, not as one run-on string', async () => {
    jest.useFakeTimers();
    setUserAgent(WINDOWS);
    await issue();
    await copyListen();
    await pastMissedWindow();
    expect(screen.getByTestId('byo-listen-stall')).toHaveTextContent(
      'PowerShell says node isn’t recognized · I haven’t run it yet · Something else',
    );
  });

  test('goes away once the agent is listening', async () => {
    jest.useFakeTimers();
    setUserAgent(WINDOWS);
    await issue();
    await copyListen();
    await pastMissedWindow();
    expect(screen.getByTestId('byo-listen-stall')).toBeInTheDocument();
    axios.get.mockResolvedValueOnce({
      data: {
        issued: true,
        connected: true,
        lastUsedAt: new Date().toISOString(),
        connectedAgent: { agentName: 'sam-claude', instanceId: 'default', podId: 'p1' },
      },
    });
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(screen.getByTestId('byo-listen-ok')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-listen-stall')).toBeNull();
  });

  test('a new key after Install another asks again, and its report posts', async () => {
    jest.useFakeTimers();
    setUserAgent(WINDOWS);
    await issue();
    await copyListen();
    await pastMissedWindow();
    fireEvent.click(screen.getByTestId('byo-listen-stall-not-run'));
    expect(screen.getByTestId('byo-listen-stall-help')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Install another' })[0]);
    axios.post.mockResolvedValueOnce({ data: { ok: true } }).mockResolvedValueOnce({ data: { token: 'cm_agent_test_token_2' } });
    await act(async () => { jest.advanceTimersByTime(5); });
    const install = await screen.findByRole('button', { name: /^Get my connect command/ });
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    await screen.findByTestId('byo-listen');
    await copyListen();
    await pastMissedWindow();
    expect(screen.queryByTestId('byo-listen-stall-help')).toBeNull();
    fireEvent.click(screen.getByTestId('byo-listen-stall-node-missing'));
    expect(stalls()).toHaveLength(2);
    expect(stalls()[1][2]).toEqual(expect.objectContaining({ reason: 'node-missing' }));
  });

  test('switching to Mac and back after a report neither asks again nor posts again', async () => {
    jest.useFakeTimers();
    setUserAgent(WINDOWS);
    await issue();
    await copyListen();
    await pastMissedWindow();
    fireEvent.click(screen.getByTestId('byo-listen-stall-not-run'));
    fireEvent.click(screen.getByTestId('byo-setup-os-mac'));
    expect(screen.queryByTestId('byo-listen-stall')).toBeNull();
    fireEvent.click(screen.getByTestId('byo-setup-os-windows'));
    expect(screen.getByTestId('byo-listen-stall-help')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-listen-stall-not-run')).toBeNull();
    expect(stalls()).toHaveLength(1);
  });
});
