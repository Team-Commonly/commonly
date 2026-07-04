import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import V2AuthBrand from './V2AuthBrand';

// Landing pad for the emailed reset link (/v2/reset-password?token=...).
// Token consumption is server-side; a used or expired token surfaces the
// backend's "Invalid or expired reset link" with a path back to /forgot.
const V2ResetPassword: React.FC = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await axios.post('/api/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      const e1 = err as { response?: { data?: { error?: string } } };
      setError(e1.response?.data?.error || 'Reset failed — the link may have expired.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="v2-login">
      <form className="v2-login__card" onSubmit={handleSubmit}>
        <V2AuthBrand />
        <h1 className="v2-login__title">Choose a new password</h1>
        {done ? (
          <>
            <p className="v2-login__subtitle">Password updated. You can sign in now.</p>
            <Link to="/v2/login" className="v2-login__submit" style={{ textAlign: 'center', textDecoration: 'none', display: 'block' }}>
              Go to sign in
            </Link>
          </>
        ) : !token ? (
          <>
            <p className="v2-login__subtitle">
              This page needs the reset link from your email. Request a new one below.
            </p>
            <div className="v2-login__hint">
              <Link to="/v2/forgot-password" className="v2-login__link">Send me a reset link</Link>
            </div>
          </>
        ) : (
          <>
            <label className="v2-login__field">
              <span className="v2-login__label">New password</span>
              <input
                className="v2-login__input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <label className="v2-login__field">
              <span className="v2-login__label">Confirm password</span>
              <input
                className="v2-login__input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </label>
            <button type="submit" className="v2-login__submit" disabled={submitting}>
              {submitting ? 'Updating…' : 'Update password'}
            </button>
            {error && (
              <div className="v2-login__error">
                {error}
                {' '}
                <Link to="/v2/forgot-password" className="v2-login__link">Request a new link</Link>
              </div>
            )}
          </>
        )}
      </form>
    </div>
  );
};

export default V2ResetPassword;
