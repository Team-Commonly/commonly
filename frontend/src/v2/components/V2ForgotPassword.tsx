import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import V2AuthBrand from './V2AuthBrand';
import V2AuthNotice from './V2AuthNotice';
import { Trans, useTranslation } from 'react-i18next';

// Forgot-password request form. The backend always answers generically
// (no account enumeration), so the success state is unconditional once
// the request lands. Layout: the d215 forgot-password frames. The
// instructions are the page's one prose line; after sending, the form goes and
// one status row says so.
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
      <form className="v2-login__card v2-login__card--stack" onSubmit={handleSubmit}>
        <V2AuthBrand />
        <h1 className="v2-login__title">{t('auth.forgot.title')}</h1>
        {done ? (
          <>
            <V2AuthNotice kind="status">{t('auth.forgot.sent')}</V2AuthNotice>
            <p className="v2-login__alt">
              <Trans
                i18nKey="auth.forgot.backToSignIn"
                components={{ signIn: <Link to="/v2/login" className="v2-login__link" /> }}
              />
            </p>
          </>
        ) : (
          <>
            <p className="v2-login__subtitle">
              {t('auth.forgot.instructions')}
            </p>
            {error && <V2AuthNotice>{error}</V2AuthNotice>}
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
            <p className="v2-login__alt">
              <Trans
                i18nKey="auth.forgot.remembered"
                components={{ signIn: <Link to="/v2/login" className="v2-login__link" /> }}
              />
            </p>
          </>
        )}
      </form>
    </div>
  );
};

export default V2ForgotPassword;
