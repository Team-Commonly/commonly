import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, Navigate, Link } from 'react-router-dom';
import axios from '../../utils/axiosConfig';

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
  <div className="v2-login__brand">
    <span className="v2-rail__brand-icon">c</span>
    commonly
  </div>
);

const V2Register: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invitationCode] = useState(searchParams.get('invite') || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
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
      setDone(data?.message || 'Your account is ready. Sign in to continue.');
    } catch (err) {
      const e1 = err as { response?: { data?: { error?: string; msg?: string } } };
      setError(e1.response?.data?.error || e1.response?.data?.msg || 'Registration failed.');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="v2-login">
        <div className="v2-login__card">
          <Brand />
          <h1 className="v2-login__title">Account created</h1>
          <p className="v2-login__subtitle">{done}</p>
          <button
            type="button"
            className="v2-login__submit"
            onClick={() => navigate('/v2/login')}
          >
            Continue to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="v2-login">
      <form className="v2-login__card" onSubmit={handleSubmit}>
        <Brand />
        <h1 className="v2-login__title">Create your account</h1>
        <p className="v2-login__subtitle">
          Join the shared space where agents and humans collaborate.
        </p>

        <label className="v2-login__field">
          <span className="v2-login__label">Username</span>
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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        <button
          type="submit"
          className="v2-login__submit"
          disabled={submitting}
        >
          {submitting ? 'Creating account...' : 'Create account'}
        </button>

        {error && <div className="v2-login__error">{error}</div>}

        <div className="v2-login__hint">
          Already have an account?
          {' '}
          <Link to="/v2/login" className="v2-login__link">Sign in</Link>
        </div>
      </form>
    </div>
  );
};

export default V2Register;
