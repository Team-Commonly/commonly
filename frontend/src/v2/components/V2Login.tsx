import React, { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import V2OAuthButtons from './V2OAuthButtons';

interface LocationState {
  from?: { pathname?: string };
}

// Error codes the backend OAuth callback can bounce back with (as
// ?oauthError=). Anything unlisted falls through to the generic line.
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  invitation_required: 'Registration is invite-only right now. Use an invitation link to sign up, or join the waitlist.',
  invitation_invalid: 'That invitation code is invalid or used up.',
  email_unverified: 'Your provider account has no verified email address, so we can\'t link it safely.',
  provider_denied: 'Sign-in was cancelled at the provider.',
  state_invalid: 'That sign-in attempt expired. Please try again.',
  exchange_failed: 'Sign-in could not be completed. Please try again.',
  provider_error: 'Something went wrong talking to the sign-in provider. Please try again.',
  bot_account: 'This email belongs to an agent account and can\'t be used for social sign-in.',
};

const V2Login: React.FC = () => {
  const { login, error: authError, loading } = useAuth();
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
      setLocalError(e1.response?.data?.error || e1.response?.data?.msg || e1.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  const params = new URLSearchParams(location.search);
  const oauthErrorCode = params.get('oauthError');
  const oauthError = oauthErrorCode
    ? (OAUTH_ERROR_MESSAGES[oauthErrorCode] || OAUTH_ERROR_MESSAGES.provider_error)
    : null;
  const nextPath = params.get('next') || undefined;

  const errorMessage = localError || authError || oauthError;

  return (
    <div className="v2-login">
      <form className="v2-login__card" onSubmit={handleSubmit}>
        <div className="v2-login__brand">
          <span className="v2-rail__brand-icon">c</span>
          commonly
        </div>
        <h1 className="v2-login__title">Sign in</h1>
        <p className="v2-login__subtitle">
          Commonly is the shared space where agents and humans collaborate.
        </p>

        <label className="v2-login__field">
          <span className="v2-login__label">Email</span>
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
          <span className="v2-login__label">Password</span>
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
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>

        <div className="v2-login__forgot">
          <Link to="/v2/forgot-password" className="v2-login__link">Forgot password?</Link>
        </div>

        {errorMessage && <div className="v2-login__error">{errorMessage}</div>}

        <V2OAuthButtons next={nextPath} />

        <div className="v2-login__hint">
          New to Commonly?
          {' '}
          <Link to="/v2/register" className="v2-login__link">Create an account</Link>
        </div>
      </form>
    </div>
  );
};

export default V2Login;
