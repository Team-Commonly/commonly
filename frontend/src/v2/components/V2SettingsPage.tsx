import { Link } from 'react-router-dom';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { getAvatarSrc } from '../../utils/avatarUtils';
import { useAuth } from '../../context/AuthContext';
import AppsManagement from '../../components/AppsManagement';
import '../primitives/primitives.css';
import './V2SettingsPage.css';
import V2BillingPanel from './V2BillingPanel';
import V2DevicesPanel from './V2DevicesPanel';
import V2DeleteAccount from './V2DeleteAccount';
import V2Avatar from './V2Avatar';
import V2AvatarCropDialog from './V2AvatarCropDialog';
import V2Segmented from './V2Segmented';
import { nextPaperAvatarPreset } from '../utils/avatarPresets';
import { LANGUAGE_REGISTRY } from '../../i18n';
import { V2_THEMES, V2ThemePref, getV2Theme, setV2Theme } from '../utils/theme';

type TokenStatus = {
  hasToken?: boolean;
  createdAt?: string;
  scopes?: string[];
  last4?: string | null;
};

const formatTokenCreatedAt = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  return `Created ${date.getDate()} ${month} ${date.getFullYear()}`;
};

interface SettingsSectionProps {
  id: string;
  title: string;
  children: React.ReactNode;
}

// D215 (TASK-688): three groups on one screen, no jump nav. Language and theme
// sit under Look; sign-out-everywhere and delete account fold into Account actions.

// Custom "Developer apps" (AppsManagement) stays hidden until every path
// (create, edit, delete, use) is walked live. Default off (TASK-674, D215).
const developerAppsEnabled = () => process.env.REACT_APP_DEVELOPER_APPS === 'true';

// Admin-only: the instance's user list and usage analytics. Their routes
// survived the Settings consolidation (#1544) but the way in did not — the
// pages were reachable only by typing the URL (2026-09-08).
const ADMIN_SECTION = { id: 'admin', title: 'Administration' } as const;
const ADMIN_LINKS = [
  { to: '/v2/admin/users', label: 'Users', detail: 'Registered users, bans, invitation codes' },
  { to: '/v2/admin/analytics', label: 'Usage analytics', detail: 'Signups, messages, active users, activation funnel' },
] as const;

const settingsSectionId = (id: string) => `v2-settings-${id}`;

const SettingsSection: React.FC<SettingsSectionProps> = ({ id, title, children }) => (
  <section
    className="v2-settings__section"
    id={settingsSectionId(id)}
    aria-labelledby={`${settingsSectionId(id)}-label`}
  >
    <h2 className="v2p-gtitle" id={`${settingsSectionId(id)}-label`}>{title}</h2>
    <div className="v2p-list">{children}</div>
  </section>
);

const Svg: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg className="v2-settings__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const Pencil = () => <Svg><path d="M4 20h4l10-10-4-4L4 16v4zM13 7l4 4" /></Svg>;
const Chevron = () => <Svg><path d="m6 9 6 6 6-6" /></Svg>;
const Key = () => <Svg><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M16 7l2 2" /></Svg>;
const Plug = () => <Svg><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v4" /></Svg>;
const Chat = () => <Svg><path d="M5 5h14v10H9l-4 4V5z" /></Svg>;
const Card = () => <Svg><path d="M3 6h18v12H3zM3 10h18" /></Svg>;
const Globe = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></Svg>;
const Moon = () => <Svg><path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z" /></Svg>;
const Next = () => <Svg><path d="m9 6 6 6-6 6" /></Svg>;
const Warn = () => <Svg><path d="M12 4 3 20h18L12 4zM12 10v4M12 17v.5" /></Svg>;

