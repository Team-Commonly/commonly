import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, type OAuthProvider } from '@commonly/core';
import { useClient } from '../client';

/**
 * Sign in and sign up, ported from the old shell against the same endpoints.
 * Sign-up creates the workspace and a hosted agent server-side, so a new user
 * goes straight to Connect.
 */
export function SignIn({ mode }: { mode: 'signin' | 'signup' }) {
  const { client, session } = useClient();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;

  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [providers, setProviders] = useState<OAuthProvider[]>([]);

  useEffect(() => {
    client.auth.oauthProviders().then(setProviders).catch(() => setProviders([]));
  }, [client]);

  if (!session.loading && session.user) return <Navigate to={from || '/home'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === 'signup') {
        const reg = await client.auth.register({ username: username.trim(), email: email.trim(), password });
        if (reg.verificationRequired) {
          setNotice(reg.message);
        }
      }
      const { user } = await client.auth.login(email.trim(), password);
      session.setUser(user);
      navigate(mode === 'signup' ? '/connect' : (from || '/home'), { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const oauthReturn = `${window.location.origin}/oauth/complete`;

  return (
    <div className="content content--narrow stack stack--lg">
      <div className="stack">
        <h1 className="title">{mode === 'signup' ? 'Create your account' : 'Sign in'}</h1>
        <p className="meta">
          {mode === 'signup'
            ? 'Takes a minute. Your agent is ready the moment you connect a channel.'
            : 'Welcome back.'}
        </p>
      </div>

      {providers.length > 0 && (
        <div className="stack">
          {providers.map((p) => (
            <a key={p.id} className="btn btn--lg btn--block" href={client.auth.oauthStartUrl(p.id, oauthReturn)}>
              Continue with {p.name}
            </a>
          ))}
          <p className="meta" style={{ textAlign: 'center' }}>or with email</p>
        </div>
      )}

      <form className="stack" onSubmit={submit} noValidate>
        {mode === 'signup' && (
          <label className="field">
            <span>Username</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required />
        </label>
        {error && <div className="alert alert--danger" role="alert">{error}</div>}
        {notice && <div className="alert alert--success" role="status">{notice}</div>}
        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy ? 'One moment…' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <p className="meta">
        {mode === 'signup'
          ? <>Already have an account? <Link to="/signin">Sign in</Link></>
          : <>New here? <Link to="/signup">Create an account</Link></>}
      </p>
    </div>
  );
}
