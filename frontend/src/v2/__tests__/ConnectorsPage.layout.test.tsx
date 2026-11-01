// @ts-nocheck
// Connectors page, the surface itself (TASK-733): the logo tile grid, the filter and
// search, "+N off", the popover that reveals an unconnected tile, the drawer that
// manages a connected one, and the add tile. Behaviour of what is inside them lives
// in ConnectorsPage.channels / .tools.
import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  axios, mockApi, renderPage, tileNode, findTile, clickTile, findDrawer, findPopover, expandOff, pageReady,
} from '../__testkit__/connectorsKit';

jest.mock('axios', () => require('../__testkit__/axiosMock').axiosFactory());

const pods = [{ _id: 'p1', name: 'Rewire Live Demo', type: 'chat', members: [] }];
const channel = (installableId, label, over = {}) => ({
  installableId, label, description: `${label} copy.`, available: true, offered: true, installation: null, integration: null, ...over,
});
const liveSlack = channel('slack', 'Slack', {
  installation: { status: 'active', updatedAt: new Date().toISOString(), boundPodId: 'p1', components: [] },
  integration: {
    _id: 'i-live', installationId: 'install-slack-u1', type: 'slack', status: 'connected', scope: 'user', isActive: true,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: new Date().toISOString(),
    config: { chatTitle: 'Rewire crew', liveRelay: true, gates: {} }, podId: 'p1',
  },
});
const tool = (installableId, label, over = {}) => ({
  installableId, list: 'tools', label, description: `${label} tool copy.`, available: true,
  tools: [{ name: `${installableId}.read`, requiredWriteMode: 'read', irreversible: false }],
  connections: [{ connectionId: `c-${installableId}`, owner: 'o', repo: 'r' }], installation: null, integration: null, ...over,
});

const mockCatalog = (installables, extra = {}) => mockApi({ installables, pods, ...extra });
const grid = (group) => within(screen.getByRole('region', { name: group })).queryAllByRole('button')
  .filter((node) => node.classList.contains('v2-cx-tile'));

beforeEach(() => {
  jest.clearAllMocks();
  window.history.replaceState({}, '', '/v2/connectors');
});

