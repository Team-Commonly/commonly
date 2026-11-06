// @ts-nocheck
// D248: GitHub's App user token reads nothing until the App is installed, so the
// connect flow has two more returns. `installed` comes back from "Install &
// Authorize" with no state of ours; `connected&next=access` is a connect that
// still has no installation. Both name the provider and link its page only from
// the page's own catalogue, never from the query. A non-admin is not left with
// the admin-only builtin GitHub card while the hosted one is offered.
import React from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import en from '../../i18n/locales/en.json';
import i18n, { i18nReady } from '../../i18n';
import {
  adminAuth, mockApi, renderPage, findTile, findPopover, pageReady,
} from '../__testkit__/connectorsKit';

jest.mock('axios', () => require('../__testkit__/axiosMock').axiosFactory());

const accessPage = 'https://github.com/apps/commonly-connect/installations/new';
const hostedGithub = (over = {}) => ({
  installableId: 'github-mcp',
  list: 'tools',
  label: 'GitHub',
  description: 'Read GitHub issues, pull requests and files.',
  connectionType: 'hosted-mcp',
  entryId: 'github-mcp',
  available: true,
  accessPage,
  tools: [],
  connections: [],
  installation: null,
  integration: null,
  ...over,
});
const builtinGithub = {
  installableId: 'github', list: 'tools', label: 'GitHub', description: 'Issues and pull requests.', available: true,
  connectionType: 'github-app', broker: { id: 'commonly-grant-broker' }, tools: [], connections: [],
};
// A live grant on the builtin entry: the tool it names is the entry's own.
const builtinGrant = {
  grantId: 'grant_gh', installationId: 'inst-1', target: { kind: 'pod', id: 'p1' }, tools: ['github.list_issues'],
  writeMode: 'read', effectiveAudience: ['a1'], expiresAt: new Date(Date.now() + 86400000).toISOString(),
  revokedAt: null, revokedBy: null, createdAt: new Date(Date.now() - 3600000).toISOString(), grantedBy: 'u1',
};
const githubRow = { _id: 'i-gh', type: 'hosted-mcp', status: 'connected', config: { entryId: 'github-mcp' } };

const settle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
const fill = (text, provider = 'GitHub') => text.replace(/\{\{provider\}\}/g, provider);

beforeEach(() => {
  jest.clearAllMocks();
  window.history.replaceState({}, '', '/v2/connectors');
});

