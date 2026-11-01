import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';

const V2DeleteAccount: React.FC = () => {
  const { logout } = useAuth();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauthRequired, setReauthRequired] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const pending = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) confirmationRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (passwordRequired && !busy) passwordRef.current?.focus();
  }, [passwordRequired, busy]);

  const cancel = () => {
    setOpen(false);
    setPassword('');
    setConfirmation('');
    setError(null);
    setReauthRequired(false);
    setPasswordRequired(false);
    triggerRef.current?.focus();
  };

  const remove = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || confirmation !== 'DELETE' || (passwordRequired && !password)) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setReauthRequired(false);
    try {
      await axios.delete('/api/users/me', {
        data: { confirmation: 'DELETE', ...(password ? { password } : {}) },
      });
    } catch (requestError) {
      const data = (requestError as { response?: { data?: { code?: string; error?: string } } })?.response?.data;
      setError(data?.error || t('settings.deleteAccount.failed'));
      setReauthRequired(data?.code === 'REAUTH_REQUIRED');
      if (data?.code === 'PASSWORD_REQUIRED') {
        setPasswordRequired(true);
      }
      return;
    } finally {
      pending.current = false;
      setBusy(false);
    }
    setPassword('');
    logout();
  };

  return (
    <div className="v2-settings__developer-disclosure">
      <button
        ref={triggerRef}
        type="button"
        className="v2p-b v2p-b-s v2p-b-sm"
        aria-expanded={open}
        aria-controls="v2-delete-account"
        onClick={() => { if (!open) setOpen(true); }}
        aria-disabled={open}
      >
        {t('settings.deleteAccount.title')}
      </button>
      {open && (
        <form
          id="v2-delete-account"
          className="v2-settings__account"
          aria-label={t('settings.deleteAccount.title')}
          onSubmit={(event) => { void remove(event); }}
        >
          <p className="v2-settings__message" id="v2-delete-account-effects">{t('settings.deleteAccount.effects')}</p>
          <div className="v2-settings__account-fields">
            <label>
              <span>{t('settings.deleteAccount.password')}</span>
              <input
                ref={passwordRef}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => { setPassword(event.target.value); setError(null); }}
                required={passwordRequired}
                disabled={busy}
              />
            </label>
            <label>
              <span>{t('settings.deleteAccount.confirmation')}</span>
              <input
                ref={confirmationRef}
                autoComplete="off"
                spellCheck={false}
                value={confirmation}
                onChange={(event) => { setConfirmation(event.target.value); setError(null); }}
                aria-describedby="v2-delete-account-effects"
                required
                pattern="DELETE"
                disabled={busy}
              />
            </label>
          </div>
          <p className="v2-settings__message">{t('settings.deleteAccount.oauthHint')}</p>
          {error && <p className="v2-settings__message v2-settings__message--error" role="alert">{error}</p>}
          {reauthRequired && (
            <p className="v2-settings__message">
              <Link className="v2-login__link" to="/v2/login?next=/v2/settings">{t('settings.deleteAccount.signInAgain')}</Link>
            </p>
          )}
          <div className="v2-settings__actions">
            <button
              type="submit"
              className="v2p-b v2p-b-p"
              disabled={busy || confirmation !== 'DELETE' || (passwordRequired && !password)}
            >
              {t(busy ? 'settings.deleteAccount.deleting' : 'settings.deleteAccount.confirm')}
            </button>
            <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={cancel} disabled={busy}>
              {t('settings.deleteAccount.cancel')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

export default V2DeleteAccount;
