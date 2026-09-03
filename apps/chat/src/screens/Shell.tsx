import { Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useClient } from '../client';

/** The tint step: a thin bar on the shell ground, then the content as one inset white card. */
export function Shell({ children }: { children: ReactNode }) {
  const { client, session } = useClient();
  const navigate = useNavigate();
  const signOut = async () => { await client.auth.signOut(); navigate('/'); };
  return (
    <div className="shell">
      <header className="shell__bar">
        <Link to={session.user ? '/home' : '/'} className="shell__brand" aria-label="Commonly home">
          <span className="shell__brand-mark" aria-hidden="true" />
          Commonly
        </Link>
        <nav className="shell__nav" aria-label="Account">
          {session.user ? (
            <>
              <Link to="/connect">Channels</Link>
              <button type="button" className="btn btn--link btn--sm" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <Link to="/signin">Sign in</Link>
          )}
        </nav>
      </header>
      <main className="card">{children}</main>
    </div>
  );
}
