import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../i18n';
import axios from '../../utils/axiosConfig';
import { MemoryRouter } from 'react-router-dom';
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
  const MockV2Avatar = ({ name, src, className, kind }: { name?: string; src?: string; className?: string; kind?: string }) => (
    <img alt={`${name} avatar`} className={className} data-kind={kind} src={src} />
  );
  MockV2Avatar.displayName = 'MockV2Avatar';
  return MockV2Avatar;
});

jest.mock('../components/V2AvatarCropDialog', () => {
  const React = require('react');
  const MockV2AvatarCropDialog = ({ onSave, error }: { onSave: (image: Blob) => void; error: string | null }) => React.createElement(
    'section',
    { role: 'dialog' },
    error && React.createElement('p', { role: 'alert' }, error),
    React.createElement(
      'button',
      { type: 'button', onClick: () => onSave(new Blob(['cropped'], { type: 'image/png' })) },
      'Apply crop',
    ),
  );
  MockV2AvatarCropDialog.displayName = 'MockV2AvatarCropDialog';
  return { __esModule: true, default: MockV2AvatarCropDialog };
});

jest.mock('../components/V2BillingPanel', () => {
  const MockV2BillingPanel = ({ showHeading }: { showHeading?: boolean }) => <div data-show-heading={String(showHeading)}>Plan controls</div>;
  MockV2BillingPanel.displayName = 'MockV2BillingPanel';
  return MockV2BillingPanel;
});

jest.mock('../components/V2DevicesPanel', () => {
  const MockV2DevicesPanel = ({ showHeading }: { showHeading?: boolean }) => <div data-show-heading={String(showHeading)}>Device controls</div>;
  MockV2DevicesPanel.displayName = 'MockV2DevicesPanel';
  return MockV2DevicesPanel;
});

