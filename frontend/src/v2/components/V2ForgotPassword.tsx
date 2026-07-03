import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from '../../utils/axiosConfig';

// Forgot-password request form. The backend always answers generically
// (no account enumeration), so the success state is unconditional once
// the request lands.
const V2ForgotPassword: React.FC = () => {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await axios.post('/api/auth/forgot-password', { email: email.trim() });
      setDone(true);
    } catch (err) {
      const e1 = err as { response?: { data?: { message?: string; error?: string } } };
      setError(e1.response?.data?.error || e1.response?.data?.message || 'Something went wrong — try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="v2-login">
      <form className="v2-login__card" onSubmit={handleSubmit}>
        <div className="v2-login__brand">
          <span className="v2-rail__brand-icon">c</span>
          commonly
        </div>
        <h1 className="v2-login__title">Reset your password</h1>
        {done ? (
          <>
            <p className="v2-login__subtitle">
              If that email has an account, a reset link is on its way. The link
              is valid for one hour.
            </p>
            <div className="v2-login__hint">
              Back to <Link to="/v2/login" className="v2-login__link">sign in</Link>
            </div>
          </>
        ) : (
          <>
            <p className="v2-login__subtitle">
              Enter your account email and we&apos;ll send you a reset link. If you
              signed up with Google or GitHub, you can also just sign in with them.
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
            <button type="submit" className="v2-login__submit" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
            {error && <div className="v2-login__error">{error}</div>}
            <div className="v2-login__hint">
              Remembered it? <Link to="/v2/login" className="v2-login__link">Sign in</Link>
            </div>
          </>
        )}
      </form>
    </div>
  );
};

export default V2ForgotPassword;
