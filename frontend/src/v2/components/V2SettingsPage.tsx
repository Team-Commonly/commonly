import { Link, useNavigate } from 'react-router-dom';
import React, { useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
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
import { requestFirstRunGuide } from '../firstRunGuide';
import { V2_THEMES, V2ThemePref, setV2Theme } from '../utils/theme';
import { useV2Confirm } from '../hooks/useV2Confirm';
import { appDateLocale } from '../utils/appLocale';
import useV2ThemePref from '../hooks/useV2ThemePref';

type TokenStatus = {
  hasToken?: boolean;
  createdAt?: string;
  scopes?: string[];
  last4?: string | null;
};

const formatTokenCreatedAt = (value: string, t: TFunction) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const locale = appDateLocale();
  const formatted = locale
    ? date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
    : `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })} ${date.getFullYear()}`;
  return t('settings.apiToken.created', { date: formatted });
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
const ADMIN_SECTION_ID = 'admin';
const ADMIN_LINKS = [
  { to: '/v2/admin/users', key: 'users' },
  { to: '/v2/admin/analytics', key: 'analytics' },
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
const Book = () => <Svg><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zM5 17a3 3 0 0 1 3-3h11" /></Svg>;
const Warn = () => <Svg><path d="M12 4 3 20h18L12 4zM12 10v4M12 17v.5" /></Svg>;

const V2AccountSection: React.FC = () => {
  const { currentUser, updateProfile, updateUsername } = useAuth();
  const { t } = useTranslation();
  // The saved name, kept apart from the translated fallback so a language switch can't touch an edit.
  const savedName = String(currentUser?.displayName || currentUser?.username || '');
  const accountName = savedName || t('settings.account.fallbackName');
  const accountUsername = String(currentUser?.username || '');
  const accountEmail = String(currentUser?.email || '');
  const profilePicture = String(currentUser?.profilePicture || 'default');
  const hasFaceOrPhoto = profilePicture.startsWith('bigsmile:')
    || (!profilePicture.startsWith('paper:') && Boolean(getAvatarSrc(profilePicture)));
  const [name, setName] = useState(savedName);
  const [username, setUsername] = useState(accountUsername);
  const [savedUsername, setSavedUsername] = useState(accountUsername);
  const [email, setEmail] = useState(accountEmail);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [regeneratingAvatar, setRegeneratingAvatar] = useState(false);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadPhotoButtonRef = useRef<HTMLButtonElement | null>(null);

  // Each field follows its own saved value. One Save writes the username
  // before the name, and the saved name falls back to the username, so a new
  // username would otherwise wipe a name typed in the same save. A name the
  // person has edited and not yet saved stays as typed.
  const nameEdited = useRef(false);
  useEffect(() => { if (!nameEdited.current) setName(savedName); }, [savedName]);
  useEffect(() => {
    setUsername(accountUsername);
    setSavedUsername(accountUsername);
  }, [accountUsername]);
  useEffect(() => { setEmail(accountEmail); }, [accountEmail]);

  // One Save for the form. The username goes first because it can be refused
  // (taken, or the wrong shape); a refusal stops before the name is written,
  // so the form never reports half a save as done.
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const nextName = name.trim();
    const nextUsername = username.trim().toLowerCase();
    const nameChanged = nextName !== savedName;
    const usernameChanged = nextUsername !== savedUsername.toLowerCase();
    if (!nameChanged && !usernameChanged) {
      setNotice('settings.account.noChanges');
      setError(null);
      return;
    }

    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = (requestError: unknown, fallback: string) => {
      const message = (requestError as { response?: { data?: { error?: string; msg?: string } } })?.response?.data;
      setError(message?.error || message?.msg || t(fallback));
    };
    try {
      if (usernameChanged) {
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
        } catch (requestError) {
          failure(requestError, 'settings.username.saveFailed');
          return;
        }
      }
      if (nameChanged) {
        try {
          await updateProfile({ displayName: nextName });
        } catch (requestError) {
          failure(requestError, 'settings.account.saveFailed');
          return;
        }
      }
      nameEdited.current = false;
      setNotice(nameChanged ? 'settings.account.saved' : 'settings.username.saved');
    } finally {
      setBusy(false);
    }
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
      setNotice('settings.avatar.regenerated');
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
      setNotice('settings.avatar.photoSaved');
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
            title={t('settings.account.changePhoto')}
            aria-label={t('settings.account.changePhoto')}
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
              title={t('settings.account.avatarOf', { name: name || accountName })}
            />
          </button>
          <span className="v2-settings__account-copy">
            <span className="v2-settings__account-name">{name || accountName}</span>
            <span className="v2-settings__meta">
              <span>@{savedUsername}</span> · {t(currentUser?.role === 'admin' ? 'settings.account.roleAdmin' : 'settings.account.roleMember')}
            </span>
          </span>
        </span>
        <span className="ac">
          <button
            type="button"
            className="v2p-b v2p-b-g v2p-ib v2p-b-sm"
            title={t('settings.account.editName')}
            aria-label={t('settings.account.editProfile')}
            aria-expanded={editing}
            aria-controls="v2-settings-profile-edit"
            onClick={() => setEditing((open) => !open)}
          >
            <Pencil />
          </button>
        </span>
      </div>
      <div className="v2p-lrow">
        <span className="lb"><Chat />{t('settings.account.email')}</span>
        <span className="vl"><span className="mo v2-settings__mail">{accountEmail || '—'}</span></span>
        <span className="ac">
          <button
            type="button"
            className="v2p-b v2p-b-g v2p-ib v2p-b-sm"
            title={t('settings.account.changeEmail')}
            aria-label={t('settings.account.editEmail')}
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
          <span>{t('settings.account.name')}</span>
          <input value={name} onChange={(event) => { nameEdited.current = true; setName(event.target.value); }} required maxLength={80} />
        </label>
        <label>
          <span>{t('settings.account.username')}</span>
          <div className="v2-settings__username-control">
            <input
              id="v2-settings-username"
              aria-label={t('settings.account.username')}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              minLength={2}
              maxLength={40}
              autoComplete="off"
              aria-describedby="v2-settings-username-help"
            />
          </div>
          <span className="v2-settings__field-help" id="v2-settings-username-help">
            {t('settings.username.help')}
          </span>
        </label>
        <div className="v2-settings__account-email">
          <label htmlFor="v2-settings-email">{t('settings.account.email')}</label>
          <div className="v2-settings__email-control">
            <input id="v2-settings-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <button className="v2p-b v2p-b-s v2p-b-sm" type="button">{t('settings.account.change')}</button>
          </div>
        </div>
      </div>
      {error && <p className="v2-settings__message v2-settings__message--error" role="alert">{error}</p>}
      {notice && <p className="v2-settings__message" role="status">{t(notice)}</p>}
      <div className="v2-settings__actions">
        <button className="v2p-b v2p-b-p" type="submit" disabled={busy}>{t(busy ? 'settings.account.saving' : 'settings.account.save')}</button>
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
  const { confirm, dialog: confirmDialog } = useV2Confirm();
  const [revokingSessions, setRevokingSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOutEverywhere = async () => {
    const confirmed = await confirm({
      message: t('settings.sessions.confirm'),
      confirmLabel: t('settings.sessions.signOutEverywhere'),
    });
    if (!confirmed) return;
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
        <span className="lb"><Warn />{t('settings.accountActions')}</span>
        <span className="vl" />
        <Chevron />
      </summary>
      <div className="v2-settings__fold-body">
        {confirmDialog}
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
  const { t } = useTranslation();
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
      setNotice('settings.apiToken.generated');
    } catch {
      setError(t('settings.apiToken.generateFailed'));
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
      setNotice('settings.apiToken.revoked');
    } catch {
      setError(t('settings.apiToken.revokeFailed'));
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setNotice('settings.apiToken.copied');
    } catch {
      setError(t('settings.apiToken.copyFailed'));
    }
  };

  const maskedToken = '••••••••••••••••••••••••••••••••';
  const createdLabel = createdAt ? formatTokenCreatedAt(createdAt, t) : null;

  const activeLabel = last4 ? t('settings.apiToken.activeEnding', { last4 }) : t('settings.apiToken.active');
  const statusLabel = hasToken ? activeLabel : t('settings.devices.none');

  return (
    <>
      <div className="v2p-lrow">
        <span className="lb"><Key />{t('settings.apiToken.title')}</span>
        <span className="vl"><span className="mu">{statusLabel}</span></span>
        <span className="ac">
          {hasToken ? (
            <>
              <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => void generate()} disabled={busy !== null}>
                {t(busy === 'generate' ? 'settings.apiToken.regenerating' : 'settings.apiToken.regenerate')}
              </button>
              <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => void revoke()} disabled={busy !== null}>
                {t(busy === 'revoke' ? 'settings.apiToken.revoking' : 'settings.devices.revoke')}
              </button>
            </>
          ) : (
            <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => void generate()} disabled={busy !== null}>
              {t(busy === 'generate' ? 'settings.apiToken.generating' : 'settings.apiToken.generate')}
            </button>
          )}
        </span>
      </div>
      {(error || notice || token) && (
        <div className="v2-settings__token-detail">
          {error && <p className="v2-settings__message v2-settings__message--error" role="alert">{error}</p>}
          {notice && <p className="v2-settings__message" role="status">{t(notice)}</p>}
          {token && (
            <>
              <div className="v2-settings__token-value">
                <code>{token && showToken ? token : maskedToken}</code>
                <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => setShowToken((visible) => !visible)}>
                  {t(showToken ? 'settings.apiToken.hide' : 'settings.apiToken.show')}
                </button>
                <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => void copy()}>{t('common.copy')}</button>
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
  const theme = useV2ThemePref();
  const chooseTheme = (pref: V2ThemePref) => setV2Theme(pref);

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

const V2AdminSection: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="v2-settings__admin-links">
      {ADMIN_LINKS.map((link) => (
        <Link key={link.to} className="v2-settings__admin-link" to={link.to}>
          <span className="v2-settings__admin-link-label">{t(`settings.admin.${link.key}`)}</span>
          <span className="v2-settings__admin-link-detail">{t(`settings.admin.${link.key}Detail`)}</span>
        </Link>
      ))}
    </div>
  );
};

