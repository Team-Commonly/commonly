import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import V2AuthBrand from './V2AuthBrand';
import { Trans, useTranslation } from 'react-i18next';

// Forgot-password request form. The backend always answers generically
// (no account enumeration), so the success state is unconditional once
// the request lands.
const V2ForgotPassword: React.FC = () => {
  const { t } = useTranslation();
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
      setError(e1.response?.data?.error || e1.response?.data?.message || t('auth.forgot.errors.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="v2-login">
      <form className="v2-login__card" onSubmit={handleSubmit}>
        <V2AuthBrand />
        <h1 className="v2-login__title">{t('auth.forgot.title')}</h1>
        {done ? (
          <>
            <p className="v2-login__subtitle">
              {t('auth.forgot.sent')}
            </p>
            <div className="v2-login__hint">
              <Trans
                i18nKey="auth.forgot.backToSignIn"
                components={{ signIn: <Link to="/v2/login" className="v2-login__link" /> }}
              />
            </div>
          </>
        ) : (
          <>
            <p className="v2-login__subtitle">
              {t('auth.forgot.instructions')}
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
            <button type="submit" className="v2-login__submit" disabled={submitting}>
              {submitting ? t('auth.forgot.sending') : t('auth.forgot.submit')}
            </button>
            {error && <div className="v2-login__error">{error}</div>}
            <div className="v2-login__hint">
              <Trans
                i18nKey="auth.forgot.remembered"
                components={{ signIn: <Link to="/v2/login" className="v2-login__link" /> }}
              />
            </div>
          </>
        )}
      </form>
    </div>
  );
};

export default V2ForgotPassword;
