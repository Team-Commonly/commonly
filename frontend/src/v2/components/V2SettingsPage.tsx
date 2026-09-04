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
  label: string;
  children: React.ReactNode;
}

const SettingsSection: React.FC<SettingsSectionProps> = ({ label, children }) => (
  <section className="v2-settings__section" aria-labelledby={`v2-settings-${label.replace(/\s/g, '-')}`}>
    <h2 className="v2-settings__label" id={`v2-settings-${label.replace(/\s/g, '-')}`}>{label}</h2>
    <div className="v2-settings__section-body">{children}</div>
  </section>
);

const V2AccountSection: React.FC = () => {
  const { currentUser } = useAuth();
  const name = currentUser?.username || 'Your account';

  return (
    <div className="v2-settings__account-row">
      <V2Avatar
        className="v2-settings__avatar"
        name={name}
        src={currentUser?.profilePicture || undefined}
        seed={currentUser?._id || currentUser?.id}
        title={`${name} avatar`}
      />
      <div className="v2-settings__account-copy">
        <div className="v2-settings__account-name">{name}</div>
        {currentUser?.email && <div className="v2-settings__meta">{currentUser.email}</div>}
      </div>
      <div className="v2-settings__account-type">{currentUser?.role === 'admin' ? 'administrator' : 'member'}</div>
    </div>
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

const V2SettingsPage: React.FC = () => (
  <div className="v2-settings" aria-label="Settings">
    <header className="v2-settings__header">
      <h1>Settings</h1>
    </header>
    <div className="v2-settings__content">
      <SettingsSection label="account"><V2AccountSection /></SettingsSection>
      <SettingsSection label="plan"><V2BillingPanel /></SettingsSection>
      <SettingsSection label="devices"><V2DevicesPanel /></SettingsSection>
      <SettingsSection label="api token"><V2ApiTokenSection /></SettingsSection>
      <SettingsSection label="connected apps"><AppsManagement variant="settings" /></SettingsSection>
      <SettingsSection label="language"><V2LanguageSection /></SettingsSection>
    </div>
  </div>
);

export default V2SettingsPage;
