// @ts-nocheck
// Signal Connectors page: rows preserve the Phase 1 verbs while the selected
// channel owns code, confirmation, relay controls, and disconnect in its aside.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2ConnectorsPage, { INSTALL_LOCK_TTL_MS, installableLifecyclePath } from '../components/V2ConnectorsPage';
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

const connectors = [
  {
    _id: 'i-pending',
    installationId: 'install-telegram-u1',
    type: 'telegram',
    status: 'pending',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    config: { connectCode: 'abc123', connectCodeExpiresAt: new Date(Date.now() + 60_000).toISOString() },
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

const mockGets = (list = connectors) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/integrations/user/all') return Promise.resolve({ data: list });
    if (url === '/api/pods') {
      return Promise.resolve({
        data: [
          { _id: 'p1', name: 'Rewire Live Demo', type: 'chat' },
          { _id: 'pub', name: 'Town Square', type: 'community' },
        ],
      });
    }
    return Promise.resolve({ data: [] });
  });
};

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2ConnectorsPage />
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('V2ConnectorsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(window, 'open').mockReturnValue(null);
    window.history.replaceState({}, '', '/v2/connectors');
  });

  afterEach(() => jest.restoreAllMocks());

  it('renders the Signal row list and opens the pending channel in the selected aside', async () => {
    mockGets();
    const { container } = renderPage();

    await screen.findByRole('button', { name: 'View Telegram' });
    expect(screen.getByText('Waiting for one message in your Telegram chat.')).toBeInTheDocument();
    expect(screen.getByText('Rewire crew · linked to Ops')).toBeInTheDocument();
    expect(screen.getByText('Discord · WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('/commonly-enable abc1 23')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(container.querySelectorAll('.v2-connector-row__glyph')).toHaveLength(3);
  });

  it('offers a new code from the row and aside when the Telegram code has expired', async () => {
    mockGets([{ ...connectors[0], config: { connectCode: 'abc123' } }]);
    axios.post.mockResolvedValue({ data: {} });
    renderPage();

    expect((await screen.findAllByText('The enable code expired.')).length).toBeGreaterThan(0);
    expect(screen.queryByText('/commonly-enable abc1 23')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'New code' })[0]);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/integrations/i-pending/connect-code',
      {},
      expect.anything(),
    ));
  });

  it('selects a connected channel and keeps relay and mode PATCHes in its aside', async () => {
    mockGets();
    axios.patch.mockResolvedValue({ data: {} });
    renderPage();

    fireEvent.click((await screen.findAllByRole('button', { name: 'View Slack' }))[0]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Relay' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
      '/api/integrations/i-live',
      { config: { liveRelay: true } },
      expect.anything(),
    ));
  });

  it('PATCHes the mirror mode from the selected channel aside', async () => {
    mockGets([{
      ...connectors[1],
      config: { chatTitle: 'Rewire crew', liveRelay: true, relayAllAgentMessages: false },
    }]);
    axios.patch.mockResolvedValue({ data: {} });
    renderPage();

    await screen.findByRole('button', { name: 'Attention' });
    fireEvent.click(screen.getByRole('button', { name: 'Mirror' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
      '/api/integrations/i-live',
      { config: { relayAllAgentMessages: true } },
      expect.anything(),
    ));
  });

  it('uses the inline provider and pod form with every pod the user is in', async () => {
    mockGets([]);
    axios.post.mockResolvedValue({ data: { integration: { _id: 'new' } } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a channel' }));
    const picker = screen.getByLabelText('Pod to bridge');
    const options = Array.from(picker.querySelectorAll('option')).map((option) => option.textContent);
    expect(options).toContain('Rewire Live Demo');
    expect(options).toContain('Town Square');
    expect(picker.closest('.v2-connectors__aside')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/telegram/install',
      { podId: 'p1' },
      expect.anything(),
    ));
  });

  it('selects Slack in the inline provider form and installs through its lifecycle verb', async () => {
    mockGets([]);
    axios.post.mockResolvedValue({ data: { integration: { _id: 'slack-new' } } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a channel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Slack' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/install',
      { podId: 'p1' },
      expect.anything(),
    ));
  });

  it('keeps the form open while an install claim is still in progress', async () => {
    mockGets([]);
    axios.post.mockResolvedValue({ data: { status: 'installing' } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a channel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Still setting up — try again in a moment.')).toBeInTheDocument();
    expect(screen.getByLabelText('Pod to bridge')).toBeInTheDocument();
  });

  it('names the pending pod returned with an install response', async () => {
    mockGets([]);
    axios.post.mockResolvedValue({ data: { status: 'installing', boundPodId: 'p1' } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a channel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Still setting up for Rewire Live Demo — try again in a moment.')).toBeInTheDocument();
    expect(screen.getByLabelText('Pod to bridge')).toBeInTheDocument();
  });

  it('keeps the form open when the server reports an install lock', async () => {
    mockGets([]);
    axios.post.mockRejectedValue({ response: { status: 409, data: { code: 'install_in_progress', boundPodId: 'p1' } } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a channel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Still setting up for Rewire Live Demo — try again in a moment.')).toBeInTheDocument();
    expect(screen.getByLabelText('Pod to bridge')).toBeInTheDocument();
  });

  it('keeps the form open when an install lock does not name its pod', async () => {
    mockGets([]);
    axios.post.mockRejectedValue({ response: { status: 409, data: { code: 'install_in_progress' } } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a channel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Still setting up — try again in a moment.')).toBeInTheDocument();
    expect(screen.getByLabelText('Pod to bridge')).toBeInTheDocument();
  });

  it('names the existing pod when the installable is already bound elsewhere', async () => {
    mockGets([]);
    axios.post.mockRejectedValue({ response: { status: 409, data: { code: 'already_installed', boundPodId: 'p1' } } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a channel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/bound to Rewire Live Demo/)).toBeInTheDocument();
    expect(screen.getByLabelText('Pod to bridge')).toBeInTheDocument();
  });

  it('disconnects installable and legacy rows through their respective verbs', async () => {
    mockGets([connectors[1]]);
    axios.delete.mockResolvedValue({ data: { status: 'uninstalled' } });
    const firstRender = renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: /Really remove/ }));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith(
      '/api/installables/slack/install',
      expect.anything(),
    ));

    firstRender.unmount();
    mockGets([{ ...connectors[1], installationId: undefined }]);
    axios.patch.mockResolvedValue({ data: {} });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: /Really remove/ }));
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

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: /Really remove/ }));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith(
      '/api/installables/telegram/install',
      expect.anything(),
    ));
  });

  it('removes the retired SOON tiles and keeps unavailable providers in the Not yet row', async () => {
    mockGets([]);
    renderPage();

    expect(await screen.findByText(/Not yet\. Tell us which channel/)).toBeInTheDocument();
    expect(screen.queryByText('SOON')).toBeNull();
  });

  it('does not offer another install control once both supported providers are present', async () => {
    mockGets();
    renderPage();

    await screen.findByRole('button', { name: 'View Telegram' });
    expect(screen.queryByRole('button', { name: 'Connect a channel' })).toBeNull();
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

    fireEvent.click((await screen.findAllByRole('button', { name: 'Authorize in Slack' }))[0]);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/authorize-url',
      {},
      expect.objectContaining({ withCredentials: true }),
    ));
    expect(slackWindow.location.assign).toHaveBeenCalledWith('https://slack.test/oauth?state=secret');
    expect(slackWindow.opener).toBeNull();
  });

  it('keeps a Slack authorization failure generic in the selected aside', async () => {
    mockGets([{
      _id: 'i-slack-authorize', installationId: 'install-slack-u1', type: 'slack', status: 'pending',
      config: {}, podId: { _id: 'p1', name: 'Rewire Live Demo' },
    }]);
    axios.post.mockRejectedValue({ response: { status: 503 } });
    renderPage();

    fireEvent.click((await screen.findAllByRole('button', { name: 'Authorize in Slack' }))[0]);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/authorize-url',
      {},
      expect.objectContaining({ withCredentials: true }),
    ));
    expect(await screen.findByText('Could not begin Slack authorization. Try again in a moment.')).toBeInTheDocument();
  });

  it('moves Slack confirmation and rejection to the selected aside', async () => {
    mockGets([{
      _id: 'i-slack-pending', installationId: 'install-slack-u1', type: 'slack', status: 'pending',
      config: { pendingBind: { teamName: 'Commonly HQ', slackUserName: 'sam' } },
      podId: { _id: 'p1', name: 'Rewire Live Demo' },
    }]);
    axios.post.mockResolvedValue({ data: { status: 'connected' } });
    renderPage();

    expect(await screen.findByText('Commonly HQ wants to connect as @sam.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm connection' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/confirm',
      {},
      expect.anything(),
    ));
  });

  it('keeps rejection reachable from the selected Slack aside', async () => {
    mockGets([{
      _id: 'i-slack-pending', installationId: 'install-slack-u1', type: 'slack', status: 'pending',
      config: { pendingBind: { teamName: 'Commonly HQ', slackUserName: 'sam' } },
      podId: { _id: 'p1', name: 'Rewire Live Demo' },
    }]);
    axios.post.mockResolvedValue({ data: { status: 'rejected' } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'This is not me' }));
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

  it('reloads connectors after a successful Slack callback and clears its query', async () => {
    window.history.replaceState({}, '', '/v2/connectors?slack=pending');
    mockGets([]);
    renderPage();

    await waitFor(() => expect(
      axios.get.mock.calls.filter(([url]) => url === '/api/integrations/user/all').length,
    ).toBeGreaterThanOrEqual(2));
    expect(window.location.search).toBe('');
  });

  it('shows the error reconnect action and retains the separate removal action', async () => {
    mockGets([{
      _id: 'i-slack-error', installationId: 'install-slack-u1', type: 'slack', status: 'error',
      config: { chatTitle: 'Commonly HQ', liveRelay: true },
      podId: { _id: 'p1', name: 'Rewire Live Demo' },
    }]);
    axios.post.mockRejectedValue({ response: { status: 503 } });
    renderPage();

    expect((await screen.findAllByText('The connection dropped.')).length).toBeGreaterThan(0);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Authorize in Slack' }))[0]);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/slack/authorize-url',
      {},
      expect.objectContaining({ withCredentials: true }),
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: /Really remove/ })).toBeInTheDocument();
  });

  it('derives the installable lifecycle target from the connector row type', () => {
    expect(installableLifecyclePath('slack')).toBe('/api/installables/slack/install');
  });
  // D8 Phase 2: rows keyed by the capability catalog (D1/D2), the aside's
  // gate list (D4), and the not-linked row (#1551).
  describe('catalog rows', () => {
    const entry = (over = {}) => ({
      installableId: 'telegram',
      label: 'Telegram',
      description: 'One Telegram chat, one pod.',
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
    const mockCatalog = (installables, list = []) => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/integrations/user/all') return Promise.resolve({ data: list });
        if (url === '/api/installables') return Promise.resolve({ data: { installables } });
        if (url === '/api/pods') {
          return Promise.resolve({
            data: [
              { _id: 'p1', name: 'Rewire Live Demo', type: 'chat', members: [{ _id: 'b1', username: 'vale', isBot: true }] },
              { _id: 'p2', name: 'Ops', type: 'team', members: [] },
            ],
          });
        }
        return Promise.resolve({ data: [] });
      });
    };

    it('renders an unavailable provider without a control and an available one with Connect', async () => {
      mockCatalog([
        entry(),
        entry({ installableId: 'slack', label: 'Slack', available: false, unavailableReason: 'not_configured' }),
      ]);
      axios.post.mockResolvedValue({ data: { status: 'installing' } });
      renderPage();

      expect(await screen.findByText('Not enabled on this instance.')).toBeInTheDocument();
      expect(screen.getByText('ask your operator')).toBeInTheDocument();
      expect(screen.getByText('One Telegram chat, one pod.')).toBeInTheDocument();
      expect(screen.getByText('not connected')).toBeInTheDocument();
      expect(screen.queryByText('not_configured')).toBeNull();
      const connects = screen.getAllByRole('button', { name: 'Connect' });
      expect(connects).toHaveLength(1);
      fireEvent.click(connects[0]);
      expect(screen.getByRole('button', { name: 'Telegram' })).toHaveClass('v2-connectors__provider--selected');
      expect(screen.queryByRole('button', { name: 'Slack' })).toBeNull();
      fireEvent.click(document.querySelector('.v2-connectors__create'));
      await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
        '/api/installables/telegram/install',
        { podId: 'p1' },
        expect.anything(),
      ));
    });

    it('shows Setting up… without a control while the claim is fresh, and Cancel once it is stale', async () => {
      mockCatalog([entry({ installation: { status: 'installing', claimedAt: new Date().toISOString(), components: [] } })]);
      const fresh = renderPage();
      expect(await screen.findByText('Setting up…')).toBeInTheDocument();
      expect(screen.getByText('waiting for the server')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      fresh.unmount();

      mockCatalog([entry({
        installation: { status: 'installing', claimedAt: new Date(Date.now() - INSTALL_LOCK_TTL_MS - 1000).toISOString(), components: [] },
      })]);
      axios.delete.mockResolvedValue({ data: { status: 'uninstalling' } });
      renderPage();
      expect(await screen.findByText('Setup is taking longer than it should.')).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
      await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/installables/telegram/install', expect.anything()));
    });

    it('offers Retry on an error parent, posting the bound pod, and Remove in the aside', async () => {
      mockCatalog([entry({
        installation: { status: 'error', errorMessage: 'projection missing', boundPodId: 'p2', updatedAt: new Date().toISOString(), components: [] },
      })]);
      axios.post.mockResolvedValue({ data: { status: 'installing' } });
      axios.delete.mockResolvedValue({ data: { status: 'uninstalled' } });
      renderPage();

      expect((await screen.findAllByText('projection missing')).length).toBeGreaterThan(0);
      expect(screen.getByText('retry, or remove it')).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
      await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
        '/api/installables/telegram/install',
        { podId: 'p2' },
        expect.anything(),
      ));
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      fireEvent.click(screen.getByRole('button', { name: /Really remove/ }));
      await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/installables/telegram/install', expect.anything()));
    });

    it('offers Retry remove once an uninstalling claim is stale', async () => {
      mockCatalog([entry({
        installation: { status: 'uninstalling', claimedAt: new Date(Date.now() - INSTALL_LOCK_TTL_MS - 1000).toISOString(), components: [] },
      })]);
      axios.delete.mockResolvedValue({ data: { status: 'uninstalling' } });
      renderPage();

      expect(await screen.findByText('Removal is taking longer than it should.')).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: 'Retry remove' })[0]);
      await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/installables/telegram/install', expect.anything()));
    });

    it('shows a paused parent with its reason and no owner control', async () => {
      mockCatalog([entry({
        installableId: 'slack',
        label: 'Slack',
        installation: { status: 'paused', updatedAt: new Date().toISOString(), components: [] },
        integration: liveIntegration({ config: { chatTitle: 'Rewire crew', liveRelay: true, adminPause: { reason: 'Spam report under review.', at: new Date(Date.now() - 120_000).toISOString() } } }),
      })]);
      renderPage();

      expect((await screen.findAllByText('Paused by an administrator. Spam report under review.')).length).toBeGreaterThan(0);
      expect(screen.getByText('paused 2m ago')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(screen.queryByRole('checkbox', { name: 'Relay' })).toBeNull();
    });

    it('treats a missing projection under an active parent as a Retry row', async () => {
      mockCatalog([entry({ installation: { status: 'active', updatedAt: new Date().toISOString(), components: [] }, integration: null })]);
      axios.post.mockResolvedValue({ data: { status: 'installing' } });
      renderPage();

      expect((await screen.findAllByText('The channel record is gone.')).length).toBeGreaterThan(0);
      expect(screen.getByText('retry rebuilds it')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
    });

    it('renders the not-linked row and expands the pod list with Make active', async () => {
      mockCatalog([entry({
        installableId: 'slack',
        label: 'Slack',
        installation: { status: 'active', updatedAt: new Date().toISOString(), components: [] },
        integration: liveIntegration({ podId: null, config: { chatTitle: 'Rewire crew', liveRelay: true, gates: {} } }),
      })]);
      axios.patch.mockResolvedValue({ data: {} });
      renderPage();

      expect(await screen.findByText('Rewire crew · not linked to a pod')).toBeInTheDocument();
      expect(screen.getByText('your messages have nowhere to go')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Pick a pod' }));
      expect(screen.getByText('Pick where your messages go')).toBeInTheDocument();
      expect(screen.queryByText('active')).toBeNull();
      const makeActive = screen.getAllByRole('button', { name: 'Make active' });
      expect(makeActive).toHaveLength(2);
      fireEvent.click(makeActive[1]);
      await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
        '/api/integrations/i-live',
        { podId: 'p2' },
        expect.anything(),
      ));
    });

    it('lists every pod with its gate, marks the active pod, and writes the whole gates map on a switch', async () => {
      mockCatalog([entry({
        installableId: 'slack',
        label: 'Slack',
        installation: { status: 'active', updatedAt: new Date().toISOString(), components: [] },
        integration: liveIntegration(),
      })]);
      axios.patch.mockResolvedValue({ data: {} });
      renderPage();

      expect(await screen.findByText('Rewire crew · linked to Rewire Live Demo')).toBeInTheDocument();
      expect(screen.getByText('Pods that reach this channel')).toBeInTheDocument();
      expect(screen.getByText('active')).toBeInTheDocument();
      expect(screen.getByText('off')).toBeInTheDocument();
      expect(screen.getByText(/^since /)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('switch', { name: 'Relay Ops' }));
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
      mockCatalog([entry({
        installableId: 'slack',
        label: 'Slack',
        installation: { status: 'active', updatedAt: new Date().toISOString(), components: [] },
        integration: liveIntegration(),
      })]);
      axios.patch.mockResolvedValue({ data: {} });
      renderPage();

      await screen.findByText('Pods that reach this channel');
      expect(screen.queryByRole('button', { name: 'Make active' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Ops/ }));
      const more = within(document.querySelector('.v2-connector-gate__more'));
      fireEvent.click(more.getByRole('button', { name: 'Mirror' }));
      await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
        '/api/integrations/i-live',
        { config: { gates: {
          p1: { enabled: true, since: '2026-09-01T00:00:00.000Z' },
          p2: { enabled: false, mode: 'mirror', since: expect.any(String) },
        } } },
        expect.anything(),
      ));
      const makeActive = screen.getByRole('button', { name: 'Make active' });
      await waitFor(() => expect(makeActive).not.toBeDisabled());
      fireEvent.click(makeActive);
      await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
        '/api/integrations/i-live',
        { podId: 'p2' },
        expect.anything(),
      ));
    });

    it('keys an installable row by the catalog, not by its legacy listing', async () => {
      mockCatalog(
        [entry({
          installableId: 'slack',
          label: 'Slack',
          installation: { status: 'active', updatedAt: new Date().toISOString(), components: [] },
          integration: liveIntegration(),
        })],
        [{ ...connectors[1] }],
      );
      renderPage();

      expect(await screen.findAllByRole('button', { name: 'View Slack' })).toHaveLength(1);
    });
  });
});
