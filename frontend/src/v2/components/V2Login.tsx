import React, { useEffect, useId, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from 'react-i18next';
import V2OAuthButtons from './V2OAuthButtons';
import V2AuthBrand from './V2AuthBrand';
import { pathOfLocation, safeNextPath } from '../utils/safeNextPath';
import { forgetInviteOAuthStart } from '../utils/pendingInvite';
import { ShellGlyph } from '../icons/glyphs';

interface LocationState {
  from?: { pathname?: string; search?: string; hash?: string };
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
  team_only: 'auth.login.oauthErrors.teamOnly',
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
  const passwordId = useId();

  // Where to land after sign-in, the same for password and OAuth: ?next= (the
  // invite redirect), else the page ProtectedRoute sent them from, with its
  // query and hash. A deep link like /v2/agents/byo?mode=hosted (the
  // re-engagement email's one link) used to lose its query on the password
  // path and everything on the OAuth path. Same-origin paths only.
  const destination = safeNextPath(new URLSearchParams(location.search).get('next'))
    || pathOfLocation((location.state as LocationState | null)?.from);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      navigate(destination || '/v2', { replace: true });
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

  useEffect(() => {
    // Provider-side failures redirect here without reaching V2OAuthComplete.
    // Keep the invite for a retry, but make sure a later ordinary login cannot
    // be mistaken for the failed invite-bearing signup.
    if (oauthErrorCode) forgetInviteOAuthStart();
  }, [oauthErrorCode]);

  const errorMessage = localError || authError || oauthError;

  // Only a failed password sign-in marks the fields; a provider error is about
  // the provider, not what was typed.
  const fieldsBad = Boolean(localError) || undefined;

  // Order follows the d215 signin frame: providers, "or", the email form, then
  // one line to sign up. Errors sit at the top, under the title.
  return (
    <div className="v2-login">
      <form className="v2-login__card v2-login__card--stack" onSubmit={handleSubmit}>
        <V2AuthBrand />
        <h1 className="v2-login__title">{t('auth.login.title')}</h1>

        {errorMessage && (
          <div className="v2-login__error" role="alert">
            <ShellGlyph name="alert" />
            <span>{errorMessage}</span>
          </div>
        )}

        <V2OAuthButtons next={destination || undefined} separator="after" />

        <label className="v2-login__field">
          <span className="v2-login__label">{t('auth.fields.email')}</span>
          <input
            className="v2-login__input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={fieldsBad}
            required
          />
        </label>

        {/* Not a <label> wrapper: the row holds a link, and a link inside a
            label would also focus the field. */}
        <div className="v2-login__field">
          <div className="v2-login__label-row">
            <label className="v2-login__label" htmlFor={passwordId}>{t('auth.fields.password')}</label>
            <Link to="/v2/forgot-password" className="v2-login__link">{t('auth.login.forgotPassword')}</Link>
          </div>
          <input
            id={passwordId}
            className="v2-login__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={fieldsBad}
            required
          />
        </div>

        <button
          type="submit"
          className="v2-login__submit"
          disabled={submitting || loading}
        >
          {submitting ? t('auth.login.signingIn') : t('auth.login.submit')}
        </button>

        <p className="v2-login__alt">
          {t('auth.login.newToCommonly')}
          {' '}
          <Link to="/v2/register" className="v2-login__link">{t('auth.login.createAccount')}</Link>
        </p>
      </form>
    </div>
  );
};

export default V2Login;
