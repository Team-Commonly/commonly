// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n, { i18nReady } from '../../i18n';
import axios from '../../utils/axiosConfig';
import { AuthContext } from '../../context/AuthContext';
import V2SettingsPage from '../components/V2SettingsPage';
import V2CliAuthorize from '../components/V2CliAuthorize';
import V2AccountMenu from '../components/V2AccountMenu';

// Settings and the CLI authorize page under zh-CN: the chrome that used to be
// JSX literals renders in Chinese, and its English source does not leak through.

jest.mock('../../utils/axiosConfig', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn(), patch: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

jest.mock('../../components/AppsManagement', () => {
  const MockAppsManagement = () => <div />;
  MockAppsManagement.displayName = 'MockAppsManagement';
  return MockAppsManagement;
});

const member = { _id: 'u1', username: 'lily', email: 'lily@example.com', profilePicture: 'default', role: 'member' };
const auth = {
  currentUser: member, user: member, token: 'jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), signInWithToken: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(), updateUsername: jest.fn(),
};

const DEVICE = {
  id: 'd1', label: 'sam-laptop · commonly-cli', createdAt: '2026-08-30T12:00:00.000Z', lastUsedAt: '2026-08-31T12:00:00.000Z', revokedAt: null,
};

const withAuth = (ui, value = auth, path = '/') => render(
  <AuthContext.Provider value={value}>
    <MemoryRouter initialEntries={[path]}><div className="v2-root">{ui}</div></MemoryRouter>
  </AuthContext.Provider>,
);

const expectAbsent = (texts: string[]) => {
  for (const text of texts) expect(screen.queryByText(text)).not.toBeInTheDocument();
};

beforeEach(async () => {
  await i18nReady;
  await act(async () => { await i18n.changeLanguage('zh-CN'); });
});

afterEach(async () => {
  jest.clearAllMocks();
  await act(async () => { await i18n.changeLanguage('en'); });
});

describe('Settings under zh-CN', () => {
  test('group titles, rows and actions render in Chinese', async () => {
    axios.get.mockImplementation((url) => Promise.resolve({
      data: url === '/api/auth/devices' ? { devices: [DEVICE] } : { hasToken: false },
    }));
    withAuth(<V2SettingsPage />);

    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeInTheDocument();
    for (const title of ['账号', '访问权限', '外观']) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    }
    expect(screen.getByText('订阅方案')).toBeInTheDocument();
    expect(screen.getByText('API 令牌')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeInTheDocument();
    expect(screen.getByText('连接器')).toBeInTheDocument();
    expect(screen.getByText('管理已连接的服务')).toBeInTheDocument();
    expect(screen.getByText('账号操作')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更换头像' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑资料' })).toBeInTheDocument();
    expect(screen.getByText(/成员/)).toBeInTheDocument();

    // The devices summary counts in Chinese and dates in the active locale.
    const lastUsed = new Date(DEVICE.lastUsedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    expect(await screen.findByText(`1台 CLI 设备 · 上次使用 ${lastUsed}`)).toBeInTheDocument();
    expect(lastUsed).toMatch(/月/);

    fireEvent.click(screen.getByText('设备').closest('summary'));
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument();
    expect(screen.getByText(/^创建于 .* · 上次使用：/)).toBeInTheDocument();

    expectAbsent([
      'Settings', 'Account', 'Access', 'Look', 'Plan', 'API token', 'Generate', 'Connectors',
      'Manage connected services', 'Account actions', 'Devices', 'Refresh', 'Revoke', 'None',
    ]);
    expect(screen.queryByText(/CLI device/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bmember\b/)).not.toBeInTheDocument();
  });

  test('the account menu reads in Chinese', () => {
    withAuth(<V2AccountMenu />);
    fireEvent.click(screen.getByRole('button', { name: '打开账号菜单' }));
    expect(screen.getByText('设置')).toBeInTheDocument();
    expect(screen.getByText('连接')).toBeInTheDocument();
    expect(screen.getByText('退出登录')).toBeInTheDocument();
    expectAbsent(['Settings', 'Connect', 'Sign out']);
  });
});

describe('CLI authorize under zh-CN', () => {
  test('the signed-out card asks for sign-in in Chinese', () => {
    withAuth(<V2CliAuthorize />, { ...auth, currentUser: null, user: null, token: null, isAuthenticated: false }, '/cli/authorize?code=ABCD-EFGH');

    expect(screen.getByRole('heading', { level: 1, name: '授权 Commonly CLI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录后继续' })).toBeInTheDocument();
    expect(screen.getByText('设备验证码')).toBeInTheDocument();
    expectAbsent(['Authorize Commonly CLI', 'Sign in to continue', 'Device code']);
  });

  test('the confirm step names the device and the account in Chinese', async () => {
    axios.post.mockResolvedValue({
      data: { status: 'pending', request: { hostname: 'sam-laptop', clientName: 'commonly-cli', createdAt: new Date().toISOString() } },
    });
    withAuth(<V2CliAuthorize />, auth, '/cli/authorize?code=ABCD-EFGH');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));

    const title = await screen.findByRole('heading', { level: 1, name: /以 @lily 的身份授权/ });
    expect(title).toHaveTextContent('要以 @lily 的身份授权 sam-laptop 吗？');
    expect(title.querySelector('.v2-cli-authorize__host')).toHaveTextContent('sam-laptop');
    expect(screen.getByText('客户端')).toBeInTheDocument();
    expect(screen.getByText('刚刚')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '授权' })).toBeInTheDocument();
    expectAbsent(['Client', 'Instance', 'Requested', 'just now', 'Deny', 'Authorize']);
  });

  test.each([
    'evil</host> as @admin? Trusted <host>x',
    '<1>z</1>',
    '<b>bold</b>',
  ])('a hostname with markup stays literal text inside the host span: %s', async (hostname) => {
    axios.post.mockResolvedValue({
      data: { status: 'pending', request: { hostname, clientName: 'commonly-cli', createdAt: new Date().toISOString() } },
    });
    withAuth(<V2CliAuthorize />, auth, '/cli/authorize?code=ABCD-EFGH');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));

    const title = await screen.findByRole('heading', { level: 1, name: /以 @lily 的身份授权/ });
    const hosts = title.querySelectorAll('.v2-cli-authorize__host');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].textContent).toBe(hostname);
    expect(title).toHaveTextContent(`要以 @lily 的身份授权 ${hostname} 吗？`);
  });
});
