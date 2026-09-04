import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../i18n';
import axios from '../../utils/axiosConfig';
import { AuthContext } from '../../context/AuthContext';
import V2SettingsPage from '../components/V2SettingsPage';

jest.mock('../../utils/axiosConfig', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

jest.mock('../../components/AppsManagement', () => {
  const MockAppsManagement = ({ variant }: { variant?: string }) => <div data-variant={variant}>Connected app controls</div>;
  MockAppsManagement.displayName = 'MockAppsManagement';
  return MockAppsManagement;
});

jest.mock('../components/V2Avatar', () => {
  const MockV2Avatar = ({ name, src, className }: { name?: string; src?: string; className?: string }) => (
    <img alt={`${name} avatar`} className={className} src={src} />
  );
  MockV2Avatar.displayName = 'MockV2Avatar';
  return MockV2Avatar;
});

jest.mock('../components/V2BillingPanel', () => {
  const MockV2BillingPanel = () => <div>Plan controls</div>;
  MockV2BillingPanel.displayName = 'MockV2BillingPanel';
  return MockV2BillingPanel;
});

jest.mock('../components/V2DevicesPanel', () => {
  const MockV2DevicesPanel = () => <div>Device controls</div>;
  MockV2DevicesPanel.displayName = 'MockV2DevicesPanel';
  return MockV2DevicesPanel;
});

const auth = {
  currentUser: { _id: 'u1', username: 'lily', email: 'lily@example.com', profilePicture: '/uploads/lily.png', role: 'member' },
  user: { _id: 'u1', username: 'lily', email: 'lily@example.com', profilePicture: '/uploads/lily.png', role: 'member' },
  token: 'jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

const renderSettings = () => render(
  <AuthContext.Provider value={auth}>
    <div className="v2-root"><V2SettingsPage /></div>
  </AuthContext.Provider>,
);

afterEach(() => jest.clearAllMocks());

describe('V2SettingsPage', () => {
  test('keeps every folded settings concern visible on one page', () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    renderSettings();

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    for (const label of ['account', 'plan', 'devices', 'api token', 'connected apps', 'language']) {
      expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText('lily')).toBeInTheDocument();
    expect(screen.getByText('Plan controls')).toBeInTheDocument();
    expect(screen.getByText('Device controls')).toBeInTheDocument();
    expect(screen.getByText('Connected app controls')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'lily avatar' })).toHaveClass('v2-settings__avatar');
    expect(screen.getByRole('img', { name: 'lily avatar' })).toHaveAttribute('src', '/uploads/lily.png');
    expect(screen.getByText('Connected app controls')).toHaveAttribute('data-variant', 'settings');
    expect(screen.getByRole('radio', { name: 'English' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '中文' })).toBeInTheDocument();
  });

  test('generates and reveals a new API token without leaving Settings', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    (axios.post as jest.Mock).mockResolvedValue({ data: { apiToken: 'cm_user_secret', createdAt: '2026-09-04T19:00:00.000Z' } });
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Generate API token' }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/auth/api-token/generate', {}));
    expect(await screen.findByText('cm_user_secret')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });
});
