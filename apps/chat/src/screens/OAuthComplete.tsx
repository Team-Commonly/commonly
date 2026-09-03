import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useClient } from '../client';

/** The OAuth callback lands here with a one-time code; exchange it and move on. */
export function OAuthComplete() {
  const { client, session } = useClient();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get('code');
    if (!code) { setError('The sign-in link is missing its code.'); return; }
    client.auth.oauthExchange(code)
      .then(({ user }) => { session.setUser(user); navigate('/home', { replace: true }); })
      .catch(() => setError('That sign-in link has expired. Start again.'));
  }, [client, navigate, params, session]);

  return (
    <div className="content content--narrow stack">
      {error ? (
        <>
          <div className="alert alert--danger" role="alert">{error}</div>
          <Link to="/signin" className="btn">Back to sign in</Link>
        </>
      ) : <p className="meta">Signing you in…</p>}
    </div>
  );
}