const V2AccountSection: React.FC = () => {
  const { currentUser, updateProfile, updateUsername } = useAuth();
  const { t } = useTranslation();
  const accountName = String(currentUser?.displayName || currentUser?.username || 'Your account');
  const accountUsername = String(currentUser?.username || '');
  const accountEmail = String(currentUser?.email || '');
  const profilePicture = String(currentUser?.profilePicture || 'default');
  const hasFaceOrPhoto = profilePicture.startsWith('bigsmile:')
    || (!profilePicture.startsWith('paper:') && Boolean(getAvatarSrc(profilePicture)));
  const [name, setName] = useState(accountName);
  const [username, setUsername] = useState(accountUsername);
  const [savedUsername, setSavedUsername] = useState(accountUsername);
  const [email, setEmail] = useState(accountEmail);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [usernameBusy, setUsernameBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [regeneratingAvatar, setRegeneratingAvatar] = useState(false);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadPhotoButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setName(accountName);
    setUsername(accountUsername);
    setSavedUsername(accountUsername);
    setEmail(accountEmail);
  }, [accountEmail, accountName, accountUsername]);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextName = name.trim();
    if (nextName === accountName) {
      setNotice('No account changes to save.');
      setError(null);
      return;
    }

    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await updateProfile({ displayName: nextName });
      setNotice('Account saved.');
    } catch (requestError) {
      const message = (requestError as { response?: { data?: { error?: string; msg?: string } } })?.response?.data;
      setError(message?.error || message?.msg || 'Couldn’t save your account. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const saveUsername = async () => {
    const nextUsername = username.trim().toLowerCase();
    if (nextUsername === accountUsername.toLowerCase()) {
      setNotice('No username changes to save.');
      setError(null);
      return;
    }

    setUsernameBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = updateUsername
        ? await updateUsername(nextUsername)
        : await axios.put('/api/users/username', { username: nextUsername });
      const updatedUsername = String(
        (response as { username?: string; data?: { username?: string } })?.username
          || (response as { data?: { username?: string } })?.data?.username
          || nextUsername,
      );
      setUsername(updatedUsername);
      setSavedUsername(updatedUsername);
      setNotice('Username saved.');
    } catch (requestError) {
      const message = (requestError as { response?: { data?: { error?: string; msg?: string } } })?.response?.data;
      setError(message?.error || message?.msg || 'Couldn’t save your username. Try again.');
    } finally {
      setUsernameBusy(false);
    }
  };

  const handleUsernameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!usernameBusy) void saveUsername();
  };

  const choosePhoto = () => fileInputRef.current?.click();

  const regenerateAvatar = async () => {
    setRegeneratingAvatar(true);
    setPhotoError(null);
    setError(null);
    setNotice(null);
    try {
      const userId = String(currentUser?._id || currentUser?.id || '');
      const profilePicture = nextPaperAvatarPreset(userId, currentUser?.profilePicture);
      await updateProfile({ profilePicture });
      setNotice(t('settings.avatar.regenerated'));
    } catch {
      setPhotoError(t('settings.avatar.regenerateFailed'));
    } finally {
      setRegeneratingAvatar(false);
    }
  };

  const selectPhoto = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setPhotoError(t('settings.avatar.imageTypeRequired'));
      setError(null);
      return;
    }
    setPhotoError(null);
    setError(null);
    setNotice(null);
    setAvatarFile(file);
  };

  const saveCroppedPhoto = async (image: Blob) => {
    setSavingPhoto(true);
    setPhotoError(null);
    setError(null);
    setNotice(null);
    let uploaded = false;
    try {
      const formData = new FormData();
      formData.append('image', image, 'avatar.png');
      const upload = await axios.post<{ url?: string }>('/api/uploads', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const profilePicture = upload.data?.url;
      if (!profilePicture?.startsWith('/api/uploads/')) throw new Error('Upload path was not returned');
      uploaded = true;
      await updateProfile({ profilePicture });
      setNotice(t('settings.avatar.photoSaved'));
      setAvatarFile(null);
    } catch {
      setPhotoError(t(uploaded ? 'settings.avatar.profileSaveFailed' : 'settings.avatar.uploadFailed'));
    } finally {
      setSavingPhoto(false);
    }
  };

  return (
    <form className="v2-settings__account" onSubmit={save}>
      <div className="v2p-lrow v2-settings__account-row">
        <span className="lb">
          <button
            type="button"
            className="v2p-b v2p-b-g v2-settings__photo-btn"
            title="Change photo"
            aria-label="Change photo"
            aria-expanded={editing}
            aria-controls="v2-settings-profile-edit"
            onClick={() => setEditing(true)}
          >
            <V2Avatar
              className="v2-settings__avatar"
              name={name || accountName}
              src={currentUser?.profilePicture || undefined}
              kind="human"
              seed={currentUser?._id || currentUser?.id}
              title={`${name || accountName} avatar`}
            />
          </button>
          <span className="v2-settings__account-copy">
            <span className="v2-settings__account-name">{name || accountName}</span>
            <span className="v2-settings__meta">
              <span>@{savedUsername}</span> · {currentUser?.role === 'admin' ? 'administrator' : 'member'}
            </span>
          </span>
        </span>
        <span className="vl" />
        <span className="ac">
          <button
            type="button"
            className="v2p-b v2p-b-g v2p-ib v2p-b-sm"
            title="Edit name and username"
            aria-label="Edit profile"
            aria-expanded={editing}
            aria-controls="v2-settings-profile-edit"
            onClick={() => setEditing((open) => !open)}
          >
            <Pencil />
          </button>
        </span>
      </div>
      <div className="v2p-lrow">
        <span className="lb"><Chat />Email</span>
        <span className="vl"><span className="mo v2-settings__mail">{accountEmail || '—'}</span></span>
        <span className="ac">
          <button
            type="button"
            className="v2p-b v2p-b-g v2p-ib v2p-b-sm"
            title="Change email"
            aria-label="Edit email"
            aria-expanded={editing}
            aria-controls="v2-settings-profile-edit"
            onClick={() => setEditing((open) => !open)}
          >
            <Pencil />
          </button>
        </span>
      </div>
      <div className={`v2-settings__edit${editing ? '' : ' v2-settings__edit--closed'}`} id="v2-settings-profile-edit">
      <input
        ref={fileInputRef}
        className="v2-settings__avatar-file-input"
        type="file"
        accept="image/*"
        aria-hidden="true"
        tabIndex={-1}
        onChange={selectPhoto}
      />
      <div className="v2-settings__avatar-actions">
        <button
          className="v2p-b v2p-b-s v2p-b-sm"
          type="button"
          onClick={() => { if (!regeneratingAvatar && !savingPhoto) void regenerateAvatar(); }}
          aria-disabled={regeneratingAvatar || savingPhoto}
        >
          {t('settings.avatar.regenerate')}
        </button>
        <button
          ref={uploadPhotoButtonRef}
          className="v2p-b v2p-b-s v2p-b-sm"
          type="button"
          onClick={choosePhoto}
          disabled={regeneratingAvatar || savingPhoto}
        >
          {t('settings.avatar.uploadPhoto')}
        </button>
      </div>
      <p className="v2-settings__avatar-description">
        {t(hasFaceOrPhoto ? 'settings.avatar.descriptionAfterChoice' : 'settings.avatar.description')}
      </p>
      {photoError && !avatarFile && (
        <p className="v2-settings__message v2-settings__message--error" role="alert">{photoError}</p>
      )}
      <div className="v2-settings__account-fields">
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
        </label>
        <label>
          <span>Username</span>
          <div className="v2-settings__username-control">
            <input
              id="v2-settings-username"
              aria-label="Username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              onKeyDown={handleUsernameKeyDown}
              minLength={2}
              maxLength={40}
              pattern="[a-z0-9][a-z0-9-]{1,39}"
              autoComplete="off"
              aria-describedby="v2-settings-username-help"
            />
            <button
              className="v2p-b v2p-b-s v2p-b-sm"
              type="button"
              onClick={() => { if (!usernameBusy) void saveUsername(); }}
              disabled={usernameBusy}
            >
              {usernameBusy ? t('settings.username.saving') : t('settings.username.save')}
            </button>
          </div>
          <span className="v2-settings__field-help" id="v2-settings-username-help">
            {t('settings.username.help')}
          </span>
        </label>
        <div className="v2-settings__account-email">
          <label htmlFor="v2-settings-email">Email</label>
          <div className="v2-settings__email-control">
            <input id="v2-settings-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <button className="v2p-b v2p-b-s v2p-b-sm" type="button">Change</button>
          </div>
        </div>
      </div>
      {error && <p className="v2-settings__message v2-settings__message--error" role="alert">{error}</p>}
      {notice && <p className="v2-settings__message" role="status">{notice}</p>}
      <div className="v2-settings__actions">
        <button className="v2p-b v2p-b-p" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      </div>
      {avatarFile && (
        <V2AvatarCropDialog
          file={avatarFile}
          saving={savingPhoto}
          error={photoError}
          returnFocusElement={uploadPhotoButtonRef.current}
          onCancel={() => { setAvatarFile(null); setPhotoError(null); }}
          onSave={(image) => { void saveCroppedPhoto(image); }}
        />
      )}
    </form>
  );
};