const auth = {
  currentUser: { _id: 'u1', username: 'lily', email: 'lily@example.com', profilePicture: '/uploads/lily.png', role: 'member' },
  user: { _id: 'u1', username: 'lily', email: 'lily@example.com', profilePicture: '/uploads/lily.png', role: 'member' },
  token: 'jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

const TOKEN_CREATED_AT = '2026-09-04T12:00:00.000Z';

// The page links to the admin routes, so it renders under a router.
const renderSettings = (currentUser = auth.currentUser) => render(
  <AuthContext.Provider value={{ ...auth, currentUser, user: currentUser }}>
    <MemoryRouter><div className="v2-root"><V2SettingsPage /></div></MemoryRouter>
  </AuthContext.Provider>,
);

afterEach(() => jest.clearAllMocks());

describe('V2SettingsPage', () => {
  test('keeps every folded settings concern visible on one page', () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    renderSettings();

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    for (const section of [
      { id: 'account', title: 'Account' },
      { id: 'plan', title: 'Plan' },
      { id: 'devices', title: 'Devices' },
      { id: 'api-token', title: 'API token' },
      { id: 'connected-apps', title: 'Connected apps' },
      { id: 'language', title: 'Language' },
    ]) {
      expect(screen.getByRole('heading', { name: section.title })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: section.title })).toHaveAttribute('href', `#v2-settings-${section.id}`);
    }
    expect(screen.getByText('lily')).toBeInTheDocument();
    expect(screen.getByText('Plan controls')).toBeInTheDocument();
    expect(screen.getByText('Device controls')).toBeInTheDocument();
    expect(screen.getByText('Plan controls')).toHaveAttribute('data-show-heading', 'false');
    expect(screen.getByText('Device controls')).toHaveAttribute('data-show-heading', 'false');
    expect(screen.getByText('Connected app controls')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'lily avatar' })).toHaveClass('v2-settings__avatar');
    expect(screen.getByRole('img', { name: 'lily avatar' })).toHaveAttribute('src', '/uploads/lily.png');
    expect(screen.getByRole('img', { name: 'lily avatar' })).toHaveAttribute('data-kind', 'human');
    expect(screen.getByText('Connected app controls')).toHaveAttribute('data-variant', 'settings');
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload photo' })).toBeInTheDocument();
    expect(screen.getByText('Regenerate for another, or upload a photo.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'English' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '中文' })).toBeInTheDocument();
  });

  test('uses a left navigation column to target Settings sections', () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    renderSettings();

    expect(document.getElementById('v2-settings-account')).toHaveAttribute('aria-labelledby', 'v2-settings-account-label');
    expect(document.getElementById('v2-settings-connected-apps')).toHaveAttribute('aria-labelledby', 'v2-settings-connected-apps-label');
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'location');

    fireEvent.click(screen.getByRole('link', { name: 'Plan' }));
    expect(screen.getByRole('link', { name: 'Plan' })).toHaveAttribute('aria-current', 'location');
  });

  test('generates and reveals a new API token without leaving Settings', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    (axios.post as jest.Mock).mockResolvedValue({ data: { apiToken: 'cm_user_secret', createdAt: TOKEN_CREATED_AT } });
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Generate API token' }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/auth/api-token/generate', {}));
    expect(await screen.findByText('cm_user_secret')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  test('shows metadata for an existing token without attempting to re-display its secret', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: { hasToken: true, createdAt: TOKEN_CREATED_AT, scopes: ['agent:context:read'], last4: 'cret' },
    });
    renderSettings();

    expect(await screen.findByText(/shown once, when generated/i)).toBeInTheDocument();
    expect(screen.getByText(/ends in cret/i)).toBeInTheDocument();
    expect(screen.getByText(/^Created [45] Sep 2026$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show' })).not.toBeInTheDocument();
    expect(screen.queryByText('cm_user_secret')).not.toBeInTheDocument();
  });

  test('saves only the editable name from the Account section and exposes the staged email-change control', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    auth.updateProfile.mockResolvedValue({ ...auth.currentUser, displayName: 'Lily Shen' });
    renderSettings();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lily Shen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(auth.updateProfile).toHaveBeenCalledTimes(1));
    expect(auth.updateProfile).toHaveBeenCalledWith({ displayName: 'Lily Shen' });
    expect(screen.getByLabelText('Username')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Email')).toHaveValue('lily@example.com');
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(auth.updateProfile).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Account saved.');
    expect(screen.queryByText(/re-verification; ask us for now/i)).not.toBeInTheDocument();
  });

  test('Regenerate saves the next Paper seed instead of repeating the current look', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    auth.updateProfile.mockResolvedValue({ ...auth.currentUser, profilePicture: 'paper:u1-v1' });
    renderSettings({ ...auth.currentUser, profilePicture: 'paper:u1-v0' });

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    await waitFor(() => expect(auth.updateProfile).toHaveBeenCalledWith({
      profilePicture: 'paper:u1-v1',
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('Avatar changed.');
  });

  test('keeps the no-face explanation for Paper and shortens it for a picked face or photo', () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    const { rerender } = renderSettings({ ...auth.currentUser, profilePicture: 'default' });

    expect(screen.getByText('No face and no skin tone until you choose one. Regenerate for another, or upload a photo.'))
      .toBeInTheDocument();

    rerender(
      <AuthContext.Provider value={{ ...auth, currentUser: { ...auth.currentUser, profilePicture: 'paper:u1-v23' }, user: { ...auth.currentUser, profilePicture: 'paper:u1-v23' } }}>
        <MemoryRouter><div className="v2-root"><V2SettingsPage /></div></MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.getByText('No face and no skin tone until you choose one. Regenerate for another, or upload a photo.'))
      .toBeInTheDocument();

    rerender(
      <AuthContext.Provider value={{ ...auth, currentUser: { ...auth.currentUser, profilePicture: 'bigsmile:u1-v3' }, user: { ...auth.currentUser, profilePicture: 'bigsmile:u1-v3' } }}>
        <MemoryRouter><div className="v2-root"><V2SettingsPage /></div></MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.getByText('Regenerate for another, or upload a photo.')).toBeInTheDocument();
    expect(screen.queryByText('No face and no skin tone until you choose one. Regenerate for another, or upload a photo.'))
      .not.toBeInTheDocument();
  });

  test('Regenerate reports a profile save error without losing the current avatar', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    auth.updateProfile.mockRejectedValue(new Error('profile update failed'));
    renderSettings({ ...auth.currentUser, profilePicture: 'paper:u1-v12' });

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not change your avatar. Try again.');
    expect(screen.getByRole('img', { name: 'lily avatar' })).toHaveAttribute('src', 'paper:u1-v12');
  });

  test('uploads a cropped image without a pod scope and saves the returned API path as the profile picture', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    (axios.post as jest.Mock).mockResolvedValue({ data: { url: '/api/uploads/avatar-512.png' } });
    auth.updateProfile.mockResolvedValue({ ...auth.currentUser, profilePicture: '/api/uploads/avatar-512.png' });
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['original'], 'original.jpg', { type: 'image/jpeg' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply crop' }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/uploads',
      expect.any(FormData),
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ));
    const upload = (axios.post as jest.Mock).mock.calls[0][1] as FormData;
    const image = upload.get('image') as File;
    expect(image.name).toBe('avatar.png');
    expect(image.type).toBe('image/png');
    expect(upload.get('podId')).toBeNull();
    await waitFor(() => expect(auth.updateProfile).toHaveBeenCalledWith({
      profilePicture: '/api/uploads/avatar-512.png',
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('Photo saved.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('keeps the crop step open with an error when the upload fails', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    (axios.post as jest.Mock).mockRejectedValue(new Error('upload failed'));
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['original'], 'original.jpg', { type: 'image/jpeg' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply crop' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not upload your photo. Try again.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply crop' })).toBeInTheDocument();
    expect(auth.updateProfile).not.toHaveBeenCalled();
  });

  test('keeps the crop step open when the profile picture write fails after upload', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    (axios.post as jest.Mock).mockResolvedValue({ data: { url: '/api/uploads/avatar-512.png' } });
    auth.updateProfile.mockRejectedValue(new Error('profile update failed'));
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['original'], 'original.jpg', { type: 'image/jpeg' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply crop' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save your avatar. Try again.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(auth.updateProfile).toHaveBeenCalledWith({ profilePicture: '/api/uploads/avatar-512.png' });
  });

  test('rejects a selected non-image file before opening the crop dialog', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['text'], 'notes.txt', { type: 'text/plain' })] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose an image file.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('an admin gets an Administration section with the users and usage-analytics links; a member does not', () => {
    // The routes survived the Settings consolidation (#1544); the way in did
    // not, so both admin pages were reachable only by URL.
    const { unmount } = renderSettings();
    expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull();
    expect(screen.queryByText('Usage analytics')).toBeNull();
    unmount();
    const adminAuth = { ...auth, currentUser: { ...auth.currentUser, role: 'admin' }, user: { ...auth.user, role: 'admin' } };
    render(
      <AuthContext.Provider value={adminAuth}>
        <MemoryRouter><V2SettingsPage /></MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.getByRole('link', { name: 'Administration' })).toHaveAttribute('href', '#v2-settings-admin');
    expect(screen.getByRole('link', { name: /^Users/ })).toHaveAttribute('href', '/v2/admin/users');
    expect(screen.getByRole('link', { name: /^Usage analytics/ })).toHaveAttribute('href', '/v2/admin/analytics');
  });
});
