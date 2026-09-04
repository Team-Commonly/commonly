// @ts-nocheck
// Connectors page (Wren spec rev 5 subset): platform cards with dot-status,
// grouped enable code + copy-command, add-flow tiles with an open-relay pod
// guard, and the relay controls — liveRelay toggle plus the mirror/attention
// segment. linkedUserId stays server-derived (never sent by the client).
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    type: 'telegram',
    status: 'pending',
    config: { connectCode: 'abc123', connectCodeExpiresAt: new Date(Date.now() + 60_000).toISOString() },
    podId: { _id: 'p1', name: 'Rewire Live Demo' },
  },
  {
    _id: 'i-live',
    installationId: 'install-telegram-u1',
    type: 'telegram',
    status: 'connected',
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
  beforeEach(() => jest.clearAllMocks());

  it('lists connectors with grouped code, copy command, and dot status', async () => {
    mockGets();
    renderPage();
    expect((await screen.findAllByText('Rewire Live Demo')).length).toBeGreaterThanOrEqual(1);
    // Code renders grouped in 4s (spec §2.3) under a copy-command primary.
    expect(screen.getByText('abc1 23')).toBeInTheDocument();
    expect(screen.getByText('Copy command')).toBeInTheDocument();
    expect(screen.getByText(/Connected · Relay off/)).toBeInTheDocument();
    expect(screen.getByText(/Rewire crew/)).toBeInTheDocument();
  });

  it('offers a new code when the enable code has expired (or never had an expiry)', async () => {
    mockGets([{ ...connectors[0], config: { connectCode: 'abc123' } }]);
    axios.post.mockResolvedValue({ data: {} });
    renderPage();
    expect(await screen.findByText(/code expired/i)).toBeInTheDocument();
    expect(screen.queryByText('abc1 23')).not.toBeInTheDocument();
    expect(screen.queryByText('Copy command')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /new code/i }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/integrations/i-pending/connect-code',
      {},
      expect.anything(),
    ));
  });

  it('toggling relay PATCHes liveRelay only — linkedUserId is server-derived', async () => {
    mockGets();
    axios.patch.mockResolvedValue({ data: {} });
    renderPage();
    const toggle = await screen.findByRole('checkbox');
    fireEvent.click(toggle);
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
      '/api/integrations/i-live',
      { config: { liveRelay: true } },
      expect.anything(),
    ));
  });

  it('mirror/attention segment PATCHes relayAllAgentMessages', async () => {
    mockGets([
      {
        _id: 'i-live',
        type: 'telegram',
        status: 'connected',
        config: { chatTitle: 'Rewire crew', liveRelay: true, relayAllAgentMessages: false },
        podId: { _id: 'p2', name: 'Ops' },
      },
    ]);
    axios.patch.mockResolvedValue({ data: {} });
    renderPage();
    const mirrorBtn = await screen.findByRole('button', { name: 'Mirror' });
    fireEvent.click(mirrorBtn);
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
      '/api/integrations/i-live',
      { config: { relayAllAgentMessages: true } },
      expect.anything(),
    ));
  });

  it('ghost empty state opens the add flow and excludes public pods', async () => {
    mockGets([]);
    renderPage();
    await screen.findByText(/Link a channel/);
    fireEvent.click(screen.getByRole('button', { name: /Telegram/ }));
    const picker = screen.getByLabelText('Pod to bridge');
    const options = Array.from(picker.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('Rewire Live Demo');
    expect(options).not.toContain('Town Square');
  });

  it('installs Telegram for the selected pod', async () => {
    mockGets([]);
    axios.post.mockResolvedValue({ data: { integration: { _id: 'new' } } });
    renderPage();
    await screen.findByText(/Link a channel/);
    fireEvent.click(screen.getByRole('button', { name: /Telegram/ }));
    fireEvent.click(screen.getByText('New Telegram connector'));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/installables/telegram/install',
      { podId: 'p1' },
      expect.anything(),
    ));
  });

  it('disconnects an installable Telegram connector through its lifecycle verb', async () => {
    mockGets();
    axios.delete.mockResolvedValue({ data: { status: 'uninstalled' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: /Really disconnect/ }));
    await waitFor(() => expect(axios.delete).toHaveBeenCalledWith(
      '/api/installables/telegram/install',
      expect.anything(),
    ));
  });

  it('derives the installable lifecycle target from the connector row type', () => {
    expect(installableLifecyclePath('slack')).toBe('/api/installables/slack/install');
  });

  it('keeps a legacy Telegram connector disconnectable through the legacy route', async () => {
    mockGets([{ ...connectors[1], installationId: undefined }]);
    axios.patch.mockResolvedValue({ data: {} });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: /Really disconnect/ }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
      '/api/integrations/i-live',
      { isActive: false },
      expect.anything(),
    ));
  });

  it('SOON platforms are not buttons', async () => {
    mockGets([]);
    renderPage();
    await screen.findByText(/Link a channel/);
    expect(screen.queryByRole('button', { name: /Slack/ })).toBeNull();
    expect(screen.getAllByText('SOON').length).toBeGreaterThanOrEqual(1);
  });
});
