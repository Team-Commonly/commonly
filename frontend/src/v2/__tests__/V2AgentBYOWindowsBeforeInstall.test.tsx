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
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    expect(screen.getByTestId('byo-quick-try')).toHaveTextContent(/^Quick try: you’ll run a command in PowerShell\. It needs Node 22\+ with npm and Claude Code signed in, and it stops when that window closes\./);
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
    expect(note).toHaveTextContent('commonly.cmd daemon install --unsandboxed');
    expect(note).toHaveTextContent('--allow');
    expect(screen.getByTestId('byo-listen-stops-on-close')).toHaveTextContent(/PowerShell 窗口/);
    expect(screen.getByTestId('byo-add-computer-windows')).toHaveTextContent(/^Windows 上没有沙箱。/);
    expect(screen.getByTestId('byo-add-computer-windows')).toHaveTextContent('连接器授权');
    expect(note).not.toHaveTextContent(/您|代理/);
    expect(screen.queryByTestId('byo-listen-npm-hint')).toBeNull();
  });

  test('zh-CN before install: the quick-try line names PowerShell', async () => {
    setUserAgent(WINDOWS);
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    renderPage();
    fireEvent.click(await screen.findByTestId('byo-mode-byo'));
    expect(await screen.findByTestId('byo-quick-try')).toHaveTextContent(/^快速试用：你要在 PowerShell 里运行一条命令。需要 Node 22\+（含 npm）和已登录的 Claude Code/);
  });

  test('zh-CN with Codex: the note is the Codex line alone, in Chinese', async () => {
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex');
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    renderPage();
    await issue();
    const note = screen.getByTestId('byo-listen-windows');
    expect(note).toHaveTextContent(/^Windows 上没有 Codex 在这里能用的沙箱/);
    expect(note).toHaveTextContent('这个 Pod 里的任何人，包括你之后邀请的人，都能指挥它');
    expect(note).toHaveTextContent('连接器授权');
    expect(note.querySelector('code')).toHaveTextContent('--unsandboxed');
  });

  // Cofounder 11-14: Codex on Windows lists every route that works: this pod
  // as given, WSL 2 in any pod, or hosted.
  const ways = () => screen.getByTestId('byo-listen-windows-codex-ways');

  test('Codex in an invite-only pod lists the three ways, the lines as given first', async () => {
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex');
    renderPage();
    await issue();
    const items = within(ways()).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'));
    expect(items).toEqual(['byo-codex-way-invite', 'byo-codex-way-wsl', 'byo-codex-way-hosted']);
    expect(screen.getByTestId('byo-codex-way-invite')).toHaveTextContent('run the lines below as given');
    expect(screen.getByTestId('byo-codex-way-wsl')).toHaveTextContent('wsl --install -d Ubuntu');
    expect(screen.getByTestId('byo-codex-way-wsl')).toHaveTextContent('sudo apt install bubblewrap');
    expect(screen.getByTestId('byo-codex-way-wsl')).toHaveTextContent('not yet inside WSL');
    expect(screen.getAllByRole('button', { name: /Run it here/ })).toHaveLength(1);
  });

  test('the WSL way switches the page to the Linux lines, which carry no --unsandboxed', async () => {
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex');
    renderPage();
    await issue();
    fireEvent.click(screen.getByTestId('byo-codex-way-wsl-linux'));
    expect(screen.getByTestId('byo-setup-os-linux')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('byo-listen-windows-codex-ways')).toBeNull();
    expect(screen.getByTestId('byo-listen')).not.toHaveTextContent('--unsandboxed');
  });

  test('a pod that is not invite-only drops the lines-as-given way; WSL stays, and hosted is the one button above', async () => {
    axios.get.mockImplementation((url) => {
      if (url.startsWith('/api/hosted/availability')) return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
      if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', joinPolicy: 'open', publicRead: false, communityListed: false, createdBy: { _id: 'u1' } }] });
      if (url === '/api/machines') return Promise.resolve({ data: { machines: [], offlineAfterMs: 90000 } });
      if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
      return Promise.resolve({ data: {} });
    });
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex');
    renderPage();
    await issue();
    expect(screen.getByTestId('byo-listen-unavailable')).toBeInTheDocument();
    const items = within(ways()).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'));
    expect(items).toEqual(['byo-codex-way-wsl']);
    expect(screen.getAllByRole('button', { name: /Run it here/ })).toHaveLength(1);
    expect(within(screen.getByTestId('byo-listen-wont-answer')).getByRole('button', { name: 'Run it here' })).toBeInTheDocument();
  });

  test('the hosted way starts a hosted agent, once, while it is starting', async () => {
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex');
    renderPage();
    await issue();
    let release;
    const lookups = [];
    axios.get.mockImplementation((url) => {
      if (url.startsWith('/api/registry/agents/next-free-name?')) {
        lookups.push(url);
        return new Promise((resolve) => { release = () => resolve({ data: { name: 'sam-agent' } }); });
      }
      return Promise.resolve({ data: {} });
    });
    const hosted = screen.getByTestId('byo-codex-way-hosted-button');
    await act(async () => { fireEvent.click(hosted); });
    expect(lookups).toHaveLength(1);
    expect(hosted).toBeDisabled();
    await act(async () => { fireEvent.click(hosted); });
    expect(lookups).toHaveLength(1);
    await act(async () => { release(); });
  });

  test('after the command is copied, a failed hosted start shows its error beside the hosted way', async () => {
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex');
    renderPage();
    const listen = await issue();
    fireEvent.copy(within(listen).getByText(/--connect|COMMONLY_AGENT_TOKEN/));
    axios.get.mockImplementation((url) => (url.startsWith('/api/registry/agents/next-free-name?')
      ? Promise.reject(new Error('down'))
      : Promise.resolve({ data: {} })));
    await act(async () => { fireEvent.click(screen.getByTestId('byo-codex-way-hosted-button')); });
    expect(within(screen.getByTestId('byo-codex-way-hosted')).getByRole('alert')).toHaveTextContent(/\S/);
  });

  test('a pod whose privacy never loaded is not described as invite-only; WSL and hosted stay', async () => {
    axios.get.mockImplementation((url) => {
      if (url.startsWith('/api/hosted/availability')) return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
      if (url === '/api/pods') return Promise.reject(new Error('down'));
      if (url === '/api/machines') return Promise.resolve({ data: { machines: [], offlineAfterMs: 90000 } });
      if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
      return Promise.resolve({ data: {} });
    });
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex&pod=aaaaaaaaaaaaaaaaaaaaaaaa');
    renderPage();
    axios.post
      .mockResolvedValueOnce({ data: { ok: true } })
      .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } });
    fireEvent.click(await screen.findByTestId('byo-mode-byo'));
    // The link's pod is the full form's, so it can issue before the list loads.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Get my connect command/ })
      .some((b) => !b.hasAttribute('disabled'))).toBe(true));
    fireEvent.click(screen.getAllByRole('button', { name: /^Get my connect command/ }).find((b) => !b.hasAttribute('disabled')));
    await screen.findByTestId('byo-listen');
    const items = within(ways()).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'));
    expect(items).toEqual(['byo-codex-way-wsl', 'byo-codex-way-hosted']);
  });

  test('with a connect code the ways name the one line, not "the lines" or "the last line"', async () => {
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex');
    renderPage();
    axios.post
      .mockResolvedValueOnce({ data: { ok: true } })
      .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token', connectCode: `cmc_${'A'.repeat(22)}`, connectCodeExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } });
    fireEvent.click(await screen.findByTestId('byo-mode-byo'));
    const install = await screen.findByRole('button', { name: /^Get my connect command/ });
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    await screen.findByTestId('byo-listen');
    expect(screen.getByTestId('byo-codex-way-invite')).toHaveTextContent('run the line below as given. It already has --unsandboxed');
    expect(screen.getByTestId('byo-codex-way-invite')).not.toHaveTextContent('last line');
    expect(screen.getByTestId('byo-codex-way-wsl')).toHaveTextContent('run that line in Ubuntu');
    expect(screen.getByTestId('byo-codex-way-wsl')).toHaveTextContent('sudo apt install bubblewrap');
  });

  test('without hosting there is no hosted way', async () => {
    hostingConfigured = false;
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex');
    renderPage();
    // Without hosting the page opens on Bring your own, with no mode choice.
    axios.post
      .mockResolvedValueOnce({ data: { ok: true } })
      .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } });
    const install = await screen.findByRole('button', { name: /^Get my connect command/ });
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    await screen.findByTestId('byo-listen');
    expect(screen.getByTestId('byo-codex-way-wsl')).toBeInTheDocument();
    expect(screen.queryByTestId('byo-codex-way-hosted')).toBeNull();
  });

  test('Claude Code on Windows gets no Codex ways', async () => {
    setUserAgent(WINDOWS);
    renderPage();
    await issue();
    expect(screen.queryByTestId('byo-listen-windows-codex-ways')).toBeNull();
  });

  test('zh-CN: the Codex ways read in Chinese', async () => {
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex');
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    renderPage();
    await issue();
    expect(ways()).toHaveTextContent(/^在 Windows 上用 Codex，有这几种办法：/);
    expect(screen.getByTestId('byo-codex-way-wsl')).toHaveTextContent('还没在 WSL 里跑过');
    expect(screen.getByTestId('byo-codex-way-hosted-button')).toHaveTextContent('在这里运行');
  });
});