const V2AccountActions: React.FC = () => {
  const { logout } = useAuth();
  const { t } = useTranslation();
  const [revokingSessions, setRevokingSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOutEverywhere = async () => {
    if (!window.confirm(t('settings.sessions.confirm'))) return;
    setRevokingSessions(true);
    setError(null);
    try {
      await axios.post('/api/auth/sessions/revoke');
      logout();
    } catch {
      setError(t('settings.sessions.failed'));
      setRevokingSessions(false);
    }
  };

  return (
    <details className="v2p-disc v2-settings__actions-fold">
      <summary>
        <span className="lb"><Warn />Account actions</span>
        <span className="vl" />
        <Chevron />
      </summary>
      <div className="v2-settings__fold-body">
        {error && <p className="v2-settings__message v2-settings__message--error" role="alert">{error}</p>}
        <div className="v2-settings__actions">
          <button className="v2p-b v2p-b-s v2p-b-sm" type="button" disabled={revokingSessions}
            onClick={() => { void signOutEverywhere(); }}>
            {t('settings.sessions.signOutEverywhere')}
          </button>
        </div>
        <V2DeleteAccount />
      </div>
    </details>
  );
};

const V2ApiTokenSection: React.FC = () => {
  const [hasToken, setHasToken] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [last4, setLast4] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState<'generate' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await axios.get<TokenStatus>('/api/auth/api-token');
        if (!active) return;
        setHasToken(Boolean(response.data?.hasToken));
        setToken(null);
        setCreatedAt(response.data?.createdAt || null);
        setLast4(response.data?.last4 || null);
        setShowToken(false);
      } catch {
        // A missing token is an expected state. The generate action remains available.
      }
    };
    void load();
    return () => { active = false; };
  }, []);

  const generate = async () => {
    setBusy('generate');
    setError(null);
    setNotice(null);
    try {
      const response = await axios.post<{ apiToken?: string; createdAt?: string }>('/api/auth/api-token/generate', {});
      const generatedToken = response.data.apiToken || null;
      setHasToken(true);
      setToken(generatedToken);
      setCreatedAt(response.data.createdAt || null);
      setLast4(generatedToken ? generatedToken.slice(-4) : null);
      setShowToken(true);
      setNotice('New API token generated. Copy it now; treat it like a password.');
    } catch {
      setError('Couldn’t generate an API token. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    setBusy('revoke');
    setError(null);
    setNotice(null);
    try {
      await axios.delete('/api/auth/api-token');
      setHasToken(false);
      setToken(null);
      setCreatedAt(null);
      setLast4(null);
      setShowToken(false);
      setNotice('API token revoked.');
    } catch {
      setError('Couldn’t revoke the API token. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setNotice('API token copied.');
    } catch {
      setError('Couldn’t copy the API token. Select and copy it manually.');
    }
  };

  const maskedToken = '••••••••••••••••••••••••••••••••';
  const createdLabel = createdAt ? formatTokenCreatedAt(createdAt) : null;

  const statusLabel = hasToken ? `Active${last4 ? ` · ends in ${last4}` : ''}` : 'None';

  return (
    <>
      <div className="v2p-lrow">
        <span className="lb"><Key />API token</span>
        <span className="vl"><span className="mu">{statusLabel}</span></span>
        <span className="ac">
          {hasToken ? (
            <>
              <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => void generate()} disabled={busy !== null}>
                {busy === 'generate' ? 'Regenerating…' : 'Regenerate'}
              </button>
              <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => void revoke()} disabled={busy !== null}>
                {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
              </button>
            </>
          ) : (
            <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => void generate()} disabled={busy !== null}>
              {busy === 'generate' ? 'Generating…' : 'Generate'}
            </button>
          )}
        </span>
      </div>
      {(error || notice || token) && (
        <div className="v2-settings__token-detail">
          {error && <p className="v2-settings__message v2-settings__message--error" role="alert">{error}</p>}
          {notice && <p className="v2-settings__message" role="status">{notice}</p>}
          {token && (
            <>
              <div className="v2-settings__token-value">
                <code>{token && showToken ? token : maskedToken}</code>
                <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => setShowToken((visible) => !visible)}>
                  {showToken ? 'Hide' : 'Show'}
                </button>
                <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => void copy()}>Copy</button>
              </div>
              {createdLabel && <p className="v2-settings__token-meta">{createdLabel}</p>}
            </>
          )}
        </div>
      )}
    </>
  );
};

