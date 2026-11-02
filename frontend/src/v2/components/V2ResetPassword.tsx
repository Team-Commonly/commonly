import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import V2AuthBrand from './V2AuthBrand';
import V2AuthNotice from './V2AuthNotice';
import { Trans, useTranslation } from 'react-i18next';

// Landing pad for the emailed reset link (/v2/reset-password?token=...).
// Token consumption is server-side; a used or expired token surfaces the
// backend's "Invalid or expired reset link" with a path back to /forgot.
// Layout: the d215 new-password frames. A check the page makes itself (too
// short, mismatch) rings both fields; a server failure carries its recovery
// link inside the alert and leaves the fields alone.
const V2ResetPassword: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldsBad, setFieldsBad] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldsBad(false);
    if (password.length < 8) {
      setError(t('auth.reset.errors.tooShort'));
      setFieldsBad(true);
      return;
    }
    if (password !== confirm) {
      setError(t('auth.reset.errors.mismatch'));
      setFieldsBad(true);
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

  const marked = fieldsBad || undefined;

  return (
    <div className="v2-login">
      <form className="v2-login__card v2-login__card--stack" onSubmit={handleSubmit}>
        <V2AuthBrand />
        <h1 className="v2-login__title">{t('auth.reset.title')}</h1>
        {done ? (
          <>
            <V2AuthNotice kind="status">{t('auth.reset.updated')}</V2AuthNotice>
            <button type="button" className="v2-login__submit" onClick={() => navigate('/v2/login')}>
              {t('auth.reset.goToSignIn')}
            </button>
          </>
        ) : !token ? (
          <>
            <p className="v2-login__subtitle">
              {t('auth.reset.missingToken')}
            </p>
            <button type="button" className="v2-login__submit" onClick={() => navigate('/v2/forgot-password')}>
              {t('auth.reset.sendNewLink')}
            </button>
          </>
        ) : (
          <>
            {error && (
              <V2AuthNotice>
                {error}
                {!fieldsBad && (
                  <>
                    {' '}
                    <Trans
                      i18nKey="auth.reset.requestNewLink"
                      components={{ request: <Link to="/v2/forgot-password" className="v2-login__link" /> }}
                    />
                  </>
                )}
              </V2AuthNotice>
            )}
            <label className="v2-login__field">
              <span className="v2-login__label">{t('auth.reset.newPassword')}</span>
              <input
                className="v2-login__input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={marked}
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
                aria-invalid={marked}
                required
              />
            </label>
            <button type="submit" className="v2-login__submit" disabled={submitting}>
              {submitting ? t('auth.reset.updating') : t('auth.reset.submit')}
            </button>
          </>
        )}
      </form>
    </div>
  );
};

export default V2ResetPassword;
