// @ts-nocheck
// Connectors page, channel half: every behaviour the old row page held for channels
// (Phase 1 verbs, Slack authorize/confirm, install lock, gates, catalogue states),
// reached now through a tile, its popover and the right drawer.
import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { PlatformGlyph } from '../icons/platforms';
import { INSTALL_LOCK_TTL_MS, installableLifecyclePath } from '../connectors/channelModel';
import en from '../../i18n/locales/en.json';
import i18n, { i18nReady } from '../../i18n';
import {
  axios, authValue, mockApi, renderPage, renderWithRoutes, pageReady, tileNode, findTile, clickTile,
  openDrawer, openPopover, findDrawer, expandOff,
} from '../__testkit__/connectorsKit';

jest.mock('axios', () => require('../__testkit__/axiosMock').axiosFactory());

const connectors = [
  {
    _id: 'i-pending',
    installationId: 'install-telegram-u1',
    type: 'telegram',
    status: 'pending',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    config: { connectCode: 'abc123', connectCodeExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
    podId: { _id: 'p1', name: 'Rewire Live Demo' },
  },
  {
    _id: 'i-live',
    installationId: 'install-slack-u1',
    type: 'slack',
    status: 'connected',
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    config: { chatTitle: 'Rewire crew', liveRelay: false },
    podId: { _id: 'p2', name: 'Ops' },
  },
];

const roomPods = [
  { _id: 'p1', name: 'Rewire Live Demo', type: 'chat' },
  { _id: 'pub', name: 'Town Square', type: 'community' },
];

// The page reads connectors, the catalogue and pods itself; a suite names only what
// it is about.
const mockGets = (list = connectors, installables = undefined, pods = roomPods) => (
  mockApi({ connectors: list, installables, pods })
);

const hostedLinearCatalogEntry = (connectionId = 'i-linear') => ({
  installableId: 'linear',
  list: 'tools',
  label: 'Linear',
  description: 'Read Linear issues and projects.',
  connectionType: 'hosted-mcp',
  entryId: 'linear',
  available: true,
  tools: [],
  connections: [{ connectionId, owner: 'sam', repo: '' }],
  installation: null,
  integration: null,
});

const slackPending = (config = {}, over = {}) => ({
  _id: 'i-slack-pending',
  installationId: 'install-slack-u1',
  type: 'slack',
  status: 'pending',
  config,
  podId: { _id: 'p1', name: 'Rewire Live Demo' },
  ...over,
});
const pendingBind = { pendingBind: { teamName: 'Commonly HQ', slackUserName: 'sam' } };

// The reconciler's own constant — the reason a person reads when the channel
// record behind a connector is gone (TASK-131 copy pass).
const REASON_CHANNEL_GONE = "This connector's channel is gone. Retry to rebuild it.";

// The page-level slot a refusal must NOT land in when a drawer asked for it.
const pageError = () => document.querySelector('.v2-cx-error');
// A tile's corner dot carries the row's sentence as its accessible name.
const dot = (name) => screen.getByRole('img', { name });

describe('Connectors page: channels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(window, 'open').mockReturnValue(null);
    window.history.replaceState({}, '', '/v2/connectors');
  });

  afterEach(() => jest.restoreAllMocks());

  it('a linked channel tile carries its state sentence, and its drawer says what the channel sees', async () => {
    mockGets([connectors[1]]);
    renderPage();
    await findTile('Slack');
    expect(dot('Rewire crew · linked to Ops')).toBeInTheDocument();
    const drawer = await openDrawer('Slack');
    expect(within(drawer).getByText('What the channel sees')).toBeInTheDocument();
    expect(within(drawer).getByText('Messages stay in the pod.')).toBeInTheDocument();
  });

  // TASK-162: en.json is where the copy lives, so that is where the rule is asserted.
  it('TASK-162: the relay-mode lines never repeat the mode word they sit beside', () => {
    const kickerByRow: Array<[keyof typeof en.connectors, string]> = [
      ['rowAttention', 'attention'],
      ['rowMirror', 'mirror'],
      ['rowRelayOff', 'relay off'],
    ];
    for (const [key, modeWord] of kickerByRow) {
      expect(en.connectors[key]).toBeTruthy();
      expect(en.connectors[key].startsWith(modeWord)).toBe(false);
    }
  });

  it('TASK-338: with nothing connected there is no unbuilt-provider placeholder and no not-yet or SOON copy', async () => {
    mockGets([]);
    renderPage();
    await pageReady();
    expect(screen.queryByText(/not yet/i)).toBeNull();
    expect(screen.queryByText(/Tell us which channel/)).toBeNull();
    expect(screen.queryByText('SOON')).toBeNull();
    expect(document.querySelector('.v2-connector-row__names')).toBeNull();
  });

  it('TASK-131: relative ages advance in place, and a returning tab re-reads, without a reload', async () => {
    // Fake the clock so the minute tick is deterministic. The gate line's age only
    // moves if the page re-renders it, which is the defect being pinned.
    jest.useFakeTimers();
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      mockGets([{
        ...connectors[1],
        podId: 'p1',
        config: { chatTitle: 'Rewire crew', liveRelay: true, gates: { p1: { enabled: true, since: fiveMinutesAgo } } },
      }], undefined, [{ _id: 'p1', name: 'Rewire Live Demo', type: 'chat', members: [] }]);
      renderPage();

      fireEvent.click(await findTile('Slack'));
      expect(await screen.findByText(/^since 5m/)).toBeInTheDocument();

      await act(async () => { jest.advanceTimersByTime(2 * 60_000); });
      expect(screen.getByText(/^since 7m/)).toBeInTheDocument();

      const reads = () => axios.get.mock.calls.filter(([url]) => url === '/api/integrations/user/all').length;
      const before = reads();
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows both channels as tiles and opens the pending one with its code and copy button', async () => {
    mockGets();
    renderPage();

    await findTile('Telegram');
    expect(dot('Send /commonly-enable in your Telegram chat.')).toBeInTheDocument();
    expect(dot('Rewire crew · linked to Ops')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Channels' }).querySelectorAll('.v2-cx-tile')).toHaveLength(2);
    expect(document.querySelector('.v2-connector-row__names')).toBeNull();
    const drawer = await openDrawer('Telegram');
    expect(within(drawer).getByText('/commonly-enable abc1 23')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
  });

  // TASK-156. A linked Slack stores its workspace in `teamName` (slackOAuthService)
  // and never in `chatTitle`, so the sentence read "Slack · linked to Ops" beside
  // the word Slack. The workspace name belongs in the sentence; the tile's name
  // stays the platform.
  describe('the tile names the Slack workspace (TASK-156)', () => {
    const slackRow = (config, podId = { _id: 'p2', name: 'Ops' }) => ({
      _id: 'i-slack',
      installationId: 'install-slack-u1',
      type: 'slack',
      status: 'connected',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      updatedAt: new Date().toISOString(),
      config,
      podId,
    });

    it('reads the teamName when the link carries no chatTitle', async () => {
      mockGets([slackRow({ teamName: 'Acme', liveRelay: false })]);
      renderPage();

      await findTile('Slack');
      expect(dot('Acme · linked to Ops')).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Slack · linked to Ops' })).toBeNull();
    });

    it('reads the teamName on the not-linked variant too', async () => {
      mockGets([slackRow({ teamName: 'Acme', liveRelay: false }, null)]);
      renderPage();

      await findTile('Slack');
      expect(dot('Acme · not linked to a pod')).toBeInTheDocument();
    });

    it('keeps chatTitle winning when the link carries both', async () => {
      mockGets([slackRow({ chatTitle: 'Rewire crew', teamName: 'Acme', liveRelay: false })]);
      renderPage();

      await findTile('Slack');
      expect(dot('Rewire crew · linked to Ops')).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Acme · linked to Ops' })).toBeNull();
    });
  });

  it('offers a new code in the drawer when the Telegram code has expired', async () => {
    mockGets([{ ...connectors[0], config: { connectCode: 'abc123' } }]);
    axios.post.mockResolvedValue({ data: {} });
    renderPage();

    await findTile('Telegram');
    expect(dot('The enable code expired.')).toBeInTheDocument();
    const drawer = await openDrawer('Telegram');
    expect(within(drawer).getByText('The enable code expired.')).toBeInTheDocument();
    expect(screen.queryByText('/commonly-enable abc1 23')).toBeNull();
    fireEvent.click(within(drawer).getByRole('button', { name: 'New code' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/integrations/i-pending/connect-code',
      {},
      expect.anything(),
    ));
  });

  it('opens a connected channel and keeps relay and mode PATCHes in its drawer', async () => {
    mockGets();
    axios.patch.mockResolvedValue({ data: {} });
    renderPage();

    const drawer = await openDrawer('Slack');
    fireEvent.click(within(drawer).getByRole('checkbox', { name: 'Relay' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
      '/api/integrations/i-live',
      { config: { liveRelay: true } },
      expect.anything(),
    ));
  });

  it('PATCHes the mirror mode from the channel drawer', async () => {
    mockGets([{
      ...connectors[1],
      config: { chatTitle: 'Rewire crew', liveRelay: true, relayAllAgentMessages: false },
    }]);
    axios.patch.mockResolvedValue({ data: {} });
    renderPage();

    const drawer = await openDrawer('Slack');
    expect(within(drawer).getByRole('button', { name: 'Attention' })).toBeDisabled();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Mirror' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
      '/api/integrations/i-live',
      { config: { relayAllAgentMessages: true } },
      expect.anything(),
    ));
  });

  it('uses the add drawer with every pod the user is in, and installs through the lifecycle verb', async () => {
    mockGets([]);
    axios.post.mockResolvedValue({ data: { integration: { _id: 'new' } } });
    renderPage();

    fireEvent.click(await findTile('Channel'));
    const drawer = await findDrawer('Connect a channel');
    const picker = within(drawer).getByLabelText('Pod to bridge');
    const options = Array.from(picker.querySelectorAll('option')).map((option) => option.textContent);
    expect(options).toContain('Rewire Live Demo');
    expect(options).toContain('Town Square');
    expect(picker.closest('.v2-cx-drawer')).not.toBeNull();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/telegram/install',
      { podId: 'p1' },
      expect.anything(),
    ));
  });

  it('selects Slack in the add drawer and installs through its lifecycle verb', async () => {
    mockGets([]);
    axios.post.mockResolvedValue({ data: { integration: { _id: 'slack-new' } } });
    renderPage();

    fireEvent.click(await findTile('Channel'));
    const drawer = await findDrawer('Connect a channel');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Slack' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/install',
      { podId: 'p1' },
      expect.anything(),
    ));
  });

  // Each install refusal keeps the form where it is, with the sentence at the page.
  const openAddAndConnect = async () => {
    fireEvent.click(await findTile('Channel'));
    const drawer = await findDrawer('Connect a channel');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Connect' }));
    return drawer;
  };

  it('keeps the form open while an install claim is still in progress', async () => {
    mockGets([]);
    axios.post.mockResolvedValue({ data: { status: 'installing' } });
    renderPage();

    const drawer = await openAddAndConnect();
    expect(await screen.findByText('Still setting up — try again in a moment.')).toBeInTheDocument();
    expect(within(drawer).getByLabelText('Pod to bridge')).toBeInTheDocument();
  });

  it('names the pending pod returned with an install response', async () => {
    mockGets([]);
    axios.post.mockResolvedValue({ data: { status: 'installing', boundPodId: 'p1' } });
    renderPage();

    const drawer = await openAddAndConnect();
    expect(await screen.findByText('Still setting up for Rewire Live Demo — try again in a moment.')).toBeInTheDocument();
    expect(within(drawer).getByLabelText('Pod to bridge')).toBeInTheDocument();
  });

  it('keeps the form open when the server reports an install lock', async () => {
    mockGets([]);
    axios.post.mockRejectedValue({ response: { status: 409, data: { code: 'install_in_progress', boundPodId: 'p1' } } });
    renderPage();

    const drawer = await openAddAndConnect();
    expect(await screen.findByText('Still setting up for Rewire Live Demo — try again in a moment.')).toBeInTheDocument();
    expect(within(drawer).getByLabelText('Pod to bridge')).toBeInTheDocument();
  });

  it('keeps the form open when an install lock does not name its pod', async () => {
    mockGets([]);
    axios.post.mockRejectedValue({ response: { status: 409, data: { code: 'install_in_progress' } } });
    renderPage();

    const drawer = await openAddAndConnect();
    expect(await screen.findByText('Still setting up — try again in a moment.')).toBeInTheDocument();
    expect(within(drawer).getByLabelText('Pod to bridge')).toBeInTheDocument();
  });

  it('names the existing pod when the installable is already bound elsewhere', async () => {
    mockGets([]);
    axios.post.mockRejectedValue({ response: { status: 409, data: { code: 'already_installed', boundPodId: 'p1' } } });
    renderPage();

    const drawer = await openAddAndConnect();
    const refusal = await screen.findByText(/bound to Rewire Live Demo/);
    expect(refusal).toBeInTheDocument();
    // TASK-154 item 6: the old copy ('Remove it to bind a different pod') taught the
    // one-pod model. The refusal is about the bind, and other pods reach the channel
    // through the switches. TASK-173: it names the label the user can actually look
    // for, and the phrase is longer than the section title so a page that merely
    // renders the section cannot satisfy it.
    expect(screen.getByText(/through "Pods that reach this channel"/)).toBeInTheDocument();
    expect(screen.queryByText(/gate switches/)).toBeNull();
    // "Channel details" is the panel's `aria-label` and never visible text, so
    // naming it in the copy sends a sighted user after a string the page does not
    // render.
    expect(refusal.textContent).not.toMatch(/Channel details/);
    expect(screen.queryByText(/Remove it to bind/)).toBeNull();
    expect(within(drawer).getByLabelText('Pod to bridge')).toBeInTheDocument();
  });

  it('disconnects installable and legacy channels through their respective verbs', async () => {
    mockGets([connectors[1]]);
    axios.delete.mockResolvedValue({ data: { status: 'uninstalled' } });
    const firstRender = renderPage();

    let drawer = await openDrawer('Slack');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(drawer).getByRole('button', { name: /Really remove/ }));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith(
      '/api/installables/slack/install',
      expect.anything(),
    ));

    firstRender.unmount();
    mockGets([{ ...connectors[1], installationId: undefined }]);
    axios.patch.mockResolvedValue({ data: {} });
    renderPage();
    drawer = await openDrawer('Slack');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(drawer).getByRole('button', { name: /Really remove/ }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
      '/api/integrations/i-live',
      { isActive: false },
      expect.anything(),
    ));
  });

  it('disconnects an installable Telegram connector through its lifecycle verb', async () => {
    mockGets([{ ...connectors[1], installationId: 'install-telegram-u1', type: 'telegram' }]);
    axios.delete.mockResolvedValue({ data: { status: 'uninstalled' } });
    renderPage();

    const drawer = await openDrawer('Telegram');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(drawer).getByRole('button', { name: /Really remove/ }));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith(
      '/api/installables/telegram/install',
      expect.anything(),
    ));
  });

  it('does not offer another add control once both supported providers are present', async () => {
    mockGets();
    renderPage();

    await findTile('Telegram');
    expect(tileNode('Channel')).toBeNull();
  });

  it('requests the credentialed Slack authorization URL and drops the opener', async () => {
    const slackWindow = { location: { assign: jest.fn() }, close: jest.fn(), opener: window };
    jest.mocked(window.open).mockReturnValue(slackWindow as unknown as Window);
    mockGets([{
      _id: 'i-slack-authorize', installationId: 'install-slack-u1', type: 'slack', status: 'pending',
      config: { connectCode: 'a'.repeat(32), connectCodeExpiresAt: new Date(Date.now() + 60_000).toISOString() },
      podId: { _id: 'p1', name: 'Rewire Live Demo' },
    }]);
    axios.post.mockResolvedValue({ data: { authorizeUrl: 'https://slack.test/oauth?state=secret' } });
    renderPage();

    const drawer = await openDrawer('Slack');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Authorize in Slack' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/authorize-url',
      {},
      expect.objectContaining({ withCredentials: true }),
    ));
    expect(slackWindow.location.assign).toHaveBeenCalledWith('https://slack.test/oauth?state=secret');
    expect(slackWindow.opener).toBeNull();
  });

  const slackAuthorize = () => ({
    _id: 'i-slack-authorize', installationId: 'install-slack-u1', type: 'slack', status: 'pending',
    config: {}, podId: { _id: 'p1', name: 'Rewire Live Demo' },
  });

  it('keeps an un-coded Slack authorization failure generic — the fallback (Row C control)', async () => {
    mockGets([slackAuthorize()]);
    axios.post.mockRejectedValue({ response: { status: 503 } });
    renderPage();

    const drawer = await openDrawer('Slack');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Authorize in Slack' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/authorize-url',
      {},
      expect.objectContaining({ withCredentials: true }),
    ));
    // A refusal with no body still gets the generic sentence — the fallback the
    // named codes must not have replaced.
    const shown = await screen.findAllByText('Could not begin Slack authorization. Try again in a moment.');
    expect(shown.length).toBeGreaterThan(0);
  });

  it('names a refused Slack authorize in the drawer that asked, not at the page foot (Row C)', async () => {
    mockGets([slackAuthorize()]);
    axios.post.mockRejectedValue({
      response: { status: 409, data: { code: 'slack_already_authorized', error: 'Upstream wording that a known code must not surface.' } },
    });
    renderPage();

    const drawer = await openDrawer('Slack');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Authorize in Slack' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalled());

    // The code's own copy, not the server sentence the same body also carries.
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('Slack is already awaiting confirmation or connected.');
    expect(within(drawer).queryByText(/Upstream wording/)).toBeNull();
    // Placement is the defect (Row C): the page-level slot used to be the only one.
    expect(pageError()).toBeNull();
  });

  it('uses the server sentence when the refusal code is not one the page knows (Row C)', async () => {
    mockGets([slackAuthorize()]);
    axios.post.mockRejectedValue({
      response: { status: 503, data: { code: 'slack_upstream_unavailable', error: 'Slack refused the handshake.' } },
    });
    renderPage();

    const drawer = await openDrawer('Slack');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Authorize in Slack' }));
    await waitFor(() => expect(within(drawer).getByRole('alert')).toHaveTextContent('Slack refused the handshake.'));
  });

  it('names a failed Slack confirm in the drawer, not in the page slot (Row C)', async () => {
    mockGets([slackPending(pendingBind)]);
    axios.post.mockRejectedValue({
      response: { status: 409, data: { code: 'slack_bind_expired', error: 'Upstream wording that a known code must not surface.' } },
    });
    renderPage();

    const drawer = await openDrawer('Slack');
    expect(within(drawer).getByText('Commonly HQ wants to connect as @sam.')).toBeInTheDocument();
    expect(within(drawer).getByText('No agent is in this pod yet. Messages will reach the pod; choose a lead later.')).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Confirm connection' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/installables/slack/confirm', {}, expect.anything()));

    expect(await within(drawer).findByRole('alert')).toHaveTextContent('Slack authorization expired. Start again.');
    expect(pageError()).toBeNull();
  });

  it('confirms a Slack connection from the drawer', async () => {
    mockGets([slackPending(pendingBind)]);
    axios.post.mockResolvedValue({ data: { status: 'connected' } });
    renderPage();

    const drawer = await openDrawer('Slack');
    expect(within(drawer).getByText('Commonly HQ wants to connect as @sam.')).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Confirm connection' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/confirm',
      {},
      expect.anything(),
    ));
  });

  it('requires a pod agent at Slack bind and sends the selected lead', async () => {
    mockGets([slackPending(pendingBind)], undefined, [{
      _id: 'p1', name: 'Rewire Live Demo', type: 'chat',
      members: [{ _id: 'agent-1', username: 'kai', isBot: true }],
    }]);
    axios.post.mockResolvedValue({ data: { status: 'connected' } });
    renderPage();

    const drawer = await openDrawer('Slack');
    const confirm = within(drawer).getByRole('button', { name: 'Confirm connection' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(axios.post).not.toHaveBeenCalledWith('/api/installables/slack/confirm', expect.anything(), expect.anything());
    fireEvent.change(within(drawer).getByLabelText('Agent for plain messages'), { target: { value: 'kai' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/confirm', { leadAgentUsername: 'kai' }, expect.anything(),
    ));
  });

  it('does not treat a failed pod read as an empty pod at Slack confirmation', async () => {
    mockGets([slackPending(pendingBind)], undefined, new Error('pods unavailable'));
    renderPage();

    const drawer = await openDrawer('Slack');
    expect(within(drawer).getByText('Commonly HQ wants to connect as @sam.')).toBeInTheDocument();
    expect(within(drawer).queryByText('No agent is in this pod yet. Messages will reach the pod; choose a lead later.')).toBeNull();
    expect(within(drawer).getByRole('button', { name: 'Confirm connection' })).toBeDisabled();
  });

  it('keeps rejection reachable from the Slack drawer', async () => {
    mockGets([slackPending(pendingBind)]);
    axios.post.mockResolvedValue({ data: { status: 'rejected' } });
    renderPage();

    const drawer = await openDrawer('Slack');
    fireEvent.click(within(drawer).getByRole('button', { name: 'This is not me' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/reject',
      {},
      expect.anything(),
    ));
  });

  it('consumes an opaque Slack callback result without rendering its code', async () => {
    window.history.replaceState({}, '', '/v2/connectors?slack=error&code=invalid_state');
    mockGets([]);
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Slack authorization didn’t complete — try again.');
    expect(window.location.search).toBe('');
    expect(screen.queryByText('invalid_state')).toBeNull();
  });

  it('shows a fixed unrequested-scope notice and consumes hostile callback query values', async () => {
    window.history.replaceState(
      {},
      '',
      '/v2/connectors?hostedMcp=error&code=unrequested_scope&extraScope=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&extraScope=spoofed',
    );
    mockGets([]);
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "The provider granted access Commonly didn’t ask for, so the connection wasn’t saved.",
    );
    expect(window.location.search).toBe('');
    expect(screen.queryByText(/img|spoofed/i)).toBeNull();
    expect(screen.queryByText('unrequested_scope')).toBeNull();
  });

  it.each([
    ['unknown_entry', 'hostedMcpUnknownEntry'],
    ['invalid_state', 'hostedMcpInvalidState'],
    ['state_expired', 'hostedMcpInvalidState'],
    ['state_consumed', 'hostedMcpInvalidState'],
    ['browser_mismatch', 'hostedMcpInvalidState'],
    ['issuer_mismatch', 'hostedMcpInvalidState'],
    ['consent_denied', 'hostedMcpConsentDenied'],
    ['vendor_error', 'hostedMcpVendorError'],
    ['rate_limited', 'hostedMcpRateLimited'],
    ['issuer_unreachable', 'hostedMcpIssuerUnavailable'],
    ['issuer_metadata_incomplete', 'hostedMcpIssuerUnavailable'],
    ['client_not_configured', 'hostedMcpClientSetup'],
    ['client_registration_required', 'hostedMcpClientSetup'],
    ['client_registration_unsupported', 'hostedMcpClientSetup'],
    ['client_registration_refused', 'hostedMcpClientSetup'],
    ['client_auth_unsupported', 'hostedMcpClientSetup'],
    ['client_auth_refused', 'hostedMcpClientSetup'],
    ['authorization_parameter_conflict', 'hostedMcpClientSetup'],
    ['exchange_refused', 'hostedMcpExchangeRefused'],
    ['exchange_unreachable', 'hostedMcpExchangeUnreachable'],
    ['exchange_incomplete', 'hostedMcpExchangeIncomplete'],
    ['exchange_invalid_scope', 'hostedMcpExchangeIncomplete'],
    ['unrequested_scope', 'hostedMcpUnrequestedScope'],
    ['authentication_required', 'hostedMcpAuthenticationRequired'],
  ])('shows a fixed notice for hosted-MCP code %s and consumes the query', async (code, noticeKey) => {
    window.history.replaceState({}, '', `/v2/connectors?hostedMcp=error&code=${code}&error_description=spoofed`);
    mockGets([]);
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(en.connectors[noticeKey]);
    expect(window.location.search).toBe('');
    expect(screen.queryByText(/spoofed/)).toBeNull();
  });

  it('reloads connectors after a successful Slack callback and clears its query', async () => {
    window.history.replaceState({}, '', '/v2/connectors?slack=pending');
    mockGets([]);
    renderPage();

    await waitFor(() => expect(
      axios.get.mock.calls.filter(([url]) => url === '/api/integrations/user/all').length,
    ).toBeGreaterThanOrEqual(2));
    expect(window.location.search).toBe('');
  });

  // The manual-revoke notice rides the tool's reveal (its popover while nothing is
  // granted), so the person opens the Linear tile to read it.
  const connectedHosted = (id, entryId, revokePage) => ([{
    _id: id, type: 'hosted-mcp', status: 'connected', config: { entryId, revokePage },
  }]);
  const hostedEntry = (id, installableId, label) => ({
    ...hostedLinearCatalogEntry(id), installableId, label, entryId: installableId,
  });
  const callbackUrl = (entryId, revokePage) => (
    `/v2/connectors?hostedMcp=connected&entryId=${entryId}&revokeAt=${encodeURIComponent(revokePage)}`
  );

  it('shows the server-owned provider revoke page after a hosted-MCP reconnect needs manual withdrawal', async () => {
    const revokePage = 'https://linear.app/settings/security';
    window.history.replaceState({}, '', callbackUrl('linear', revokePage));
    mockGets(connectedHosted('i-linear', 'linear', revokePage), [hostedLinearCatalogEntry()]);
    renderPage();

    const popover = await openPopover('Linear');
    const reviewLink = await within(popover).findByRole('link', { name: "Open Linear's connected apps" });
    expect(reviewLink).toHaveAttribute('href', revokePage);
    expect(reviewLink).toHaveAttribute('target', '_blank');
    expect(reviewLink).toHaveAttribute('rel', 'noopener noreferrer');
    const notice = within(popover).getByRole('status');
    expect(notice).toHaveTextContent(
      'Your previous Linear account may still have an MCP grant connected. Switch to it in Linear, then revoke the MCP grant under Linear\'s connected apps.',
    );
    expect(window.location.search).toBe('');
  });

  it('the manual-revoke notice tells the person to switch to the account they connected before', async () => {
    const revokePage = 'https://linear.app/settings/security';
    window.history.replaceState({}, '', callbackUrl('linear', revokePage));
    mockGets(connectedHosted('i-linear', 'linear', revokePage), [hostedLinearCatalogEntry()]);
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    try {
      renderPage();

      const popover = await openPopover('Linear');
      const reviewLink = await within(popover).findByRole('link', { name: '打开 Linear 的已连接应用' });
      expect(reviewLink).toHaveAttribute('href', revokePage);
      expect(within(popover).getByRole('status')).toHaveTextContent(
        '你之前的 Linear 账号可能仍连着一个 MCP 授权。请在 Linear 切换到那个账号，再在其已连接应用中撤销该 MCP 授权。',
      );
      expect(window.location.search).toBe('');
    } finally {
      await act(async () => { await i18n.changeLanguage('en'); });
    }
  });

  it('warns that removing Supabase authorization disconnects everyone in the organization', async () => {
    const revokePage = 'https://supabase.com/dashboard/org/_/apps';
    window.history.replaceState({}, '', callbackUrl('supabase', revokePage));
    mockGets(connectedHosted('i-supabase', 'supabase', revokePage), [hostedEntry('i-supabase', 'supabase', 'Supabase')]);
    renderPage();

    const popover = await openPopover('Supabase');
    const reviewLink = await within(popover).findByRole('link', { name: 'Open Supabase Authorized apps' });
    expect(reviewLink).toHaveAttribute('href', revokePage);
    expect(within(popover).getByRole('status')).toHaveTextContent(
      'Removing Commonly under Authorized apps disconnects everyone who connected that organization.',
    );
    expect(within(popover).getByRole('status')).not.toHaveTextContent('remove Commonly there');
  });

  it('warns that revoking the Sentry MCP app ends every client that server holds, and does not name Commonly', async () => {
    const revokePage = 'https://sentry.io/settings/account/api/authorizations/';
    window.history.replaceState({}, '', callbackUrl('sentry', revokePage));
    mockGets(connectedHosted('i-sentry', 'sentry', revokePage), [hostedEntry('i-sentry', 'sentry', 'Sentry')]);
    renderPage();

    const popover = await openPopover('Sentry');
    const reviewLink = await within(popover).findByRole('link', { name: "Open Sentry's connected apps" });
    expect(reviewLink).toHaveAttribute('href', revokePage);
    expect(within(popover).getByRole('status')).toHaveTextContent(
      'Revoking it ends every client that server holds for the account, not only Commonly.',
    );
    expect(within(popover).getByRole('status')).not.toHaveTextContent('remove Commonly there');
  });

  it('keeps the generic manual-revoke copy for an entry without its own', async () => {
    const revokePage = 'https://airtable.com/account/security';
    window.history.replaceState({}, '', callbackUrl('airtable', revokePage));
    mockGets(connectedHosted('i-airtable', 'airtable', revokePage), [hostedEntry('i-airtable', 'airtable', 'Airtable')]);
    renderPage();

    const popover = await openPopover('Airtable');
    expect(await within(popover).findByRole('link', { name: "Open Airtable's connected apps" })).toHaveAttribute('href', revokePage);
    expect(within(popover).getByRole('status')).toHaveTextContent(
      'Your previous Airtable account may still have Commonly connected. Switch to it on Airtable, then remove Commonly there.',
    );
  });

  it('does not turn a callback query into a provider link unless it matches the connection', async () => {
    window.history.replaceState(
      {},
      '',
      '/v2/connectors?hostedMcp=connected&entryId=linear&revokeAt=https%3A%2F%2Fevil.example%2F',
    );
    mockGets(connectedHosted('i-linear', 'linear', 'https://linear.app/settings/security'), [hostedLinearCatalogEntry()]);
    renderPage();

    const popover = await openPopover('Linear');
    expect(within(popover).getByText('Read Linear issues and projects.')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.queryByRole('link', { name: "Open Linear's connected apps" })).toBeNull();
  });

  it('shows the error reconnect action and retains the separate removal action', async () => {
    mockGets([{
      _id: 'i-slack-error', installationId: 'install-slack-u1', type: 'slack', status: 'error',
      config: { chatTitle: 'Commonly HQ', liveRelay: true },
      podId: { _id: 'p1', name: 'Rewire Live Demo' },
    }]);
    axios.post.mockRejectedValue({ response: { status: 503 } });
    renderPage();

    const drawer = await openDrawer('Slack');
    expect(within(drawer).getByText('The connection dropped.')).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Authorize in Slack' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/authorize-url',
      {},
      expect.objectContaining({ withCredentials: true }),
    ));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Remove' }));
    expect(within(drawer).getByRole('button', { name: /Really remove/ })).toBeInTheDocument();
  });

  it('names the reason a connector needs attention when the server sent one', async () => {
    // The sentence is the only place a person sees why relaying stopped. A classified
    // permanent failure writes `errorMessage`; the generic sentence is the fallback
    // for everything else, not a replacement for it.
    const reason = 'Telegram stopped delivering: the bot was blocked or removed from this chat.';
    mockGets([{
      _id: 'i-tg-error', installationId: 'install-tg-u1', type: 'telegram', status: 'error', errorMessage: reason,
      // The flag is what makes the message readable to a person: it is set by
      // connectorDeliveryFailureService, the writer that owns the pair.
      errorMessageUserFacing: true,
      config: { chatTitle: 'Ops chat', liveRelay: true },
      podId: { _id: 'p1', name: 'Rewire Live Demo' },
    }]);
    renderPage();

    await findTile('Telegram');
    expect(dot(reason)).toBeInTheDocument();
    const drawer = await openDrawer('Telegram');
    expect(within(drawer).getByText(reason)).toBeInTheDocument();
    expect(screen.queryByText('The connection dropped.')).toBeNull();
  });

  it('does not print a provider error text for a channel, only a message written for a person', async () => {
    // `Integration.errorMessage` has an older writer: externalFeedService copies a
    // provider's response, or a raw exception message, into it for the `x` and
    // `instagram` rows. Those rows reach this same error branch, so a value in the
    // field is not permission to render it — `errorMessageUserFacing` is, and it is
    // absent here. The drawer still shows the generic sentence.
    const raw = 'connect ECONNREFUSED 10.4.4.7:443';
    mockGets([{
      _id: 'i-x-error', installationId: 'install-x-u1', type: 'x', status: 'error', errorMessage: raw,
      config: { chatTitle: 'Feed' },
      podId: { _id: 'p1', name: 'Rewire Live Demo' },
    }]);
    renderPage();

    const drawer = await openDrawer('X');
    expect(within(drawer).getByText('The connection dropped.')).toBeInTheDocument();
    expect(screen.queryByText(raw)).toBeNull();
    expect(screen.queryByRole('img', { name: raw })).toBeNull();
  });

  it('derives the installable lifecycle target from the connector type', () => {
    expect(installableLifecyclePath('slack')).toBe('/api/installables/slack/install');
  });

  // D8 Phase 2: tiles keyed by the capability catalog (D1/D2), the panel's gate
  // list (D4), and the not-linked state (#1551).
  describe('catalog tiles', () => {
    const entry = (over = {}) => ({
      installableId: 'telegram',
      label: 'Telegram',
      // Mirror of the provider manifest's copy, which the server sends as the
      // entry's description. The source pin is backend manifestReadiness.
      description: 'Link your Telegram chat to Commonly — every pod you turn on reaches it.',
      available: true,
      installation: null,
      integration: null,
      ...over,
    });
    const liveIntegration = (over = {}) => ({
      _id: 'i-live',
      installationId: 'install-slack-u1',
      type: 'slack',
      status: 'connected',
      scope: 'user',
      isActive: true,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      updatedAt: new Date().toISOString(),
      config: { chatTitle: 'Rewire crew', liveRelay: true, gates: { p1: { enabled: true, since: '2026-09-01T00:00:00.000Z' } } },
      podId: 'p1',
      ...over,
    });
    const slackEntry = (over = {}) => entry({
      installableId: 'slack',
      label: 'Slack',
      installation: { status: 'active', updatedAt: new Date().toISOString(), components: [] },
      integration: liveIntegration(),
      ...over,
    });
    const mockCatalog = (installables, list = [], pods = [
      { _id: 'p1', name: 'Rewire Live Demo', type: 'chat', members: [{ _id: 'b1', username: 'vale', isBot: true }] },
      { _id: 'p2', name: 'Ops', type: 'team', members: [] },
    ]) => mockApi({ connectors: list, installables, pods });

    // TASK-155. The walk found that adding a channel with a live channel open left
    // the panel on that channel: the form rendered beside it instead, so the picker
    // appeared somewhere other than the panel the page uses for the thing you are doing.
    it('TASK-155: adding a channel moves the drawer to the picker', async () => {
      mockCatalog([entry(), slackEntry({ installation: { status: 'active', boundPodId: 'p1' } })]);
      renderPage();
      const slack = await openDrawer('Slack');
      expect(within(slack).getByText('What the channel sees')).toBeInTheDocument();

      const popover = await openPopover('Telegram');
      fireEvent.click(within(popover).getByRole('button', { name: 'Add' }));

      const form = await findDrawer('Connect a channel');
      expect(within(form).getByLabelText('Pod to bridge')).toBeInTheDocument();
      expect(screen.queryByText('What the channel sees')).toBeNull();
      // One form, not two.
      expect(screen.getAllByLabelText('Pod to bridge')).toHaveLength(1);
    });

    it('TASK-155: the add tile moves the drawer while a channel is open', async () => {
      mockCatalog([entry(), slackEntry({ installation: { status: 'active', boundPodId: 'p1' } })]);
      renderPage();
      await openDrawer('Slack');

      fireEvent.click(await findTile('Channel'));

      const form = await findDrawer('Connect a channel');
      expect(within(form).getByLabelText('Pod to bridge')).toBeInTheDocument();
      expect(screen.getAllByLabelText('Pod to bridge')).toHaveLength(1);
      expect(screen.queryByText('What the channel sees')).toBeNull();
    });

    it('TASK-155: opening a channel while the form is open closes the form', async () => {
      mockCatalog([entry(), slackEntry({ installation: { status: 'active', boundPodId: 'p1' } })]);
      renderPage();
      fireEvent.click(await findTile('Channel'));
      expect(within(await findDrawer('Connect a channel')).getByLabelText('Pod to bridge')).toBeInTheDocument();

      fireEvent.click(await findTile('Slack'));

      // The form wins the drawer while it is open, so the tile click has to close
      // it — otherwise this is the walk's symptom pointed the other way
      // (connector-ops 74623 item 1).
      expect(within(await findDrawer('Slack')).getByText('What the channel sees')).toBeInTheDocument();
      expect(screen.queryByLabelText('Pod to bridge')).toBeNull();
    });

    it('TASK-155: the picker takes focus when the form opens', async () => {
      mockCatalog([entry()]);
      renderPage();

      fireEvent.click(await findTile('Channel'));

      // At 390 the panel is below the fold of the page's scroller; focus is what
      // scrolls the picker into view (connector-ops 74623 item 2).
      expect(await screen.findByLabelText('Pod to bridge')).toHaveFocus();
    });

    it('TASK-155: the picker defaults to a room, never a personal pod', async () => {
      mockCatalog([entry()], [], [
        { _id: 'p-scout', name: 'Scout (Default)', type: 'agent-room', members: [] },
        { _id: 'p1', name: 'Rewire Live Demo', type: 'chat', members: [] },
        { _id: 'p2', name: 'Ops', type: 'team', members: [] },
      ]);
      renderPage();

      fireEvent.click(await findTile('Channel'));

      const picker = (await screen.findByLabelText('Pod to bridge')) as HTMLSelectElement;
      expect(picker.value).toBe('p1');
      // A DM stays selectable: it is a legal target, just never the default.
      expect(Array.from(picker.options).map((option) => option.textContent)).toContain('Scout (Default)');
    });

    it('counts connected channels in the page head, not catalogue options', async () => {
      mockCatalog([entry(), slackEntry({ installation: { status: 'active', boundPodId: 'p1' } })]);
      renderPage();

      await findTile('Slack');
      expect(document.querySelector('.v2-cx-head__meta')).toHaveTextContent('1 on · 1 available');
    });

    it('counts nothing as on when the catalogue has no live channels', async () => {
      mockCatalog([entry(), entry({ installableId: 'discord', label: 'Discord' })]);
      renderPage();

      await findTile('Telegram');
      expect(document.querySelector('.v2-cx-head__meta')).toHaveTextContent('0 on · 2 available');
    });

    it('TASK-131: a catalog failure prints the generic sentence, not the raw exception that wrote the row', async () => {
      // The catalogue half reads `InstallableInstallation.errorMessage`, whose
      // projection-failure writer stores `error.message` verbatim. Same rule as the
      // pod-scoped half: a value in the field is not permission to render it, and
      // the flag is absent on this fixture.
      const raw = 'connect ECONNREFUSED 10.4.4.7:443';
      mockCatalog([entry({ installation: { status: 'error', errorMessage: raw } })]);
      renderPage();

      const drawer = await openDrawer('Telegram');
      expect(within(drawer).getByText('Setup didn’t finish.')).toBeInTheDocument();
      expect(screen.queryByText(raw)).toBeNull();
    });

    it('TASK-131: a catalog message written for a person still renders verbatim', async () => {
      // The reconciler's own reasons are written for the person reading this tile,
      // and the flag the builder sets beside them is what keeps them readable once
      // the generic sentence became the fallback.
      mockCatalog([entry({ installation: { status: 'error', errorMessage: REASON_CHANNEL_GONE, errorMessageUserFacing: true } })]);
      renderPage();

      const drawer = await openDrawer('Telegram');
      expect(within(drawer).getByText(REASON_CHANNEL_GONE)).toBeInTheDocument();
      expect(screen.queryByText('Setup didn’t finish.')).toBeNull();
    });

    // Tools plan (option A, two lists): a tool Installable shares the catalogue
    // response but belongs to the Tools group, never to Channels.
    it('a tool Installable in the catalogue never renders as a channel tile', async () => {
      mockCatalog([
        {
          installableId: 'github',
          list: 'tools',
          label: 'GitHub',
          description: 'Issues and pull requests.',
          available: true,
          broker: { id: 'commonly-grant-broker' },
          tools: [{ name: 'github.list_issues', requiredWriteMode: 'read', irreversible: false }],
          connections: [],
          installation: null,
          integration: null,
        },
        entry({ list: 'channels' }),
      ]);
      renderPage();

      await findTile('Telegram');
      const channels = screen.getByRole('region', { name: 'Channels' });
      const tools = screen.getByRole('region', { name: 'Tools' });
      expect(channels.querySelector('button.v2-cx-tile[title="GitHub"]')).toBeNull();
      expect(tools.querySelector('button.v2-cx-tile[title="GitHub"]')).not.toBeNull();
      expect(channels.querySelector('button.v2-cx-tile[title="Telegram"]')).not.toBeNull();
      expect(tools.querySelector('button.v2-cx-tile[title="Telegram"]')).toBeNull();
    });

    it('keeps tool-only connections out of Channels and refuses an unknown type as a tile title', async () => {
      mockCatalog([entry()], [
        {
          // Real hosted-MCP rows have no installationId; filter them by type.
          _id: 'i-hosted-linear', type: 'hosted-mcp', status: 'connected',
          config: { entryId: 'linear' },
        },
        {
          _id: 'i-github-app', installationId: 'github-install', type: 'github-app', status: 'connected',
        },
        {
          _id: 'i-unknown-channel', type: 'custom-messaging-platform', status: 'connected',
        },
      ]);
      renderPage();

      await findTile('Telegram');
      const channels = screen.getByRole('region', { name: 'Channels' });
      const titles = Array.from(channels.querySelectorAll('button.v2-cx-tile')).map((tile) => tile.getAttribute('title'));
      // Telegram, and the add tile for the one provider still to connect. No tile
      // for a hosted tool, the GitHub App or an unmapped type.
      expect(titles).toEqual(['Telegram', 'Channel']);
      for (const text of ['hosted-mcp', 'github-app', 'Hosted tool', 'GitHub App', 'custom-messaging-platform', 'Custom Messaging Platform']) {
        expect(screen.queryByText(text)).toBeNull();
        expect(screen.queryByTitle(text)).toBeNull();
      }
    });

    // TASK-024. Discord is a shipping connector (routes/discord.ts: install link,
    // callback, binding, uninstall) that read as "we don't build this" because its
    // manifest declared no readiness(), which is what the catalog filters on. Once
    // it declares one the catalog owns every claim about it: configured -> a
    // connectable tile, not configured -> the not-enabled tile that already exists
    // for slack.
    const glyphPath = (type: string): string | null => {
      const { container } = renderPlatformGlyph(type);
      return container.querySelector('svg path')?.getAttribute('d') || null;
    };
    const renderPlatformGlyph = (type: string) => {
      // eslint-disable-next-line global-require
      const { render } = require('@testing-library/react');
      return render(<PlatformGlyph type={type} />);
    };

    it('TASK-338: not-offered channels fold under "+N off", below the live tiles, collapsed', async () => {
      mockCatalog([
        entry({ installableId: 'slack', label: 'Slack', available: false, unavailableReason: 'not_configured' }),
        entry({
          installableId: 'telegram',
          label: 'Telegram',
          available: true,
          installation: { status: 'active', updatedAt: new Date().toISOString(), components: [] },
          integration: liveIntegration({ _id: 'i-tg', installationId: 'install-telegram-u1', type: 'telegram' }),
        }),
      ]);
      renderPage();
      await findTile('Telegram');
      const channels = screen.getByRole('region', { name: 'Channels' });
      const off = within(channels).getByRole('button', { name: '+1 off' });
      expect(off).toHaveAttribute('aria-expanded', 'false');
      expect(tileNode('Slack')).toBeNull();
      expect(channels.querySelector('button.v2-cx-tile')).toHaveAttribute('title', 'Telegram');
      fireEvent.click(off);
      expect(off).toHaveAttribute('aria-expanded', 'true');
      expect(tileNode('Slack')).toHaveClass('v2-cx-tile--dim');
    });

    it('renders the zh-CN catalog copy for a channel and the server text for an unmapped one', async () => {
      mockCatalog([
        entry({ list: 'channels' }),
        entry({ installableId: 'acme-chat', label: 'Acme Chat', description: 'Acme chat server copy.' }),
      ]);
      await i18nReady;
      await act(async () => { await i18n.changeLanguage('zh-CN'); });
      try {
        renderPage();
        const telegram = await openPopover('Telegram');
        expect(within(telegram).getByText('把你的 Telegram 聊天接入 Commonly，你开启的每个 Pod 都能把消息发到这里。')).toBeInTheDocument();
        // `Acme Chat` has no mapped label, so it is not a Channels tile; the unmapped
        // description is the server's own and is not asserted through a tile here.
      } finally {
        await act(async () => { await i18n.changeLanguage('en'); });
      }
    });

    it('describes Discord only through the catalog, never as a provider we have not built', async () => {
      mockCatalog([
        entry({ installableId: 'discord', label: 'Discord', available: false, unavailableReason: 'not_configured' }),
      ]);
      renderPage();

      await pageReady();
      await expandOff('Channels');
      const tile = await findTile('Discord');
      expect(tile).toHaveClass('v2-cx-tile--dim');
      expect(tile.textContent).toContain('Discord');
      expect(tile.querySelector('svg')).not.toBeNull();
      const popover = await openPopover('Discord');
      expect(within(popover).getByText('ask your operator')).toBeInTheDocument();
      expect(screen.queryByText(/Tell us which channel/)).toBeNull();
    });

    it('offers a rostered provider with Add, and an unmapped one inherits no onboarding sentence', async () => {
      // Slack's line is in the map; Discord's is not. The point of the map is that
      // Discord renders NO sentence rather than Slack's.
      mockCatalog([
        entry({ installableId: 'discord', label: 'Discord', available: true, offered: true }),
        entry({ installableId: 'slack', label: 'Slack', available: true, offered: true }),
      ]);
      renderPage();

      const discord = await openPopover('Discord');
      expect(discord.textContent).not.toContain('one click in your workspace');
      expect(discord.textContent).not.toContain('one message');
      expect(within(discord).getByRole('button', { name: 'Add' })).toBeInTheDocument();

      const slack = await openPopover('Slack');
      expect(slack.textContent).toContain('one click in your workspace');

      expect(screen.queryByText(/Tell us which channel/)).toBeNull();
    });

    it('does not list a provider this instance does not offer (D215)', async () => {
      // Discord on commonly.me: usable keys, no builtin Installable row, never
      // walked. A stranger must not see it, not even behind "+N off".
      mockCatalog([
        entry(),
        entry({ installableId: 'discord', label: 'Discord', available: true, offered: false }),
      ]);
      renderPage();

      await findTile('Telegram');
      // The off button only exists when a dead tile does, so its absence is the
      // assertion; a collapsed group would hide a listed Discord from the query.
      expect(screen.queryByRole('button', { name: /^\+\d+ off$/ })).toBeNull();
      expect(tileNode('Discord')).toBeNull();
    });

    it('keeps an installed but no-longer-offered provider as not connectable, with no Add anywhere', async () => {
      // The ruled middle state, reachable only by someone who installed it before
      // the roster row went away: it states the state and offers no action. Before
      // #1826 the row rendered an Add whose click ended in 404 installable_not_found.
      mockCatalog([
        entry({ installableId: 'discord', label: 'Discord', available: true, offered: false, installation: { status: 'active', boundPodId: 'p1' } }),
      ]);
      renderPage();

      await pageReady();
      await expandOff('Channels');
      const tile = await findTile('Discord');
      expect(tile).toHaveClass('v2-cx-tile--dim');
      expect(tile.querySelector('svg')).not.toBeNull();
      fireEvent.click(tile);
      const drawer = await findDrawer('Discord');
      expect(within(drawer).getByText('Unavailable here.')).toBeInTheDocument();
      // No Add and no connect verb: an offered provider is the only thing that may
      // produce them, and there is none in this catalog.
      expect(within(drawer).queryByRole('button', { name: /^(Add|Connect|Retry)$/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
      expect(tileNode('Channel')).toBeNull();
      expect(screen.queryByText(/Tell us which channel/)).toBeNull();
    });

    it('keeps a no-longer-offered provider listed when the person has only an integration row', async () => {
      // The third arm of the D215 filter: a channel connected before the roster row
      // went away can leave an integration with no installation. Dropping it from
      // the list would hide a live connection from its owner.
      mockCatalog([
        entry({ installableId: 'discord', label: 'Discord', available: true, offered: false, integration: liveIntegration() }),
      ]);
      renderPage();

      await pageReady();
      await expandOff('Channels');
      expect(await findTile('Discord')).toHaveClass('v2-cx-tile--dim');
    });

    it('renders an unavailable provider with its blocker and an available one with Add', async () => {
      mockCatalog([
        entry(),
        entry({ installableId: 'slack', label: 'Slack', available: false, unavailableReason: 'not_configured' }),
      ]);
      axios.post.mockResolvedValue({ data: { status: 'installing' } });
      renderPage();

      await pageReady();
      await expandOff('Channels');
      const slack = await openPopover('Slack');
      // Each unconnectable provider gets its own state line; an offered provider is
      // the only thing that may draw Add.
      expect(within(slack).getByText('ask your operator')).toBeInTheDocument();
      expect(within(slack).getByText('Link your Telegram chat to Commonly — every pod you turn on reaches it.')).toBeInTheDocument();
      expect(screen.queryByText('not_configured')).toBeNull();
      const ask = within(slack).getByRole('link', { name: 'Ask' });
      expect(ask).toHaveAttribute('href', 'https://github.com/Team-Commonly/commonly/issues/new?title=Connector%20request');
      expect(ask).toHaveClass('v2-connector-row__action--secondary');
      expect(within(slack).queryByRole('button', { name: 'Add' })).toBeNull();

      const telegram = await openPopover('Telegram');
      const choosePod = within(telegram).getAllByRole('button', { name: 'Add' });
      expect(choosePod).toHaveLength(1);
      fireEvent.click(choosePod[0]);
      const form = await findDrawer('Connect a channel');
      expect(within(form).getByRole('button', { name: 'Telegram' })).toHaveClass('v2-connectors__provider--selected');
      expect(within(form).queryByRole('button', { name: 'Slack' })).toBeNull();
      fireEvent.click(form.querySelector('.v2-connectors__create'));
      await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
        '/api/installables/telegram/install',
        { podId: 'p1' },
        expect.anything(),
      ));
    });

    it('labels the popover step separately from the final connect action', async () => {
      mockCatalog([entry()]);
      renderPage();

      const popover = await openPopover('Telegram');
      const choosePod = within(popover).getByRole('button', { name: 'Add' });
      expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();

      fireEvent.click(choosePod);
      const form = await findDrawer('Connect a channel');
      expect(within(form).getByLabelText('Pod to bridge')).toBeInTheDocument();
      expect(within(form).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    });

    it('gives a zero-pod owner a path to create a pod before connecting', async () => {
      mockCatalog([entry()], [], []);
      renderWithRoutes(
        <Routes>
          <Route path="/v2/connectors" element={<ConnectorsPageForRoutes />} />
          <Route path="/v2" element={<div>pods list</div>} />
        </Routes>,
      );

      fireEvent.click(await findTile('Channel'));
      const drawer = await findDrawer('Connect a channel');
      expect(within(drawer).queryByLabelText('Pod to bridge')).toBeNull();
      expect(within(drawer).queryByRole('group', { name: 'Channel provider' })).toBeNull();
      expect(within(drawer).getByText('No pod yet. Create one, then come back to connect a channel.')).toBeInTheDocument();
      expect(screen.queryByText('Choose a channel and the pod it should join.')).toBeNull();
      fireEvent.click(within(drawer).getByRole('button', { name: 'Create a pod' }));
      expect(await screen.findByText('pods list')).toBeInTheDocument();
    });

    it('keeps the existing picker visible while pod membership is still loading', async () => {
      mockCatalog([entry()], [], 'pending');
      renderPage();

      fireEvent.click(await findTile('Channel'));
      const drawer = await findDrawer('Connect a channel');
      expect(within(drawer).getByRole('group', { name: 'Channel provider' })).toBeInTheDocument();
      expect(within(drawer).getByLabelText('Pod to bridge')).toBeInTheDocument();
      expect(within(drawer).queryByText('No pod yet. Create one, then come back to connect a channel.')).toBeNull();
      expect(within(drawer).queryByRole('button', { name: 'Create a pod' })).toBeNull();
    });

    it('keeps the existing picker visible when pod membership cannot be read', async () => {
      mockCatalog([entry()], [], new Error('pods unavailable'));
      renderPage();

      fireEvent.click(await findTile('Channel'));
      const drawer = await findDrawer('Connect a channel');
      expect(within(drawer).getByRole('group', { name: 'Channel provider' })).toBeInTheDocument();
      expect(within(drawer).getByLabelText('Pod to bridge')).toBeInTheDocument();
      expect(within(drawer).queryByText('No pod yet. Create one, then come back to connect a channel.')).toBeNull();
      expect(within(drawer).queryByRole('button', { name: 'Create a pod' })).toBeNull();
    });

    it('shows Setting up… without a control while the claim is fresh, and Cancel once it is stale', async () => {
      mockCatalog([entry({ installation: { status: 'installing', claimedAt: new Date().toISOString(), components: [] } })]);
      const fresh = renderPage();
      let drawer = await openDrawer('Telegram');
      expect(within(drawer).getByText('Setting up…')).toBeInTheDocument();
      expect(within(drawer).queryByRole('button', { name: 'Cancel' })).toBeNull();
      fresh.unmount();

      mockCatalog([entry({
        installation: { status: 'installing', claimedAt: new Date(Date.now() - INSTALL_LOCK_TTL_MS - 1000).toISOString(), components: [] },
      })]);
      axios.delete.mockResolvedValue({ data: { status: 'uninstalling' } });
      renderPage();
      drawer = await openDrawer('Telegram');
      expect(within(drawer).getByText('Setup is taking longer than it should.')).toBeInTheDocument();
      fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/installables/telegram/install', expect.anything()));
    });

    it('offers Retry on an error parent, posting the bound pod, and Remove in the drawer', async () => {
      mockCatalog([entry({
        // The reconciler's own reason, and since TASK-131 it travels with the flag
        // that says so: the line renders a message only when a writer declared it
        // was written for a person.
        installation: {
          status: 'error',
          errorMessage: REASON_CHANNEL_GONE,
          errorMessageUserFacing: true,
          boundPodId: 'p2',
          updatedAt: new Date().toISOString(),
          components: [],
        },
      })]);
      axios.post.mockResolvedValue({ data: { status: 'installing' } });
      axios.delete.mockResolvedValue({ data: { status: 'uninstalled' } });
      renderPage();

      const drawer = await openDrawer('Telegram');
      expect(within(drawer).getByText(REASON_CHANNEL_GONE)).toBeInTheDocument();
      fireEvent.click(within(drawer).getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
        '/api/installables/telegram/install',
        { podId: 'p2' },
        expect.anything(),
      ));
      fireEvent.click(within(drawer).getByRole('button', { name: 'Remove' }));
      fireEvent.click(within(drawer).getByRole('button', { name: /Really remove/ }));
      await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/installables/telegram/install', expect.anything()));
    });

    it('offers Retry remove once an uninstalling claim is stale', async () => {
      mockCatalog([entry({
        installation: { status: 'uninstalling', claimedAt: new Date(Date.now() - INSTALL_LOCK_TTL_MS - 1000).toISOString(), components: [] },
      })]);
      axios.delete.mockResolvedValue({ data: { status: 'uninstalling' } });
      renderPage();

      const drawer = await openDrawer('Telegram');
      expect(within(drawer).getByText('Removal is taking longer than it should.')).toBeInTheDocument();
      fireEvent.click(within(drawer).getByRole('button', { name: 'Retry remove' }));
      await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/installables/telegram/install', expect.anything()));
    });

    it('shows a paused parent with its reason and no owner control', async () => {
      mockCatalog([slackEntry({
        installation: { status: 'paused', updatedAt: new Date().toISOString(), components: [] },
        integration: liveIntegration({ config: { chatTitle: 'Rewire crew', liveRelay: true, adminPause: { reason: 'Spam report under review.', at: new Date(Date.now() - 120_000).toISOString() } } }),
      })]);
      renderPage();

      const drawer = await openDrawer('Slack');
      expect(within(drawer).getByText('Paused by an administrator. Spam report under review.')).toBeInTheDocument();
      expect(within(drawer).getByText('Only an administrator can resume it. Your relay, mode and pods are kept.')).toBeInTheDocument();
      expect(within(drawer).queryByRole('button', { name: 'Remove' })).toBeNull();
      expect(within(drawer).queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(within(drawer).queryByRole('checkbox', { name: 'Relay' })).toBeNull();
    });

    it('treats a missing projection under an active parent as a Retry state', async () => {
      mockCatalog([entry({ installation: { status: 'active', updatedAt: new Date().toISOString(), components: [] }, integration: null })]);
      axios.post.mockResolvedValue({ data: { status: 'installing' } });
      renderPage();

      const drawer = await openDrawer('Telegram');
      expect(within(drawer).getByText('The channel record is gone.')).toBeInTheDocument();
      expect(within(drawer).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('renders the not-linked channel with its pod list open and Make active', async () => {
      mockCatalog([slackEntry({
        integration: liveIntegration({ podId: null, config: { chatTitle: 'Rewire crew', liveRelay: true, gates: {} } }),
      })]);
      axios.patch.mockResolvedValue({ data: {} });
      renderPage();

      await findTile('Slack');
      expect(dot('Rewire crew · not linked to a pod')).toBeInTheDocument();
      const drawer = await openDrawer('Slack');
      // An unlinked channel has no active pod, so the list opens already expanded.
      expect(within(drawer).getByText('Pick where your messages go')).toBeInTheDocument();
      expect(within(drawer).queryByText('active')).toBeNull();
      const makeActive = within(drawer).getAllByRole('button', { name: 'Make active' });
      expect(makeActive).toHaveLength(2);
      fireEvent.click(makeActive[1]);
      await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
        '/api/integrations/i-live',
        { podId: 'p2' },
        expect.anything(),
      ));
    });

    // TASK-164: the gate line was the last raw English relative time on this page —
    // `since ${relativeTime(...)}` built its own sentence and no key could reach it.
    it('the gate line reads in zh-CN, not English (TASK-164)', async () => {
      mockCatalog([slackEntry()]);
      await i18nReady;
      await act(async () => { await i18n.changeLanguage('zh-CN'); });
      try {
        renderPage();
        await openDrawer('Slack');
        const line = await screen.findByText(/前起$/);
        expect(line.textContent).toMatch(/^(刚刚|\d+(分钟|小时|天)前)起$/);
        expect(screen.queryByText(/^since /)).toBeNull();
      } finally {
        await act(async () => { await i18n.changeLanguage('en'); });
      }
    });

    it('lists every pod with its gate, marks the active pod, and writes the whole gates map on a switch', async () => {
      mockCatalog([slackEntry()]);
      axios.patch.mockResolvedValue({ data: {} });
      renderPage();

      await findTile('Slack');
      expect(dot('Rewire crew · linked to Rewire Live Demo')).toBeInTheDocument();
      const drawer = await openDrawer('Slack');
      expect(within(drawer).getByText('Pods that reach this channel')).toBeInTheDocument();
      // The anchors, measured rather than assumed: the panel that holds that
      // section is reachable by its ACCESSIBLE NAME and never as text. A copy that
      // names it sends a sighted user hunting, which is the defect TASK-173 was
      // opened for.
      expect(within(drawer).getByLabelText('Channel details')).toBeInTheDocument();
      expect(screen.queryAllByText(/^Channel details$/)).toHaveLength(0);
      expect(within(drawer).getByText('active')).toBeInTheDocument();
      expect(within(drawer).getByText('off')).toBeInTheDocument();
      expect(within(drawer).getByText(/^since /)).toBeInTheDocument();
      fireEvent.click(within(drawer).getByRole('switch', { name: 'Relay Ops' }));
      await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
        '/api/integrations/i-live',
        { config: { gates: {
          p1: { enabled: true, since: '2026-09-01T00:00:00.000Z' },
          p2: { enabled: true, since: expect.any(String) },
        } } },
        expect.anything(),
      ));
    });

    it('drops a gate for a pod the owner has left before writing the map', async () => {
      mockCatalog([slackEntry({
        integration: liveIntegration({
          config: { chatTitle: 'Rewire crew', liveRelay: true, gates: {
            p1: { enabled: true, since: '2026-09-01T00:00:00.000Z' },
            pLeft: { enabled: true, since: '2026-08-01T00:00:00.000Z' },
          } },
        }),
      })]);
      axios.patch.mockResolvedValue({ data: {} });
      renderPage();

      const drawer = await openDrawer('Slack');
      fireEvent.click(within(drawer).getByRole('switch', { name: 'Relay Ops' }));
      await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
        '/api/integrations/i-live',
        { config: { gates: {
          p1: { enabled: true, since: '2026-09-01T00:00:00.000Z' },
          p2: { enabled: true, since: expect.any(String) },
        } } },
        expect.anything(),
      ));
    });

    it('keeps mode and lead overrides behind the pod name and makes another pod active', async () => {
      mockCatalog([slackEntry()]);
      axios.patch.mockResolvedValue({ data: {} });
      renderPage();

      const drawer = await openDrawer('Slack');
      expect(within(drawer).queryByRole('button', { name: 'Make active' })).toBeNull();
      fireEvent.click(within(drawer).getByRole('button', { name: /Ops/ }));
      const more = within(drawer.querySelector('.v2-connector-gate__more'));
      fireEvent.click(more.getByRole('button', { name: 'Mirror' }));
      await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
        '/api/integrations/i-live',
        { config: { gates: {
          p1: { enabled: true, since: '2026-09-01T00:00:00.000Z' },
          p2: { enabled: false, mode: 'mirror', since: expect.any(String) },
        } } },
        expect.anything(),
      ));
      const makeActive = within(drawer).getByRole('button', { name: 'Make active' });
      await waitFor(() => expect(makeActive).not.toBeDisabled());
      fireEvent.click(makeActive);
      await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
        '/api/integrations/i-live',
        { podId: 'p2' },
        expect.anything(),
      ));
    });

    it('keys an installable tile by the catalog, not by its legacy listing', async () => {
      mockCatalog([slackEntry()], [{ ...connectors[1] }]);
      renderPage();

      await findTile('Slack');
      expect(document.querySelectorAll('button.v2-cx-tile[title="Slack"]')).toHaveLength(1);
    });
  });
});

// The zero-pod case needs a route table around the page.
// eslint-disable-next-line react/display-name
const ConnectorsPageForRoutes = () => {
  // eslint-disable-next-line global-require
  const Page = require('../connectors/ConnectorsPage').default;
  return <Page />;
};
