import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useClient } from './client';
import { Shell } from './screens/Shell';
import { Landing } from './screens/Landing';
import { SignIn } from './screens/SignIn';
import { Connect } from './screens/Connect';
import { Home } from './screens/Home';
import { OAuthComplete } from './screens/OAuthComplete';

/** Three screens and the auth flows that get a stranger to them. Nothing else. */
export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/signin" element={<SignIn mode="signin" />} />
        <Route path="/signup" element={<SignIn mode="signup" />} />
        <Route path="/oauth/complete" element={<OAuthComplete />} />
        <Route path="/connect" element={<RequireUser><Connect /></RequireUser>} />
        <Route path="/home" element={<RequireUser><Home /></RequireUser>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function RequireUser({ children }: { children: JSX.Element }) {
  const { session } = useClient();
  const location = useLocation();
  if (session.loading) return <div className="content"><p className="meta">Loading…</p></div>;
  if (!session.user) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  return children;
}