describe('Connectors page: the tile surface', () => {
  it('renders one logo tile per catalogue entry, grouped under Channels and Tools', async () => {
    mockCatalog([channel('telegram', 'Telegram'), liveSlack, tool('github', 'GitHub'), tool('linear', 'Linear')]);
    renderPage();

    await findTile('GitHub');
    expect(screen.getByRole('heading', { name: 'Connectors' })).toBeInTheDocument();
    const channelTitles = grid('Channels').map((node) => node.getAttribute('title'));
    expect(channelTitles).toEqual(expect.arrayContaining(['Telegram', 'Slack']));
    expect(grid('Tools').map((node) => node.getAttribute('title'))).toEqual(['GitHub', 'Linear']);
    // The logo carries the name: every tile holds an svg and its label, and no
    // description is printed on the grid itself.
    for (const node of [tileNode('Telegram'), tileNode('GitHub')]) {
      expect(node.querySelector('svg')).not.toBeNull();
      expect(node.querySelector('.v2-cx-tile__name')).toHaveTextContent(node.getAttribute('title'));
    }
    expect(screen.queryByText('Telegram copy.')).toBeNull();
    expect(screen.queryByText('GitHub tool copy.')).toBeNull();
    // Counts: Slack is on; Telegram, GitHub, Linear are offered.
    expect(document.querySelector('.v2-cx-head__meta')).toHaveTextContent('1 on · 3 available');
  });

  it('the filter segment hides a group, and All brings it back', async () => {
    mockCatalog([channel('telegram', 'Telegram'), tool('github', 'GitHub')]);
    renderPage();
    await findTile('GitHub');

    const filter = screen.getByRole('group', { name: 'Show' });
    const all = within(filter).getByRole('button', { name: 'All' });
    expect(all).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(filter).getByRole('button', { name: 'Tools' }));
    expect(screen.queryByRole('region', { name: 'Channels' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Tools' })).toBeInTheDocument();
    expect(within(filter).getByRole('button', { name: 'Tools' })).toHaveAttribute('aria-pressed', 'true');
    expect(tileNode('Telegram')).toBeNull();

    fireEvent.click(within(filter).getByRole('button', { name: 'Channels' }));
    expect(screen.queryByRole('region', { name: 'Tools' })).toBeNull();
    expect(tileNode('Telegram')).not.toBeNull();
    expect(tileNode('GitHub')).toBeNull();

    fireEvent.click(all);
    expect(screen.getByRole('region', { name: 'Channels' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tools' })).toBeInTheDocument();
  });

  it('search filters tiles in both groups, drops the add tile, and says when nothing matches', async () => {
    mockCatalog([channel('telegram', 'Telegram'), liveSlack, tool('github', 'GitHub'), tool('linear', 'Linear')]);
    renderPage();
    await findTile('GitHub');
    expect(tileNode('Channel')).not.toBeNull();

    const search = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(search, { target: { value: 'tele' } });
    expect(tileNode('Telegram')).not.toBeNull();
    for (const name of ['Slack', 'GitHub', 'Linear']) expect(tileNode(name)).toBeNull();
    // Searching is for finding what exists, so the add tile steps aside.
    expect(tileNode('Channel')).toBeNull();

    fireEvent.change(search, { target: { value: 'linear' } });
    expect(tileNode('Linear')).not.toBeNull();
    expect(tileNode('Telegram')).toBeNull();

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches.')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: '' } });
    expect(tileNode('Telegram')).not.toBeNull();
    expect(tileNode('Channel')).not.toBeNull();
  });

  it('"+N off" expands the not-offered tiles, dimmed, and collapses them again', async () => {
    mockCatalog([
      channel('telegram', 'Telegram'),
      channel('discord', 'Discord', { available: false, unavailableReason: 'not_configured' }),
      tool('github', 'GitHub'),
      tool('sentry', 'Sentry', { available: false, connections: [] }),
    ]);
    renderPage();
    await findTile('GitHub');

    // One off per group, collapsed: the dead tiles are not in the grid yet.
    const offButtons = screen.getAllByRole('button', { name: '+1 off' });
    expect(offButtons).toHaveLength(2);
    for (const button of offButtons) expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(tileNode('Discord')).toBeNull();
    expect(tileNode('Sentry')).toBeNull();

    await expandOff('Channels');
    expect(tileNode('Discord')).toHaveClass('v2-cx-tile--dim');
    expect(tileNode('Sentry')).toBeNull();
    // The head counts what is on or offered, never what is off.
    expect(document.querySelector('.v2-cx-head__meta')).toHaveTextContent('0 on · 2 available');

    await expandOff('Tools');
    expect(tileNode('Sentry')).toHaveClass('v2-cx-tile--dim');

    const channelsOff = within(screen.getByRole('region', { name: 'Channels' })).getByRole('button', { name: '+1 off' });
    expect(channelsOff).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(channelsOff);
    expect(tileNode('Discord')).toBeNull();
  });

  it('an unconnected tile opens a popover with the act; Escape closes it and returns focus to the tile', async () => {
    mockCatalog([channel('telegram', 'Telegram'), tool('github', 'GitHub')]);
    renderPage();

    const tile = await findTile('Telegram');
    expect(tile).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(tile);
    const popover = await findPopover('Telegram');
    expect(tile).toHaveAttribute('aria-expanded', 'true');
    expect(within(popover).getByText('Telegram copy.')).toBeInTheDocument();
    const act = within(popover).getByRole('button', { name: 'Add' });
    // Focus moves into the popover on open.
    await waitFor(() => expect(act).toHaveFocus());
    expect(screen.queryByRole('region', { name: 'Telegram' })).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Telegram' })).toBeNull());
    expect(tile).toHaveFocus();
    expect(tile).toHaveAttribute('aria-expanded', 'false');
  });

  it('an unconnected tool tile reveals its description, the first tool names as chips, and the act', async () => {
    const names = ['a.one', 'b.two', 'c.three', 'd.four', 'e.five'];
    mockCatalog([tool('github', 'GitHub', { tools: names.map((name) => ({ name, requiredWriteMode: 'read', irreversible: false })) })], { grants: [] });
    renderPage();

    await clickTile('GitHub');
    const popover = await findPopover('GitHub');
    expect(within(popover).getByText('GitHub tool copy.')).toBeInTheDocument();
    for (const name of names.slice(0, 3)) expect(within(popover).getByText(name)).toBeInTheDocument();
    expect(within(popover).queryByText('d.four')).toBeNull();
    expect(within(popover).getByText('+2')).toBeInTheDocument();
    expect(within(popover).getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });

  it('a connected tile opens a drawer with its panel, and the close button closes it', async () => {
    mockCatalog([liveSlack, channel('telegram', 'Telegram')]);
    renderPage();

    const tile = await findTile('Slack');
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(tile);
    const drawer = await findDrawer('Slack');
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(within(drawer).getByRole('heading', { name: 'Slack' })).toBeInTheDocument();
    expect(within(drawer).getByText('What the channel sees')).toBeInTheDocument();
    // A connected tile opens a manage drawer, never the reveal popover.
    expect(screen.queryByRole('dialog', { name: 'Slack' })).toBeNull();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Slack' })).toBeNull();
    expect(tile).toHaveAttribute('aria-pressed', 'false');
  });

  it('a second tile replaces the open drawer, and Escape closes the drawer', async () => {
    mockCatalog([liveSlack, channel('telegram', 'Telegram', {
      installation: { status: 'active', updatedAt: new Date().toISOString(), boundPodId: 'p1', components: [] },
      integration: { ...liveSlack.integration, _id: 'i-tg', installationId: 'install-telegram-u1', type: 'telegram' },
    })]);
    renderPage();

    await clickTile('Slack');
    await findDrawer('Slack');
    await clickTile('Telegram');
    await findDrawer('Telegram');
    expect(screen.queryByRole('region', { name: 'Slack' })).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Telegram' })).toBeNull());
  });

  it('the add tile opens the add form in the drawer, and Close dismisses it', async () => {
    mockCatalog([channel('telegram', 'Telegram'), channel('slack', 'Slack')]);
    renderPage();

    const add = await findTile('Channel');
    expect(add).toHaveClass('v2-cx-tile--add');
    fireEvent.click(add);
    const drawer = await findDrawer('Connect a channel');
    expect(within(drawer).getByText('Next step')).toBeInTheDocument();
    expect(within(drawer).getByRole('group', { name: 'Channel provider' })).toBeInTheDocument();
    expect(within(drawer).getByLabelText('Pod to bridge')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Connect' })).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Connect a channel' })).toBeNull();
  });

  it('a tile mark says what it means: the dot is named, a locked tool has its sentence, a beta tool its word', async () => {
    mockCatalog([
      liveSlack,
      tool('github', 'GitHub', { connections: [] }),
      tool('atlassian', 'Atlassian', { entryId: 'atlassian', connectionType: 'hosted-mcp' }),
    ]);
    renderPage();

    await findTile('Slack');
    expect(within(tileNode('Slack')).getByRole('img', { name: /Rewire crew · linked to Rewire Live Demo/ })).toBeInTheDocument();
    expect(within(tileNode('GitHub')).getByRole('img', { name: 'An admin installs this once' })).toBeInTheDocument();
    const beta = tileNode('Atlassian').querySelector('.v2-cx-tile__beta');
    expect(beta).toHaveTextContent('beta');
    expect(beta).toHaveAttribute('title', 'read in testing');
  });

  it('shows the page-level error when the first read fails', async () => {
    mockApi({ pods });
    axios.get.mockImplementation((url) => (url === '/api/integrations/user/all'
      ? Promise.reject(new Error('down'))
      : Promise.resolve({ data: [] })));
    renderPage();

    await pageReady();
    expect(screen.getByRole('alert')).toHaveClass('v2-cx-error');
  });
  it('keeps a live grant listed when its catalogue entry is gone, so it can still be revoked', async () => {
    const iso = (ms) => new Date(Date.now() + ms).toISOString();
    const orphan = {
      grantId: 'grant_orphan', installationId: 'inst-x', target: { kind: 'pod', id: 'p1' }, tools: ['retired.read'],
      writeMode: 'read', budget: null, effectiveAudience: [], expiresAt: iso(86_400_000), revokedAt: null, revokedBy: null,
      parentGrantId: null, rootGrantId: null, createdAt: iso(-3_600_000), grantedBy: 'u1',
    };
    mockCatalog([tool('github', 'GitHub')], { grants: [orphan] });
    renderPage();

    await findTile('GitHub');
    const row = await screen.findByRole('button', { name: /View Unknown connector/ });
    fireEvent.click(row);
    expect(await findDrawer(/Unknown connector/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Revoke/ })).toBeInTheDocument();
  });

  it('closes the reveal when its act opens a drawer', async () => {
    mockCatalog([tool('github', 'GitHub')]);
    renderPage();

    await clickTile('GitHub');
    const pop = await findPopover('GitHub');
    fireEvent.click(within(pop).getByRole('button', { name: 'Add' }));
    await findDrawer('GitHub');
    expect(screen.queryByRole('dialog', { name: 'GitHub' })).toBeNull();

    // And it stays closed once the drawer closes; it does not come back.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'GitHub' })).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'GitHub' })).toBeNull();
  });

  it('does not refetch in a loop while the pod list cannot load', async () => {
    mockCatalog([tool('github', 'GitHub')], { pods: new Error('pods down') });
    renderPage();

    await findTile('GitHub');
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    const grantCalls = axios.get.mock.calls.filter(([url]) => url === '/api/grants').length;
    expect(grantCalls).toBeLessThanOrEqual(2);
  });

  it('keeps the header count steady while searching', async () => {
    mockCatalog([channel('telegram', 'Telegram'), liveSlack, tool('github', 'GitHub'), tool('linear', 'Linear')]);
    renderPage();

    await findTile('GitHub');
    const meta = () => document.querySelector('.v2-cx-head__meta');
    expect(meta()).toHaveTextContent('1 on · 3 available');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'lin' } });
    await findTile('Linear');
    expect(meta()).toHaveTextContent('1 on · 3 available');
  });

  it('gives an installed provider this instance no longer offers the reveal, not an empty drawer', async () => {
    mockCatalog([
      channel('discord', 'Discord', {
        available: false,
        installation: { status: 'active', updatedAt: new Date().toISOString(), boundPodId: null, components: [] },
      }),
      tool('github', 'GitHub'),
    ]);
    renderPage();

    await findTile('GitHub');
    await expandOff('Channels');
    fireEvent.click(await findTile('Discord'));
    expect(await findPopover('Discord')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Discord' })).toBeNull();
  });
});
