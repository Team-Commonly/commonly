import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, Navigate, Link } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import V2OAuthButtons from './V2OAuthButtons';
import V2AuthBrand from './V2AuthBrand';
import { Trans, useTranslation } from 'react-i18next';

// v2-native sign-up. Pairs with V2Login (reuses the .v2-login styles) so the
// auth surfaces match after v2 became the default. Mirrors the legacy
// Register flow: honor the invite-only policy, POST /api/auth/register, then
// surface the backend's message and hand off to sign-in (the backend may send
// a verification email; it does not always return a usable session).
//
// The .v2-login__card class goes on the <form>/<div> directly (like V2Login) —
// a bare <form> picks up a dark global background, so it must carry the card.

interface RegistrationPolicy {
  loaded: boolean;
  inviteOnly: boolean;
}

const Brand: React.FC = () => (
  <V2AuthBrand />
);

const V2Register: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invitationCode, setInvitationCode] = useState(searchParams.get('invite') || '');
  // Deep-link context (e.g. a pod invite URL): thread through the whole
  // signup flow so the user lands back where the share link pointed.
  const rawNext = searchParams.get('next');
  const nextPath = rawNext && rawNext.startsWith('/') ? rawNext : undefined;
  const loginHref = nextPath ? `/v2/login?next=${encodeURIComponent(nextPath)}` : '/v2/login';
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [verifyPending, setVerifyPending] = useState(false);
  const [policy, setPolicy] = useState<RegistrationPolicy>({ loaded: false, inviteOnly: false });

  useEffect(() => {
    let active = true;
    axios.get('/api/auth/registration-policy')
      .then((res) => { if (active) setPolicy({ loaded: true, inviteOnly: Boolean(res.data?.inviteOnly) }); })
      .catch(() => { if (active) setPolicy({ loaded: true, inviteOnly: false }); });
    return () => { active = false; };
  }, []);

  const hasInviteFromUrl = useMemo(() => Boolean(searchParams.get('invite')), [searchParams]);

  if (policy.loaded && policy.inviteOnly && !hasInviteFromUrl) {
    return <Navigate to="/v2/register/invite-required" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await axios.post('/api/auth/register', {
        username: username.trim(),
        email: email.trim(),
        password,
        invitationCode: invitationCode.trim(),
      });
      const data = res.data as { message?: string };
      const message = data?.message || t('auth.register.success.ready');
      // The backend only sends a verification email (and withholds a usable
      // session) when SMTP is configured — its message says to check email in
      // that case. The login shell admits unverified users and keeps a
      // persistent verification reminder visible, so the success screen can
      // take them directly to sign-in without creating a dead end.
      setVerifyPending(message.toLowerCase().includes('check your email'));
      setDone(message);
    } catch (err) {
      const e1 = err as { response?: { data?: { error?: string; msg?: string } } };
      setError(e1.response?.data?.error || e1.response?.data?.msg || t('auth.register.errors.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="v2-login">
        <div className="v2-login__card">
          <Brand />
          <h1 className="v2-login__title">
            {verifyPending ? t('auth.register.success.checkEmailTitle') : t('auth.register.success.createdTitle')}
          </h1>
          <p className="v2-login__subtitle">
            {verifyPending ? t('auth.register.success.checkEmailMessage') : t('auth.register.success.ready')}
          </p>
          {verifyPending ? (
            <p className="v2-login__hint">
              <Trans
                i18nKey="auth.register.success.verifyThenSignIn"
                components={{ signIn: <Link to={loginHref} className="v2-login__link" /> }}
              />
            </p>
          ) : (
            <button
              type="button"
              className="v2-login__submit"
              onClick={() => navigate(loginHref)}
            >
              {t('auth.register.success.continue')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="v2-login">
      <form className="v2-login__card" onSubmit={handleSubmit}>
        <Brand />
        <h1 className="v2-login__title">{t('auth.register.title')}</h1>
        <p className="v2-login__subtitle">
          {t('auth.register.subtitle')}
        </p>

        <label className="v2-login__field">
          <span className="v2-login__label">{t('auth.fields.username')}</span>
          <input
            className="v2-login__input"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>

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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {/* With open registration the code is optional — it unlocks hosted
            (cloud) agents. Under invite-only the page already redirected
            unless a code arrived via the URL, so the field stays hidden. */}
        {policy.loaded && !policy.inviteOnly && (
          <label className="v2-login__field">
            <span className="v2-login__label">{t('auth.register.invitationCode')}</span>
            <input
              className="v2-login__input"
              type="text"
              autoComplete="off"
              placeholder={t('auth.register.invitationPlaceholder')}
              value={invitationCode}
              onChange={(e) => setInvitationCode(e.target.value)}
            />
            {/* The full explanation lives below the field, not in the
                placeholder — placeholders clip at the input's width. */}
            <span className="v2-login__field-hint">
              {t('auth.register.invitationHint')}
            </span>
          </label>
        )}

        <button
          type="submit"
          className="v2-login__submit"
          disabled={submitting}
        >
          {submitting ? t('auth.register.creating') : t('auth.register.submit')}
        </button>

        {error && <div className="v2-login__error">{error}</div>}

        <V2OAuthButtons invite={invitationCode || undefined} next={nextPath} />

        <div className="v2-login__hint">
          {t('auth.register.alreadyHaveAccount')}
          {' '}
          <Link to="/v2/login" className="v2-login__link">{t('auth.login.submit')}</Link>
        </div>
      </form>
    </div>
  );
};

export default V2Register;
