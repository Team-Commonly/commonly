import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import V2AuthBrand from './V2AuthBrand';
import { Trans, useTranslation } from 'react-i18next';

// Landing pad for the emailed reset link (/v2/reset-password?token=...).
// Token consumption is server-side; a used or expired token surfaces the
// backend's "Invalid or expired reset link" with a path back to /forgot.
const V2ResetPassword: React.FC = () => {
  const { t } = useTranslation();
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
      setError(t('auth.reset.errors.tooShort'));
      return;
    }
    if (password !== confirm) {
      setError(t('auth.reset.errors.mismatch'));
      return;
    }
    setSubmitting(true);
    try {
      await axios.post('/api/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      const e1 = err as { response?: { data?: { error?: string } } };
      setError(e1.response?.data?.error || t('auth.reset.errors.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="v2-login">
      <form className="v2-login__card" onSubmit={handleSubmit}>
        <V2AuthBrand />
        <h1 className="v2-login__title">{t('auth.reset.title')}</h1>
        {done ? (
          <>
            <p className="v2-login__subtitle">{t('auth.reset.updated')}</p>
            <Link to="/v2/login" className="v2-login__submit" style={{ textAlign: 'center', textDecoration: 'none', display: 'block' }}>
              {t('auth.reset.goToSignIn')}
            </Link>
          </>
        ) : !token ? (
          <>
            <p className="v2-login__subtitle">
              {t('auth.reset.missingToken')}
            </p>
            <div className="v2-login__hint">
              <Link to="/v2/forgot-password" className="v2-login__link">{t('auth.reset.sendNewLink')}</Link>
            </div>
          </>
        ) : (
          <>
            <label className="v2-login__field">
              <span className="v2-login__label">{t('auth.reset.newPassword')}</span>
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
              <span className="v2-login__label">{t('auth.reset.confirmPassword')}</span>
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
              {submitting ? t('auth.reset.updating') : t('auth.reset.submit')}
            </button>
            {error && (
              <div className="v2-login__error">
                {error}
                {' '}
                <Trans
                  i18nKey="auth.reset.requestNewLink"
                  components={{ request: <Link to="/v2/forgot-password" className="v2-login__link" /> }}
                />
              </div>
            )}
          </>
        )}
      </form>
    </div>
  );
};

export default V2ResetPassword;
