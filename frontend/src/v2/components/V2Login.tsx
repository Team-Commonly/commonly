import React, { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from 'react-i18next';
import V2OAuthButtons from './V2OAuthButtons';
import V2AuthBrand from './V2AuthBrand';

interface LocationState {
  from?: { pathname?: string };
}

// Error codes the backend OAuth callback can bounce back with (as
// ?oauthError=). Anything unlisted falls through to the generic line.
const OAUTH_ERROR_KEYS: Record<string, string> = {
  invitation_required: 'auth.login.oauthErrors.invitationRequired',
  invitation_invalid: 'auth.login.oauthErrors.invitationInvalid',
  email_unverified: 'auth.login.oauthErrors.emailUnverified',
  provider_denied: 'auth.login.oauthErrors.providerDenied',
  state_invalid: 'auth.login.oauthErrors.stateInvalid',
  exchange_failed: 'auth.login.oauthErrors.exchangeFailed',
  provider_error: 'auth.login.oauthErrors.providerError',
  bot_account: 'auth.login.oauthErrors.botAccount',
};

const V2Login: React.FC = () => {
  const { login, error: authError, loading } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      // Resolve post-login destination. Priority: `?next=<url>` query
      // param (used by /v2/invite/:token redirect when anonymous) →
      // location.state.from (set by ProtectedRoute) → /v2 home. The
      // query-string path is required so deep links survive a full page
      // reload — location.state is lost on hard navigation.
      const params = new URLSearchParams(location.search);
      const next = params.get('next');
      const fallback = (location.state as LocationState | null)?.from?.pathname || '/v2';
      const dest = next && next.startsWith('/') ? next : fallback;
      navigate(dest, { replace: true });
    } catch (err) {
      const e1 = err as { response?: { data?: { error?: string; msg?: string } }; message?: string };
      setLocalError(e1.response?.data?.error || e1.response?.data?.msg || e1.message || t('auth.login.errors.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const params = new URLSearchParams(location.search);
  const oauthErrorCode = params.get('oauthError');
  const oauthError = oauthErrorCode
    ? t(OAUTH_ERROR_KEYS[oauthErrorCode] || OAUTH_ERROR_KEYS.provider_error)
    : null;
  const nextPath = params.get('next') || undefined;

  const errorMessage = localError || authError || oauthError;

  return (
    <div className="v2-login">
      <form className="v2-login__card" onSubmit={handleSubmit}>
        <V2AuthBrand />
        <h1 className="v2-login__title">{t('auth.login.title')}</h1>
        <p className="v2-login__subtitle">
          {t('auth.login.subtitle')}
        </p>

        <label className="v2-login__field">
          <span className="v2-login__label">{t('auth.fields.email')}</span>
          <input
            className="v2-login__input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label className="v2-login__field">
          <span className="v2-login__label">{t('auth.fields.password')}</span>
          <input
            className="v2-login__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        <button
          type="submit"
          className="v2-login__submit"
          disabled={submitting || loading}
        >
          {submitting ? t('auth.login.signingIn') : t('auth.login.submit')}
        </button>

        <div className="v2-login__forgot">
          <Link to="/v2/forgot-password" className="v2-login__link">{t('auth.login.forgotPassword')}</Link>
        </div>

        {errorMessage && <div className="v2-login__error" role="alert">{errorMessage}</div>}

        <V2OAuthButtons next={nextPath} />

        <div className="v2-login__hint">
          {t('auth.login.newToCommonly')}
          {' '}
          <Link to="/v2/register" className="v2-login__link">{t('auth.login.createAccount')}</Link>
        </div>

        {/* LICENSE REQUIREMENT, not decoration: the bigSmile avatar style is
            CC BY 4.0 and its terms require visible attribution. If avatar
            styles change, this line and the license re-check move together —
            see the character-tier note in v2/utils/avatars.ts. */}
        <div className="v2-login__hint" style={{ fontSize: 11, opacity: 0.7 }}>
          {'Avatars: '}
          <a className="v2-login__link" href="https://www.dicebear.com" target="_blank" rel="noreferrer">DiceBear</a>
          {' — “Big Smile” (CC BY 4.0)'}
        </div>
      </form>
    </div>
  );
};

export default V2Login;
