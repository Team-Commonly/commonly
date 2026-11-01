// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthContext } from '../../context/AuthContext';
import i18n, { i18nReady } from '../../i18n';
import V2ConnectPage from '../components/V2ConnectPage';
import V2AccountMenu from '../components/V2AccountMenu';
import { CURSOR_PROJECT_RULE, CURSOR_PROJECT_RULE_PATH } from '../utils/cursorProjectRule';

jest.mock('../../utils/axiosConfig', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

jest.mock('../components/V2Avatar', () => {
  const MockV2Avatar = () => <span data-testid="avatar" />;
  MockV2Avatar.displayName = 'MockV2Avatar';
  return MockV2Avatar;
});

const auth = {
  currentUser: { _id: 'u1', username: 'lily', email: 'lily@example.com', role: 'member' },
  user: { _id: 'u1', username: 'lily', email: 'lily@example.com', role: 'member' },
  token: 'jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

const renderConnect = (value = auth) => render(
  <AuthContext.Provider value={value}>
    <MemoryRouter><V2ConnectPage /></MemoryRouter>
  </AuthContext.Provider>,
);

const CurrentPath = () => <div data-testid="current-path">{useLocation().pathname}</div>;

afterEach(() => jest.clearAllMocks());

describe('V2ConnectPage', () => {
  test('the CLI and MCP commands target this instance API', async () => {
    const previousApiUrl = process.env.REACT_APP_API_URL;
    process.env.REACT_APP_API_URL = 'https://api.example.test/';
    try {
      const clipboard = { writeText: jest.fn().mockResolvedValue(undefined) };
      Object.assign(navigator, { clipboard });
      renderConnect();
      const cliSnippet = screen.getByText(/commonly login --instance/).textContent || '';
      const mcpSnippet = screen.getByText(/COMMONLY_AGENT_TOKEN=cm_agent_…/).textContent || '';
      expect(cliSnippet).toContain('commonly login --instance https://api.example.test');
      expect(mcpSnippet).toContain('COMMONLY_API_URL=https://api.example.test');
      expect(cliSnippet).not.toContain('api.commonly.me');
      expect(mcpSnippet).not.toContain('api.commonly.me');
      const cursorHref = screen.getByRole('link', { name: 'Add Commonly to Cursor' }).getAttribute('href') || '';
      expect(cursorHref).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=commonly&config=/);
      const cursorConfig = JSON.parse(atob(decodeURIComponent(cursorHref.split('config=')[1])));
      expect(cursorConfig.env).toEqual({
        COMMONLY_API_URL: 'https://api.example.test',
        COMMONLY_AGENT_TOKEN: 'PASTE_AGENT_TOKEN_HERE',
      });
      expect(cursorHref).not.toContain('api.commonly.me');
      fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
      await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(cliSnippet));
    } finally {
      if (previousApiUrl === undefined) delete process.env.REACT_APP_API_URL;
      else process.env.REACT_APP_API_URL = previousApiUrl;
    }
  });

  test('offers the Cursor project rule with its path and copies it verbatim', async () => {
    const clipboard = { writeText: jest.fn().mockResolvedValue(undefined) };
    Object.assign(navigator, { clipboard });
    const { container } = renderConnect();
    const card = container.querySelector('.v2-connect__rule');
    expect(card).not.toBeNull();
    expect(card.querySelector('.v2-connect__code-head code')).toHaveTextContent(CURSOR_PROJECT_RULE_PATH);
    expect(card.querySelector('.v2-connect__code-head > span')).toHaveTextContent(`Cursor rule · save as ${CURSOR_PROJECT_RULE_PATH} in your project`);
    expect(card.querySelector('pre').textContent).toBe(CURSOR_PROJECT_RULE);
    fireEvent.click(card.querySelector('button.v2-connect__copy'));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(CURSOR_PROJECT_RULE));
  });

  test('gives every member a copyable CLI/MCP start and does not tease instance keys', async () => {
    const clipboard = { writeText: jest.fn().mockResolvedValue(undefined) };
    Object.assign(navigator, { clipboard });
    renderConnect();

    expect(screen.getByRole('heading', { name: 'Connect the CLI or MCP' })).toBeInTheDocument();
    expect(screen.getByText(/commonly login/)).toBeInTheDocument();
    expect(screen.getByText(/COMMONLY_AGENT_TOKEN=cm_agent_…/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage connected CLI devices' })).toHaveAttribute('href', '/v2/settings');
    expect(document.querySelectorAll('.v2-connect__lane-heading p, .v2-connect__note')).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Manage installed agents' })).toHaveAttribute('href', '/v2/agents');
    expect(screen.queryByRole('heading', { name: 'Instance keys' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open global integrations' })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/^npm install -g @commonlyai\/cli\ncommonly login --instance https?:\/\//)));
  });

  test('shows global integrations to admins and no gateway setup to anyone', async () => {
    renderConnect({
      ...auth,
      currentUser: { ...auth.currentUser, role: 'admin' },
      user: { ...auth.user, role: 'admin' },
    });

    expect(screen.getByRole('heading', { name: 'Instance keys' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open global integrations' })).toHaveAttribute('href', '/v2/admin/integrations/global');
    expect(screen.queryByRole('button', { name: 'Add a gateway' })).not.toBeInTheDocument();
    expect(screen.queryByText(/gateway/i)).not.toBeInTheDocument();
  });
});

test('the account menu links to Connect', async () => {
  render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/v2/agents']}>
        <div className="v2-root"><V2AccountMenu /></div>
        <CurrentPath />
      </MemoryRouter>
    </AuthContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open account menu' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Connect', hidden: true }));
  expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/connect');
});

test('the account menu sends the folded Profile surface to Settings', async () => {
  render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/v2/agents']}>
        <div className="v2-root"><V2AccountMenu /></div>
        <CurrentPath />
      </MemoryRouter>
    </AuthContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open account menu' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Settings', hidden: true }));
  expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/settings');
});

describe('V2ConnectPage in zh-CN', () => {
  beforeAll(async () => { await i18nReady; await i18n.changeLanguage('zh-CN'); });
  afterAll(async () => { await i18n.changeLanguage('en'); });

  test('every heading, label, link and copy button reads in Chinese', async () => {
    const clipboard = { writeText: jest.fn().mockResolvedValue(undefined) };
    Object.assign(navigator, { clipboard });
    const { container } = renderConnect({ ...auth, currentUser: { ...auth.currentUser, role: 'admin' } });
    // Chrome only: commands, the rule body and product names stay as written.
    const chrome = [...container.querySelectorAll('h2, a, button, .v2-connect__cursor span, .v2-connect__code-head > span')]
      .map((el) => el.textContent.trim());
    expect(chrome).toEqual(expect.arrayContaining([
      '连接 CLI 或 MCP', '添加到 Cursor', '管理已连接的 CLI 设备', '接入你自己的智能体',
      '接入智能体', '管理已安装的智能体', '实例密钥', '打开全局集成', '复制',
    ]));
    expect(container.querySelector('.v2-connect__rule code')).toHaveTextContent(CURSOR_PROJECT_RULE_PATH);
    expect(container.querySelector('.v2-connect__rule .v2-connect__code-head > span'))
      .toHaveTextContent(`Cursor 规则 · 在项目中保存为 ${CURSOR_PROJECT_RULE_PATH}`);
    expect(container.querySelector('.v2-connect__cursor')).toHaveTextContent('在 Cursor 的 MCP 设置里填入你的智能体密钥。');
    expect(chrome.join('\n')).not.toMatch(/\b(Copy|Copied|Connect|Manage|Add|Set up|Open|Instance keys|save as)\b/);
    fireEvent.click(screen.getAllByRole('button', { name: '复制' })[0]);
    expect(await screen.findByRole('button', { name: '已复制' })).toBeInTheDocument();
  });
});
