import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

interface LocationState {
  from?: { pathname?: string };
}

const V2Login: React.FC = () => {
  const { login, error: authError, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('dev@commonly.local');
  const [password, setPassword] = useState('password123');
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

  const errorMessage = localError || authError;

  return (
    <div className="v2-login">
      <form className="v2-login__card" onSubmit={handleSubmit}>
        <div className="v2-login__brand">
          <span className="v2-rail__brand-icon">c</span>
          commonly
        </div>
        <h1 className="v2-login__title">Sign in to v2</h1>
        <p className="v2-login__subtitle">
          Use your Commonly credentials. v2 is a preview build that runs alongside the existing app.
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

        {errorMessage && <div className="v2-login__error">{errorMessage}</div>}

        <div className="v2-login__hint">
          Local dev login is seeded automatically. Default:
          {' '}
          <code>dev@commonly.local</code>
          {' / '}
          <code>password123</code>
        </div>
      </form>
    </div>
  );
};

export default V2Login;