const V2LanguageSection: React.FC = () => {
  const { i18n, t } = useTranslation();
  const active = i18n.resolvedLanguage || i18n.language || 'en';
  const [theme, setTheme] = useState<V2ThemePref>(() => getV2Theme());
  const chooseTheme = (pref: V2ThemePref) => {
    setTheme(pref);
    setV2Theme(pref);
  };

  return (
    <>
      <div className="v2p-lrow">
        <span className="lb"><Globe />{t('common.language.label')}</span>
        <span className="vl" />
        <span className="ac"><V2Segmented
          size="sm"
          ariaLabel={t('common.language.label')}
          value={(LANGUAGE_REGISTRY.find((language) => language.code === active) || LANGUAGE_REGISTRY[0]).code}
          onChange={(code) => { void i18n.changeLanguage(code); }}
          options={LANGUAGE_REGISTRY.map((language) => ({ value: language.code, label: language.short, ariaLabel: language.label }))}
        /></span>
      </div>
      <div className="v2p-lrow">
        <span className="lb"><Moon />{t('common.theme.label')}</span>
        <span className="vl" />
        <span className="ac"><V2Segmented
          size="sm"
          ariaLabel={t('common.theme.label')}
          value={theme}
          onChange={chooseTheme}
          options={V2_THEMES.map((pref) => ({ value: pref, label: t(`common.theme.${pref}`) }))}
        /></span>
      </div>
    </>
  );
};