const V2SettingsPage: React.FC = () => {
  const { currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="v2-settings" aria-label={t('common.nav.settings')}>
      <header className="v2p-ph"><h1>{t('common.nav.settings')}</h1></header>
      <div className="v2p-body v2-settings__layout">
        <div className="v2-settings__content">
          <SettingsSection id="account" title={t('settings.sections.account')}>
            <V2AccountSection />
            <V2BillingPanel />
          </SettingsSection>
          <SettingsSection id="access" title={t('settings.sections.access')}>
            <V2DevicesPanel showHeading={false} asFold />
            <V2ApiTokenSection />
            <Link className="v2p-lrow v2-settings__link" to="/v2/connectors">
              <span className="lb"><Plug />{t('common.nav.connectors')}</span>
              <span className="vl"><span className="mu">{t('settings.connectorsDetail')}</span></span>
              <span className="ac"><span className="v2p-b v2p-b-g v2p-ib v2p-b-sm" aria-hidden="true"><Next /></span></span>
            </Link>
            {developerAppsEnabled() && (
              <details className="v2-settings__developer-disclosure">
                <summary>{t('settings.developerApps')}</summary>
                <AppsManagement variant="settings" showIntegrations={false} />
              </details>
            )}
          </SettingsSection>
          <SettingsSection id="look" title={t('settings.sections.look')}><V2LanguageSection /></SettingsSection>
          <div className="v2p-list v2-settings__actions-list">
            {/* Phones have no rail, so Feedback's Guide entry isn't reachable there. */}
            <button
              type="button"
              className="v2p-lrow v2-settings__link v2-settings__guide"
              onClick={() => { if (!requestFirstRunGuide()) navigate('/v2'); }}
            >
              <span className="lb"><Book />{t('firstRun.reopen')}</span>
              <span className="vl" />
              <span className="ac"><span className="v2p-b v2p-b-g v2p-ib v2p-b-sm" aria-hidden="true"><Next /></span></span>
            </button>
            <V2AccountActions />
          </div>
          {isAdmin && (
            <SettingsSection id={ADMIN_SECTION_ID} title={t('settings.sections.admin')}><V2AdminSection /></SettingsSection>
          )}
        </div>
      </div>
    </div>
  );
};

export default V2SettingsPage;
