import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n, { i18nReady, LANGUAGE_REGISTRY } from '../../i18n';
import axios from '../../utils/axiosConfig';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../../context/AuthContext';
import V2SettingsPage from '../components/V2SettingsPage';

jest.mock('../../utils/axiosConfig', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn(), patch: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

jest.mock('../../components/AppsManagement', () => {
  const MockAppsManagement = ({ variant, showIntegrations }: { variant?: string; showIntegrations?: boolean }) => (
    <div data-variant={variant} data-show-integrations={String(showIntegrations)}>Connected app controls</div>
  );
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
  register: jest.fn(), login: jest.fn(), signInWithToken: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(), updateUsername: jest.fn(),
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
  test('names the language choices in the active language', async () => {
    await i18nReady;
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    const view = renderSettings();

    expect(screen.getByRole('radiogroup', { name: '语言' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'English' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '中文' })).toHaveAttribute('aria-checked', 'true');

    view.unmount();
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  // Two shapes, two tests, because jest abandons a test at its first failing
  // expect: held together, a change to the shipped languages reported only the
  // literal and said nothing about whether this surface still reads the
  // registry (gate on #2436). Split, a failing run names both.
  const languageRadioLabels = () => within(screen.getByRole('radiogroup', { name: 'Language' }))
    .getAllByRole('radio')
    .map((radio) => radio.textContent);

  test('ships exactly the pinned language radios', async () => {
    await i18nReady;
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    renderSettings();

    expect(languageRadioLabels()).toEqual(['English', '中文']);
  });

  test('builds the language radios from the registry, and only those', async () => {
    await i18nReady;
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    renderSettings();

    expect(languageRadioLabels()).toEqual(LANGUAGE_REGISTRY.map(({ label }) => label));
  });

  test('Look carries the language as a segment that switches the app language', async () => {
    await i18nReady;
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    renderSettings();

    const look = screen.getByRole('region', { name: 'Look' });
    const language = within(look).getByRole('radiogroup', { name: 'Language' });
    expect(language).toHaveClass('v2-seg');
    expect(within(language).getByRole('radio', { name: 'English' })).toHaveAttribute('aria-checked', 'true');
    expect(within(look).getByRole('radiogroup', { name: 'Appearance' })).toHaveClass('v2-seg');

    await act(async () => { fireEvent.click(within(language).getByRole('radio', { name: '中文' })); });
    expect(i18n.resolvedLanguage).toBe('zh-CN');
    // The labels follow the new language, and the segment shows the choice.
    const zhLanguage = within(screen.getByRole('region', { name: 'Look' })).getByRole('radiogroup', { name: '语言' });
    expect(within(zhLanguage).getByRole('radio', { name: '中文' })).toHaveAttribute('aria-checked', 'true');

    await act(async () => { fireEvent.click(within(zhLanguage).getByRole('radio', { name: 'English' })); });
    expect(i18n.resolvedLanguage).toBe('en');
  });

  test('keeps every folded settings concern visible on one page', () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    renderSettings();

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Account actions').closest('details')).toContainElement(
      screen.getByRole('button', { name: 'Delete account' }),
    );
    for (const title of ['Account', 'Access', 'Look']) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    expect(screen.getByText('lily')).toBeInTheDocument();
    expect(screen.getByText('Plan controls')).toBeInTheDocument();
    expect(screen.getByText('Device controls')).toBeInTheDocument();
    expect(screen.getByText('Plan controls')).toHaveAttribute('data-show-heading', 'false');
    expect(screen.getByText('Device controls')).toHaveAttribute('data-show-heading', 'false');
    // Developer apps stay hidden unless REACT_APP_DEVELOPER_APPS=true (TASK-674).
    expect(screen.queryByText('Connected app controls')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'lily avatar' })).toHaveClass('v2-settings__avatar');
    expect(screen.getByRole('img', { name: 'lily avatar' })).toHaveAttribute('src', '/uploads/lily.png');
    expect(screen.getByRole('img', { name: 'lily avatar' })).toHaveAttribute('data-kind', 'human');
    expect(screen.getByRole('link', { name: /Connectors/ })).toHaveAttribute('href', '/v2/connectors');
    expect(screen.queryByText('Developer apps')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload photo' })).toBeInTheDocument();
    expect(screen.getByText('Regenerate for another, or upload a photo.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'English' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '中文' })).toBeInTheDocument();
  });

  test('shows Developer apps only when REACT_APP_DEVELOPER_APPS is exactly true', () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    const previous = process.env.REACT_APP_DEVELOPER_APPS;
    try {
      process.env.REACT_APP_DEVELOPER_APPS = 'yes';
      const off = renderSettings();
      expect(screen.queryByText('Developer apps')).not.toBeInTheDocument();
      off.unmount();

      process.env.REACT_APP_DEVELOPER_APPS = 'true';
      renderSettings();
      expect(screen.getByText('Developer apps')).toBeInTheDocument();
    } finally {
      if (previous === undefined) delete process.env.REACT_APP_DEVELOPER_APPS;
      else process.env.REACT_APP_DEVELOPER_APPS = previous;
    }
  });

  test('Account actions opens and reaches Sign out everywhere and Delete account', () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    renderSettings();

    const fold = screen.getByText('Account actions').closest('details') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    fireEvent.click(screen.getByText('Account actions').closest('summary') as HTMLElement);
    fold.open = true;
    expect(within(fold).getByRole('button', { name: 'Sign out everywhere' })).toBeInTheDocument();
    fireEvent.click(within(fold).getByRole('button', { name: 'Delete account' }));
    expect(screen.getByRole('textbox', { name: /DELETE|confirm/i })).toBeInTheDocument();
  });

  test('has three labelled groups on one screen and no jump navigation', () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    renderSettings();

    for (const id of ['account', 'access', 'look']) {
      expect(document.getElementById(`v2-settings-${id}`)).toHaveAttribute('aria-labelledby', `v2-settings-${id}-label`);
    }
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull();
  });

  test('the pencil opens the profile editor and closes it again', () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    renderSettings();

    const edit = screen.getByRole('button', { name: 'Edit profile' });
    expect(edit).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('v2-settings-profile-edit')).toHaveClass('v2-settings__edit--closed');
    fireEvent.click(edit);
    expect(edit).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('v2-settings-profile-edit')).not.toHaveClass('v2-settings__edit--closed');
    fireEvent.click(screen.getByRole('button', { name: 'Edit email' }));
    expect(document.getElementById('v2-settings-profile-edit')).toHaveClass('v2-settings__edit--closed');
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
    expect(screen.getByLabelText('Username')).toHaveValue('lily');
    expect(screen.getByLabelText('Email')).toHaveValue('lily@example.com');
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(auth.updateProfile).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Account saved.');
    expect(screen.queryByText(/re-verification; ask us for now/i)).not.toBeInTheDocument();
  });

  test('signs out every browser session after confirmation', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    (axios.post as jest.Mock).mockResolvedValue({ data: { message: 'Signed out everywhere' } });
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/auth/sessions/revoke'));
    expect(auth.logout).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  test('renames the username through the dedicated route and explains historical mentions', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    auth.updateUsername.mockResolvedValue({ ...auth.currentUser, username: 'team-member' });
    renderSettings();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: ' Team-Member ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save username' }));

    await waitFor(() => expect(auth.updateUsername).toHaveBeenCalledWith('team-member'));
    expect(await screen.findByRole('status')).toHaveTextContent('Username saved.');
    expect(screen.getByText('@team-member')).toBeInTheDocument();
    expect(screen.getByText(/previous username stays reserved/i)).toBeInTheDocument();
  });

  test('submits the username rename from Enter without submitting the display-name form', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    auth.updateUsername.mockResolvedValue({ ...auth.currentUser, username: 'team-member' });
    renderSettings();

    const usernameInput = screen.getByLabelText('Username');
    fireEvent.change(usernameInput, { target: { value: 'team-member' } });
    fireEvent.keyDown(usernameInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(auth.updateUsername).toHaveBeenCalledWith('team-member'));
    expect(auth.updateProfile).not.toHaveBeenCalled();
    expect(screen.queryByText('No account changes to save.')).not.toBeInTheDocument();
  });

  test('keeps the saved username in the header when a rename is rejected', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    auth.updateUsername.mockRejectedValueOnce({ response: { data: { error: 'Username is already taken.' } } });
    renderSettings();

    const usernameInput = screen.getByLabelText('Username');
    fireEvent.change(usernameInput, { target: { value: 'taken-name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save username' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Username is already taken.');
    expect(screen.getByText('@lily')).toBeInTheDocument();
    expect(screen.queryByText('@taken-name')).not.toBeInTheDocument();
  });

  test('localizes the username save controls and help in Chinese', async () => {
    await i18nReady;
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    let finishUpdate: ((value: unknown) => void) | undefined;
    auth.updateUsername.mockReturnValue(new Promise((resolve) => { finishUpdate = resolve; }));
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    const view = renderSettings();

    expect(screen.getByRole('button', { name: '保存用户名' })).toBeInTheDocument();
    expect(screen.getByText(/你的旧用户名会继续保留/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'team-member' } });
    fireEvent.click(screen.getByRole('button', { name: '保存用户名' }));
    expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled();

    await act(async () => { finishUpdate?.({ ...auth.currentUser, username: 'team-member' }); });
    view.unmount();
    await act(async () => { await i18n.changeLanguage('en'); });
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

  test('keeps Regenerate focused and ignores repeated activation while the profile write is pending', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    let finishUpdate: (() => void) | undefined;
    auth.updateProfile.mockReturnValue(new Promise((resolve) => {
      finishUpdate = () => resolve({});
    }));
    renderSettings({ ...auth.currentUser, profilePicture: 'paper:u1-v12' });

    const regenerateButton = screen.getByRole('button', { name: 'Regenerate' });
    regenerateButton.focus();
    fireEvent.click(regenerateButton);

    expect(regenerateButton).toHaveAttribute('aria-disabled', 'true');
    expect(regenerateButton).not.toBeDisabled();
    expect(regenerateButton).toHaveFocus();
    fireEvent.keyDown(regenerateButton, { key: 'Enter' });
    fireEvent.click(regenerateButton);
    expect(auth.updateProfile).toHaveBeenCalledTimes(1);

    await act(async () => { finishUpdate?.(); });
    expect(await screen.findByRole('status')).toHaveTextContent('Avatar changed.');
    expect(regenerateButton).toHaveFocus();
  });

  test('shows the same short avatar hint for Paper and for a picked face', () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { hasToken: false } });
    const { rerender } = renderSettings({ ...auth.currentUser, profilePicture: 'default' });

    expect(screen.getByText('Regenerate for another, or upload a photo.'))
      .toBeInTheDocument();

    rerender(
      <AuthContext.Provider value={{ ...auth, currentUser: { ...auth.currentUser, profilePicture: 'paper:u1-v23' }, user: { ...auth.currentUser, profilePicture: 'paper:u1-v23' } }}>
        <MemoryRouter><div className="v2-root"><V2SettingsPage /></div></MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.getByText('Regenerate for another, or upload a photo.'))
      .toBeInTheDocument();

    rerender(
      <AuthContext.Provider value={{ ...auth, currentUser: { ...auth.currentUser, profilePicture: 'bigsmile:u1-v3' }, user: { ...auth.currentUser, profilePicture: 'bigsmile:u1-v3' } }}>
        <MemoryRouter><div className="v2-root"><V2SettingsPage /></div></MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.getByText('Regenerate for another, or upload a photo.')).toBeInTheDocument();
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
    expect(screen.queryByRole('heading', { name: 'Administration' })).toBeNull();
    expect(screen.queryByText('Usage analytics')).toBeNull();
    unmount();
    const adminAuth = { ...auth, currentUser: { ...auth.currentUser, role: 'admin' }, user: { ...auth.user, role: 'admin' } };
    render(
      <AuthContext.Provider value={adminAuth}>
        <MemoryRouter><V2SettingsPage /></MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.getByRole('heading', { name: 'Administration' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Users/ })).toHaveAttribute('href', '/v2/admin/users');
    expect(screen.getByRole('link', { name: /^Usage analytics/ })).toHaveAttribute('href', '/v2/admin/analytics');
  });
});
