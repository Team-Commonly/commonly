import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';
import AppsManagement from '../../components/AppsManagement';
import V2BillingPanel from './V2BillingPanel';
import V2DevicesPanel from './V2DevicesPanel';
import V2Avatar from './V2Avatar';

type TokenStatus = {
  hasToken?: boolean;
  token?: string;
  createdAt?: string;
};

const LANGUAGE_OPTIONS = [
  { code: 'en' as const, label: 'English' },
  { code: 'zh-CN' as const, label: '中文' },
];

interface SettingsSectionProps {
  id: string;
  title: string;
  children: React.ReactNode;
}

const SETTINGS_SECTIONS = [
  { id: 'account', title: 'Account' },
  { id: 'plan', title: 'Plan' },
  { id: 'devices', title: 'Devices' },
  { id: 'api-token', title: 'API token' },
  { id: 'connected-apps', title: 'Connected apps' },
  { id: 'language', title: 'Language' },
] as const;

const settingsSectionId = (id: string) => `v2-settings-${id}`;

const SettingsSection: React.FC<SettingsSectionProps> = ({ id, title, children }) => (
  <section
    className="v2-settings__section"
    id={settingsSectionId(id)}
    aria-labelledby={`${settingsSectionId(id)}-label`}
  >
    <h2 className="v2-settings__label" id={`${settingsSectionId(id)}-label`}>{title}</h2>
    <div className="v2-settings__section-body">{children}</div>
  </section>
);

const V2AccountSection: React.FC = () => {
  const { currentUser, updateProfile } = useAuth();
  const accountName = String(currentUser?.displayName || currentUser?.username || 'Your account');
  const accountUsername = String(currentUser?.username || '');
  const accountEmail = String(currentUser?.email || '');
  const [name, setName] = useState(accountName);
  const [email, setEmail] = useState(accountEmail);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(accountName);
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

  return (
    <form className="v2-settings__account" onSubmit={save}>
      <div className="v2-settings__account-row">
        <V2Avatar
          className="v2-settings__avatar"
          name={name || accountName}
          src={currentUser?.profilePicture || undefined}
          seed={currentUser?._id || currentUser?.id}
          title={`${name || accountName} avatar`}
        />
        <div className="v2-settings__account-copy">
          <div className="v2-settings__account-name">{name || accountName}</div>
          <div className="v2-settings__meta">@{accountUsername}</div>
        </div>
        <div className="v2-settings__account-type">{currentUser?.role === 'admin' ? 'administrator' : 'member'}</div>
      </div>
      <div className="v2-settings__account-fields">
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
        </label>
        <label>
          <span>Username</span>
          <input value={accountUsername} readOnly aria-readonly="true" />
        </label>
        <div className="v2-settings__account-email">
          <label htmlFor="v2-settings-email">Email</label>
          <div className="v2-settings__email-control">
            <input id="v2-settings-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <button className="v2-settings__secondary" type="button">Change</button>
          </div>
        </div>
      </div>
      {error && <p className="v2-settings__message v2-settings__message--error" role="alert">{error}</p>}
      {notice && <p className="v2-settings__message" role="status">{notice}</p>}
      <div className="v2-settings__actions">
        <button className="v2-settings__primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
};

const V2ApiTokenSection: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState<'generate' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await axios.get<TokenStatus>('/api/auth/api-token');
        if (!active || !response.data?.hasToken) return;
        setToken(response.data.token || null);
        setCreatedAt(response.data.createdAt || null);
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
      setToken(response.data.apiToken || null);
      setCreatedAt(response.data.createdAt || null);
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
      setToken(null);
      setCreatedAt(null);
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

  return (
    <div className="v2-settings__token">
      {error && <p className="v2-settings__message v2-settings__message--error" role="alert">{error}</p>}
      {notice && <p className="v2-settings__message" role="status">{notice}</p>}
      {token ? (
        <>
          <div className="v2-settings__token-value">
            <code>{showToken ? token : maskedToken}</code>
            <button type="button" className="v2-settings__secondary" onClick={() => setShowToken((visible) => !visible)}>
              {showToken ? 'Hide' : 'Show'}
            </button>
            <button type="button" className="v2-settings__secondary" onClick={() => void copy()}>Copy</button>
          </div>
          {createdAt && <p className="v2-settings__meta">created {new Date(createdAt).toLocaleString()}</p>}
          <div className="v2-settings__actions">
            <button type="button" className="v2-settings__secondary" onClick={() => void generate()} disabled={busy !== null}>
              {busy === 'generate' ? 'Regenerating…' : 'Regenerate'}
            </button>
            <button type="button" className="v2-settings__secondary" onClick={() => void revoke()} disabled={busy !== null}>
              {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
            </button>
          </div>
        </>
      ) : (
        <div className="v2-settings__actions">
          <button type="button" className="v2-settings__primary" onClick={() => void generate()} disabled={busy !== null}>
            {busy === 'generate' ? 'Generating…' : 'Generate API token'}
          </button>
        </div>
      )}
    </div>
  );
};

const V2LanguageSection: React.FC = () => {
  const { i18n } = useTranslation();
  const active = i18n.resolvedLanguage || i18n.language || 'en';

  return (
    <div className="v2-settings__language" role="radiogroup" aria-label="Language">
      {LANGUAGE_OPTIONS.map((language) => (
        <button
          key={language.code}
          type="button"
          className={`v2-settings__language-option${active === language.code ? ' v2-settings__language-option--active' : ''}`}
          role="radio"
          aria-checked={active === language.code}
          onClick={() => void i18n.changeLanguage(language.code)}
        >
          {language.label}
        </button>
      ))}
    </div>
  );
};

const V2SettingsPage: React.FC = () => {
  const [activeSection, setActiveSection] = useState<string>('account');

  useEffect(() => {
    const syncActiveSection = () => {
      const matchingSection = SETTINGS_SECTIONS.find(({ id }) => `#${settingsSectionId(id)}` === window.location.hash);
      if (matchingSection) setActiveSection(matchingSection.id);
    };
    syncActiveSection();
    window.addEventListener('hashchange', syncActiveSection);
    return () => window.removeEventListener('hashchange', syncActiveSection);
  }, []);

  return (
    <div className="v2-settings" aria-label="Settings">
      <div className="v2-settings__layout">
        <h1 className="v2-settings__title">Settings</h1>
        <nav className="v2-settings__nav" aria-label="Settings sections">
          <div className="v2-settings__nav-list">
            {SETTINGS_SECTIONS.map(({ id, title }) => (
              <a
                key={id}
                className={`v2-settings__nav-link${activeSection === id ? ' v2-settings__nav-link--active' : ''}`}
                href={`#${settingsSectionId(id)}`}
                aria-current={activeSection === id ? 'location' : undefined}
                onClick={() => setActiveSection(id)}
              >
                {title}
              </a>
            ))}
          </div>
        </nav>
        <div className="v2-settings__content">
          <SettingsSection id="account" title="Account"><V2AccountSection /></SettingsSection>
          <SettingsSection id="plan" title="Plan"><V2BillingPanel showHeading={false} /></SettingsSection>
          <SettingsSection id="devices" title="Devices"><V2DevicesPanel showHeading={false} /></SettingsSection>
          <SettingsSection id="api-token" title="API token"><V2ApiTokenSection /></SettingsSection>
          <SettingsSection id="connected-apps" title="Connected apps"><AppsManagement variant="settings" /></SettingsSection>
          <SettingsSection id="language" title="Language"><V2LanguageSection /></SettingsSection>
        </div>
      </div>
    </div>
  );
};

export default V2SettingsPage;