const V2AdminSection: React.FC = () => (
  <div className="v2-settings__admin-links">
    {ADMIN_LINKS.map((link) => (
      <Link key={link.to} className="v2-settings__admin-link" to={link.to}>
        <span className="v2-settings__admin-link-label">{link.label}</span>
        <span className="v2-settings__admin-link-detail">{link.detail}</span>
      </Link>
    ))}
  </div>
);

const V2SettingsPage: React.FC = () => {
  const { currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';

  return (
    <div className="v2-settings" aria-label="Settings">
      <header className="v2p-ph"><h1>Settings</h1></header>
      <div className="v2p-body v2-settings__layout">
        <div className="v2-settings__content">
          <SettingsSection id="account" title="Account">
            <V2AccountSection />
            <V2BillingPanel />
          </SettingsSection>
          <SettingsSection id="access" title="Access">
            <V2DevicesPanel showHeading={false} asFold />
            <V2ApiTokenSection />
            <Link className="v2p-lrow v2-settings__link" to="/v2/connectors">
              <span className="lb"><Plug />Connectors</span>
              <span className="vl"><span className="mu">Manage connected services</span></span>
              <span className="ac"><span className="v2p-b v2p-b-g v2p-ib v2p-b-sm" aria-hidden="true"><Next /></span></span>
            </Link>
            {developerAppsEnabled() && (
              <details className="v2-settings__developer-disclosure">
                <summary>Developer apps</summary>
                <AppsManagement variant="settings" showIntegrations={false} />
              </details>
            )}
          </SettingsSection>
          <SettingsSection id="look" title="Look"><V2LanguageSection /></SettingsSection>
          <div className="v2p-list v2-settings__actions-list"><V2AccountActions /></div>
          {isAdmin && (
            <SettingsSection id={ADMIN_SECTION.id} title={ADMIN_SECTION.title}><V2AdminSection /></SettingsSection>
          )}
        </div>
      </div>
    </div>
  );
};

export default V2SettingsPage;