describe('returning from the GitHub App install', () => {
  it('says the App is installed and GitHub is connected when the person has a connected row', async () => {
    window.history.replaceState({}, '', '/v2/connectors?hostedMcp=installed&entryId=github-mcp');
    mockApi({ connectors: [githubRow], installables: [hostedGithub({ connections: [{ connectionId: 'i-gh', owner: 'sam', repo: '' }] })] });
    renderPage();

    expect(await screen.findByText(fill(en.connectors.hostedMcpAppInstalledConnected))).toHaveAttribute('role', 'status');
    expect(screen.queryByText(fill(en.connectors.hostedMcpAppInstalledFinish))).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('asks the person to press Connect when nothing is connected yet', async () => {
    window.history.replaceState({}, '', '/v2/connectors?hostedMcp=installed&entryId=github-mcp');
    mockApi({ installables: [hostedGithub()] });
    renderPage();

    expect(await screen.findByText(fill(en.connectors.hostedMcpAppInstalledFinish))).toHaveAttribute('role', 'status');
    expect(screen.queryByText(fill(en.connectors.hostedMcpAppInstalledConnected))).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('names no provider for an entry its catalogue does not hold', async () => {
    window.history.replaceState({}, '', '/v2/connectors?hostedMcp=installed&entryId=Evil%20Corp');
    mockApi({ installables: [hostedGithub()] });
    renderPage();

    await pageReady();
    await waitFor(() => expect(window.location.search).toBe(''));
    await settle();
    expect(document.body.textContent).not.toContain('Evil Corp');
    expect(document.body.textContent).not.toContain('App installed');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reads in zh-CN', async () => {
    window.history.replaceState({}, '', '/v2/connectors?hostedMcp=installed&entryId=github-mcp');
    mockApi({ installables: [hostedGithub()] });
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      renderPage();
      expect(await screen.findByText('GitHub App 已安装。在 GitHub 卡片上点「连接」完成设置。')).toBeInTheDocument();
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });
});

describe('connected, with the App not installed yet (next=access)', () => {
  it('links the catalogue entry\'s access page, never one from the query', async () => {
    window.history.replaceState({}, '', `/v2/connectors?hostedMcp=connected&entryId=github-mcp&next=access&accessPage=${encodeURIComponent('https://evil.example/')}`);
    mockApi({ connectors: [githubRow], installables: [hostedGithub({ connections: [{ connectionId: 'i-gh', owner: 'sam', repo: '' }] })] });
    renderPage();

    const notice = (await screen.findByText(en.connectors.hostedMcpAccessNext)).closest('.v2-cx-warning');
    expect(notice).toHaveAttribute('role', 'status');
    // GitHub's install page preselects "All repositories" and always reads
    // public repos, so the link carries the choice and what leaving it costs.
    expect(notice).toHaveTextContent("On GitHub, choose 'Only select repositories'.");
    expect(notice).toHaveTextContent(
      'Leave it there and Commonly Connect can reach every repository on the account or org you install it on, including new ones.',
    );
    expect(notice).toHaveTextContent('Public repos are readable either way.');
    const link = within(notice).getByRole('link', { name: fill(en.connectors.hostedMcpAccessOpen) });
    expect(link).toHaveTextContent('Open GitHub');
    expect(link).toHaveAttribute('href', accessPage);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(document.body.innerHTML).not.toContain('evil.example');
    const left = new URLSearchParams(window.location.search);
    ['hostedMcp', 'entryId', 'next'].forEach((key) => expect(left.has(key)).toBe(false));
  });

  it('keeps the manual-revoke notice working beside the access step', async () => {
    const revokePage = 'https://github.com/settings/apps/authorizations';
    window.history.replaceState({}, '', `/v2/connectors?hostedMcp=connected&entryId=github-mcp&revokeAt=${encodeURIComponent(revokePage)}&next=access`);
    mockApi({
      connectors: [{ ...githubRow, config: { entryId: 'github-mcp', revokePage } }],
      installables: [hostedGithub({ connections: [{ connectionId: 'i-gh', owner: 'sam', repo: '' }] })],
    });
    renderPage();

    expect(await screen.findAllByText(en.connectors.hostedMcpAccessNext)).not.toHaveLength(0);
    const popover = await findPopover('GitHub');
    expect(await within(popover).findByRole('link', { name: "Open GitHub's connected apps" })).toHaveAttribute('href', revokePage);
    expect(window.location.search).toBe('');
    // The page's notice carries the warning, so the popover leaves its own copy out.
    expect(screen.getAllByText(en.connectors.hostedMcpAccessNext)).toHaveLength(1);
    expect(within(popover).queryByText(en.connectors.hostedMcpAccessNext)).toBeNull();
    expect(within(popover).queryByRole('link', { name: 'Choose what GitHub can reach' })).toBeNull();
  });

  it('keeps the warning on the entry once no notice is carrying it', async () => {
    const revokePage = 'https://github.com/settings/apps/authorizations';
    window.history.replaceState({}, '', `/v2/connectors?hostedMcp=connected&entryId=github-mcp&revokeAt=${encodeURIComponent(revokePage)}`);
    mockApi({
      connectors: [{ ...githubRow, config: { entryId: 'github-mcp', revokePage } }],
      installables: [hostedGithub({ connections: [{ connectionId: 'i-gh', owner: 'sam', repo: '' }] })],
    });
    renderPage();

    const popover = await findPopover('GitHub');
    expect(await within(popover).findByText(en.connectors.hostedMcpAccessNext)).toBeInTheDocument();
    expect(screen.getAllByText(en.connectors.hostedMcpAccessNext)).toHaveLength(1);
  });

  it('reads in zh-CN, keeping GitHub\'s own option label in English', async () => {
    window.history.replaceState({}, '', '/v2/connectors?hostedMcp=connected&entryId=github-mcp&next=access');
    mockApi({ connectors: [githubRow], installables: [hostedGithub({ connections: [{ connectionId: 'i-gh', owner: 'sam', repo: '' }] })] });
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      renderPage();
      const notice = (await screen.findByText('Only select repositories', { exact: false })).closest('.v2-cx-warning');
      expect(notice).toHaveTextContent('在 GitHub 上选择“Only select repositories”。');
      expect(notice).toHaveTextContent('Commonly Connect 就能访问你安装到的账号或组织下的所有仓库');
      expect(notice).toHaveTextContent('公开仓库无论怎么选都能读取。');
      expect(within(notice).getByRole('link', { name: '打开 GitHub' })).toHaveAttribute('href', accessPage);
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });

  it('shows no access step for an entry without an access page', async () => {
    window.history.replaceState({}, '', '/v2/connectors?hostedMcp=connected&entryId=github-mcp&next=access');
    mockApi({ connectors: [githubRow], installables: [hostedGithub({ accessPage: undefined })] });
    renderPage();

    await pageReady();
    await waitFor(() => expect(window.location.search).toBe(''));
    await settle();
    expect(screen.queryByText(en.connectors.hostedMcpAccessNext)).toBeNull();
  });

  it('leaves other query values in place', async () => {
    window.history.replaceState({}, '', '/v2/connectors?hostedMcp=connected&entryId=github-mcp&next=access&keep=1');
    mockApi({ connectors: [githubRow], installables: [hostedGithub()] });
    renderPage();

    await screen.findByText(en.connectors.hostedMcpAccessNext);
    expect(window.location.search).toBe('?keep=1');
  });
});

describe('the admin-only builtin GitHub card', () => {
  const githubTiles = () => document.querySelectorAll('button.v2-cx-tile[title="GitHub"]');

  it('is not shown to a non-admin while the hosted GitHub entry is offered', async () => {
    mockApi({ installables: [builtinGithub, hostedGithub()] });
    renderPage();

    await findTile('GitHub');
    await settle();
    expect(githubTiles()).toHaveLength(1);
    expect(screen.queryByText(en.tools.noConnection)).toBeNull();
    expect(screen.queryByRole('img', { name: 'An admin installs this once' })).toBeNull();
  });

  it('is still shown to a non-admin when the hosted entry is not offered', async () => {
    mockApi({ installables: [builtinGithub, hostedGithub({ available: false })] });
    renderPage();

    await findTile('GitHub');
    await settle();
    expect(screen.getByRole('img', { name: 'An admin installs this once' })).toBeInTheDocument();
  });

  // The card hides only when it is the empty admin-only card. A connection or a
  // grant on it is the person's own access, and must stay seeable and revocable.
  it('is still shown to a non-admin who already has a builtin GitHub connection', async () => {
    mockApi({
      installables: [
        { ...builtinGithub, connections: [{ connectionId: 'conn-1', owner: 'Team-Commonly', repo: 'commonly' }] },
        hostedGithub(),
      ],
    });
    renderPage();

    await findTile('GitHub');
    await settle();
    expect(githubTiles()).toHaveLength(2);
  });

  it('is still shown to a non-admin who holds a grant on the builtin GitHub entry', async () => {
    mockApi({
      installables: [
        { ...builtinGithub, tools: [{ name: 'github.list_issues', requiredWriteMode: 'read', irreversible: false }] },
        hostedGithub(),
      ],
      grants: [builtinGrant],
    });
    renderPage();

    await findTile('GitHub');
    await settle();
    expect(githubTiles()).toHaveLength(2);
  });

  it('is not counted as available to a non-admin it is hidden from', async () => {
    mockApi({ installables: [builtinGithub, hostedGithub()] });
    renderPage();

    await findTile('GitHub');
    await settle();
    expect(document.querySelector('.v2-cx-head__meta')).toHaveTextContent('0 on · 1 available');
  });

  it('counts for an admin, who sees it', async () => {
    mockApi({ installables: [builtinGithub, hostedGithub()] });
    renderPage({ auth: adminAuth() });

    await findTile('GitHub');
    await settle();
    expect(document.querySelector('.v2-cx-head__meta')).toHaveTextContent('0 on · 2 available');
  });

  it('stays for an admin, who installs the App from it', async () => {
    mockApi({ installables: [builtinGithub, hostedGithub()] });
    renderPage({ auth: adminAuth() });

    await findTile('GitHub');
    await settle();
    expect(githubTiles()).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'An admin installs this once' })).toBeInTheDocument();
  });
});
