// @ts-nocheck
// Connectors page: lists the user's channel bridges, surfaces the one-time
// /commonly-enable code while pending, and toggles live relay via PATCH with
// linkedUserId set to the toggler (the bridge's attribution identity).
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2ConnectorsPage from '../components/V2ConnectorsPage';
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

  it('lists connectors with pod, status, and the enable code while pending', async () => {
    mockGets();
    renderPage();
    // The pod name renders in the card AND as a picker option — assert on both.
    expect((await screen.findAllByText('Rewire Live Demo')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/\/commonly-enable abc123/)).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/Rewire crew/)).toBeInTheDocument();
  });

  it('offers a new code when the enable code has expired (or never had an expiry)', async () => {
    mockGets([{ ...connectors[0], config: { connectCode: 'abc123' } }]);
    axios.post.mockResolvedValue({ data: {} });
    renderPage();
    expect(await screen.findByText(/code expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/\/commonly-enable abc123/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /new code/i }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/integrations/i-pending/connect-code',
      {},
      expect.anything(),
    ));
  });

  it('toggling live relay PATCHes liveRelay only — linkedUserId is server-derived', async () => {
    mockGets();
    axios.patch.mockResolvedValue({ data: {} });
    renderPage();
    const toggle = await screen.findByRole('checkbox');
    fireEvent.click(toggle);
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
      '/api/integrations/i-live',
      // No linkedUserId: the server stamps the authenticated caller and
      // rejects a client-supplied value (impersonation guard, #1290 review).
      { config: { liveRelay: true } },
      expect.anything(),
    ));
  });

  it('excludes public pods from the bridge target picker', async () => {
    mockGets([]);
    renderPage();
    await screen.findByText(/No connectors yet/);
    const picker = screen.getByLabelText('Pod to bridge');
    const options = Array.from(picker.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('Rewire Live Demo');
    expect(options).not.toContain('Town Square');
  });

  it('creates a telegram connector for the selected pod', async () => {
    mockGets([]);
    axios.post.mockResolvedValue({ data: { integration: { _id: 'new' } } });
    renderPage();
    await screen.findByText(/No connectors yet/);
    fireEvent.click(screen.getByText('New Telegram connector'));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/integrations',
      { podId: 'p1', type: 'telegram', config: {} },
      expect.anything(),
    ));
  });
});
