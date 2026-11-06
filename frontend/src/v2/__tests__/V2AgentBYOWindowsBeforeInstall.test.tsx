// @ts-nocheck
// Keep setup request assertions independent of funnel telemetry.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
// Windows, before and after install (D245). Until 11-04 the page told a
// Windows visitor, before install, that the agent would not answer @mentions
// (11-02: four agents made on Windows never ran). The listener now runs on
// Windows without a sandbox, so the page defaults to Windows from the browser,
// leads with the connect command, and after install shows the PowerShell lines
// and the unsandboxed note, in both languages.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';
import i18n, { i18nReady } from '../../i18n';

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

beforeEach(() => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured: hostingConfigured, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    }
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', joinPolicy: 'invite-only', publicRead: false, communityListed: false, createdBy: { _id: 'u1' } }] });
    if (url === '/api/machines') return Promise.resolve({ data: { machines: [], offlineAfterMs: 90000 } });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    return Promise.resolve({ data: {} });
  });
});

let hostingConfigured = true;
const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('V2AgentBYO on Windows', () => {
  const realUserAgent = window.navigator.userAgent;
  const setUserAgent = (value) => Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
  const setNav = (key, value) => Object.defineProperty(window.navigator, key, { value, configurable: true });
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  beforeAll(async () => { await i18nReady; });
  afterEach(async () => {
    setUserAgent(realUserAgent);
    delete window.navigator.userAgentData;
    delete window.navigator.platform;
    hostingConfigured = true;
    window.history.replaceState({}, '', '/');
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  const issue = async () => {
    axios.post
      .mockResolvedValueOnce({ data: { ok: true } }) // /api/registry/install
      .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } }); // runtime-tokens
    const act2 = await screen.findByTestId('byo-mode-byo');
    fireEvent.click(act2);
    const install = await screen.findByRole('button', { name: /^(Get my connect command|获取)/ });
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    return screen.findByTestId('byo-listen');
  };

  // The OS default comes from the browser; the person can switch it.
  test.each([
    ['userAgentData.platform', () => setNav('userAgentData', { platform: 'Windows' })],
    ['navigator.platform Win32', () => setNav('platform', 'Win32')],
    ['the user agent', () => setUserAgent(WINDOWS)],
  ])('Windows is the default when %s says so', async (_label, arrange) => {
    setUserAgent(MAC.replace('Macintosh; Intel Mac OS X 10_15_7', 'X'));
    arrange();
    renderPage();
    await issue();
    expect(screen.getByTestId('byo-setup-os-windows')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a Mac browser defaults to Mac', async () => {
    setUserAgent(MAC);
    setNav('platform', 'MacIntel');
    renderPage();
    await issue();
    expect(screen.getByTestId('byo-setup-os-mac')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('byo-listen-windows')).toBeNull();
  });

  test('before install there is no "won’t answer" notice, and the connect command leads', async () => {
    setUserAgent(WINDOWS);
    renderPage();
    fireEvent.click(await screen.findByTestId('byo-mode-byo'));
    const install = await screen.findByRole('button', { name: /^Get my connect command/ });
    expect(install).toHaveClass('v2-byo__submit');
    expect(install).not.toHaveClass('v2-byo__submit--quiet');
    expect(screen.queryByTestId('byo-wont-answer-before-install')).not.toBeInTheDocument();
    expect(screen.getByTestId('byo-quick-try')).toHaveTextContent(/^Quick try: this command runs in PowerShell and stops when that window closes\./);
  });

  test('zh-CN: the PowerShell heading, the needs line, the note and the scripts hint read in Chinese', async () => {
    setUserAgent(WINDOWS);
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    renderPage();
    const listen = await issue();
    expect(listen).toHaveTextContent(/^在 PowerShell 里运行这段命令/);
    expect(screen.getByTestId('byo-listen-needs')).toHaveTextContent('四行都要在同一个 PowerShell 窗口里运行，换了窗口 $env 设置就失效。');
    const note = screen.getByTestId('byo-listen-windows');
    expect(note).toHaveTextContent(/^Claude Code 在 Windows 上需要 CLI 0\.1\.243或更高版本，才能回复 @提及。Windows 上没有能给 \S+ 用的沙箱，/);
    expect(note).not.toHaveTextContent('测试过');
    expect(note).toHaveTextContent('--unsandboxed');
    expect(note).toHaveTextContent('--allow write');
    expect(note).toHaveTextContent('不能运行命令');
    expect(note).toHaveTextContent('连接器授权');
    expect(note).toHaveTextContent('commonly daemon install --unsandboxed');
    expect(note).toHaveTextContent('--allow');
    expect(screen.getByTestId('byo-listen-stops-on-close')).toHaveTextContent(/PowerShell 窗口/);
    expect(screen.getByTestId('byo-add-computer-windows')).toHaveTextContent(/^Windows 上没有沙箱。/);
    expect(screen.getByTestId('byo-add-computer-windows')).toHaveTextContent('连接器授权');
    expect(note).not.toHaveTextContent(/您|代理/);
    expect(screen.getByTestId('byo-listen-npm-hint')).toHaveTextContent('如果 PowerShell 提示禁止运行脚本');
  });

  test('zh-CN before install: the quick-try line names PowerShell', async () => {
    setUserAgent(WINDOWS);
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    renderPage();
    fireEvent.click(await screen.findByTestId('byo-mode-byo'));
    expect(await screen.findByTestId('byo-quick-try')).toHaveTextContent(/^快速试用：这条命令在 PowerShell 里运行/);
  });

  test('zh-CN with Codex: the note is the Codex line alone, in Chinese', async () => {
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex');
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    renderPage();
    await issue();
    const note = screen.getByTestId('byo-listen-windows');
    expect(note).toHaveTextContent(/^Codex 在这里用不了 Windows 沙箱/);
    expect(note).toHaveTextContent('这个 Pod 里的任何人，包括你之后邀请的人，都能指挥它');
    expect(note).toHaveTextContent('连接器授权');
    expect(note.querySelector('code')).toHaveTextContent('--unsandboxed');
  });
});
