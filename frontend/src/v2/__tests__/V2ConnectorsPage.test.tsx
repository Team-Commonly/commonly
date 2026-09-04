// @ts-nocheck
// Signal Connectors page: rows preserve the Phase 1 verbs while the selected
// channel owns code, confirmation, relay controls, and disconnect in its aside.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2ConnectorsPage, { installableLifecyclePath } from '../components/V2ConnectorsPage';
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
    renderPage();

    await screen.findByRole('button', { name: 'View Telegram' });
    expect(screen.getByText('Waiting for one message in your Telegram chat.')).toBeInTheDocument();
    expect(screen.getByText('Rewire crew · linked to Ops')).toBeInTheDocument();
    expect(screen.getByText('Discord · WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('/commonly-enable abc1 23')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
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

  it('uses the inline provider and pod form, excluding public pods', async () => {
    mockGets([]);
    axios.post.mockResolvedValue({ data: { integration: { _id: 'new' } } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect a channel' }));
    const picker = screen.getByLabelText('Pod to bridge');
    const options = Array.from(picker.querySelectorAll('option')).map((option) => option.textContent);
    expect(options).toContain('Rewire Live Demo');
    expect(options).not.toContain('Town Square');
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

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: /Really disconnect/ }));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith(
      '/api/installables/slack/install',
      expect.anything(),
    ));

    firstRender.unmount();
    mockGets([{ ...connectors[1], installationId: undefined }]);
    axios.patch.mockResolvedValue({ data: {} });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: /Really disconnect/ }));
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

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: /Really disconnect/ }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(screen.getByRole('button', { name: /Really disconnect/ })).toBeInTheDocument();
  });

  it('derives the installable lifecycle target from the connector row type', () => {
    expect(installableLifecyclePath('slack')).toBe('/api/installables/slack/install');
  });
});
