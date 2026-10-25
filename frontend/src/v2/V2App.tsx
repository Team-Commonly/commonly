import React from 'react';
import { Routes, Route, Navigate, useLocation, useMatch, useParams } from 'react-router-dom';
import V2Layout from './components/V2Layout';
import V2FeaturePage from './components/V2FeaturePage';
import { useAuth } from '../context/AuthContext';
import { useTimeZoneCapture } from './hooks/useTimeZoneCapture';
import RegistrationInviteRequired from '../components/RegistrationInviteRequired';
import VerifyEmail from '../components/VerifyEmail';
import DiscordCallback from '../components/DiscordCallback';
import V2EmailVerificationBanner from './components/V2EmailVerificationBanner';
import ProtectedRoute from '../components/ProtectedRoute';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/500.css';
import './v2.css';

// TASK-145 — inside the shell, only the surfaces the composer path needs stay
// in this chunk (V2Layout, the auth gate, the feature frame). Everything else
// is a route of its own: the chat first screen used to wait for the board, the
// connectors catalogue, every admin page and the artifacts browser because they
// were all one module graph with it. The Suspense boundary in V2App covers the
// whole route table, so a chunk in flight shows the same <V2Boot/> the auth
// check already shows.
const V2Login = React.lazy(() => import('./components/V2Login'));
const V2Register = React.lazy(() => import('./components/V2Register'));
const V2OAuthComplete = React.lazy(() => import('./components/V2OAuthComplete'));
const V2ForgotPassword = React.lazy(() => import('./components/V2ForgotPassword'));
const V2ResetPassword = React.lazy(() => import('./components/V2ResetPassword'));
const V2YourTeamPage = React.lazy(() => import('./components/V2YourTeamPage'));
const V2InviteRedeem = React.lazy(() => import('./components/V2InviteRedeem'));
const V2CommunityRedirect = React.lazy(() => import('./components/V2CommunityRedirect'));
const V2SettingsPage = React.lazy(() => import('./components/V2SettingsPage'));
const V2AgentProfile = React.lazy(() => import('./agents/V2AgentProfile'));
const V2AgentSettingsPage = React.lazy(() => import('./agents/V2AgentSettingsPage'));
const UserProfile = React.lazy(() => import('../components/UserProfile'));
const V2AgentBYO = React.lazy(() => import('./components/V2AgentBYO'));
const V2ConnectPage = React.lazy(() => import('./components/V2ConnectPage'));
const V2ConnectorsPage = React.lazy(() => import('./components/V2ConnectorsPage'));
const V2PodBoard = React.lazy(() => import('./components/V2PodBoard'));
const V2RunTrace = React.lazy(() => import('./components/V2RunTrace'));
const V2ActivityPage = React.lazy(() => import('./components/V2ActivityPage'));
const V2ArtifactsPage = React.lazy(() => import('./components/V2ArtifactsPage'));
const ChatRoom = React.lazy(() => import('../components/ChatRoom'));
const ApiDevPage = React.lazy(() => import('../components/ApiDevPage'));
const PodContextDevPage = React.lazy(() => import('../components/PodContextDevPage'));
const GlobalIntegrations = React.lazy(() => import('../components/admin/GlobalIntegrations'));
const V2AdminUsers = React.lazy(() => import('./components/V2AdminUsers'));
const V2AdminAnalytics = React.lazy(() => import('./components/V2AdminAnalytics'));

class V2ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('V2 runtime error:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="v2-empty">
          <div className="v2-empty__title">Something went wrong</div>
          <div className="v2-empty__text">{this.state.error.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

// This is inline rather than an <img> so the mark's existing three dots can
// use the product typing rhythm. Its geometry matches the canonical minimal
// mark in frontend/design-system/assets/commonly-mark.svg: one C ring, then
// dots at x=25/32/39 with r=2.4 in a 64px viewBox.
const V2Boot: React.FC = () => (
  <div className="v2-boot" role="status" aria-label="Loading Commonly">
    <svg className="v2-boot__mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path
        d="M 50 17.7 A 22 22 0 1 0 50 46.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <circle className="v2-boot__mark-dot" cx="25" cy="32" r="2.4" fill="currentColor" />
      <circle className="v2-boot__mark-dot" cx="32" cy="32" r="2.4" fill="currentColor" />
      <circle className="v2-boot__mark-dot" cx="39" cy="32" r="2.4" fill="currentColor" />
    </svg>
  </div>
);

const V2AuthenticatedShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="v2-authenticated-shell">
    <V2EmailVerificationBanner />
    <div className="v2-authenticated-shell__content">{children}</div>
  </div>
);

const V2RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <V2Boot />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/v2/login" state={{ from: location }} replace />;
  }

  return <V2AuthenticatedShell>{children}</V2AuthenticatedShell>;
};

// One gate owns both `/v2` and `/v2/pods/:podId`, so auto-selection changes
// the URL without remounting the shell. Other deep routes stay behind
// V2RequireAuth (the `*` branch below).
const V2PodShellGate: React.FC = () => {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();
  const podRoute = useMatch('/v2/pods/:podId');

  if (loading) {
    return <V2Boot />;
  }

  if (!isAuthenticated) {
    return location.pathname === '/v2' || location.pathname === '/v2/'
      ? <Navigate to="/" replace />
      : <Navigate to="/v2/login" state={{ from: location }} replace />;
  }

  // Reject legacy pod-type paths before mounting V2Layout, which otherwise
  // remembers the type name as the last selected pod.
  if (podRoute?.params.podId && podTypeRoutes.has(podRoute.params.podId)) {
    return <Navigate to="/v2" replace />;
  }

  return <V2AuthenticatedShell><V2Layout /></V2AuthenticatedShell>;
};

const podTypeRoutes = new Set(['chat', 'study', 'games', 'gaming', 'agent-admin', 'agent-room']);

const V2UseCaseRedirect: React.FC = () => {
  const { useCaseId } = useParams<{ useCaseId: string }>();
  return <Navigate to={useCaseId ? `/use-cases/${encodeURIComponent(useCaseId)}/` : '/'} replace />;
};

const feature = (
  title: string,
  children: React.ReactNode,
  showPodsSidebar = false,
  showHeader = true,
  className = '',
) => (
  <V2FeaturePage
    title={title}
    showPodsSidebar={showPodsSidebar}
    showHeader={showHeader}
    className={className}
  >
    {children}
  </V2FeaturePage>
);

const V2LegacyChatRedirect: React.FC = () => {
  const { podId } = useParams<{ podId: string }>();
  return <Navigate to={podId ? `/v2/pods/chat/${podId}` : '/v2'} replace />;
};

const V2App: React.FC = () => {
  // The daily digest's 08:00 is the person's own (TASK-257 Phase 2b).
  useTimeZoneCapture();
  React.useEffect(() => {
    try {
      sessionStorage.setItem('commonly.v2.active', '1');
    } catch {
      // Ignore browsers that disallow sessionStorage.
    }
    // Claim the page canvas while v2 is mounted. App.tsx unconditionally
    // stamps `modern-ui` (the V1 dark gradient) on <body>, and .v2-root only
    // paints its own box — so the V1 darkness showed through on load flash,
    // overscroll, and every gap (Sam, 2026-08-24). The class must out-rank
    // body.modern-ui, not merely follow it in bundle order.
    document.body.classList.add('v2-canvas');
    return () => {
      document.body.classList.remove('v2-canvas');
    };
  }, []);

  return (
    <div className="v2-root">
      <V2ErrorBoundary>
        <React.Suspense fallback={<V2Boot />}>
        <Routes>
          <Route element={<V2PodShellGate />}>
            <Route index element={null} />
            <Route path="pods/:podId" element={null} />
          </Route>
          <Route path="landing" element={<Navigate to="/" replace />} />
          {/* Public read-only agent profile — the "meet the agent" identity card.
              Singular /v2/agent/... so it never collides with the authed plural
              /v2/agents (Your Team). */}
          <Route path="agent/:agentName" element={<V2AgentProfile />} />
          <Route path="agent/:agentName/:instanceId" element={<V2AgentProfile />} />
          <Route path="use-cases/:useCaseId" element={<V2UseCaseRedirect />} />
          <Route path="login" element={<V2Login />} />
          <Route path="register" element={<V2Register />} />
          <Route path="register/invite-required" element={<RegistrationInviteRequired />} />
          <Route path="oauth/complete" element={<V2OAuthComplete />} />
          <Route path="forgot-password" element={<V2ForgotPassword />} />
          <Route path="reset-password" element={<V2ResetPassword />} />
          <Route path="verify-email" element={<VerifyEmail />} />
          <Route path="discord/callback" element={<DiscordCallback />} />
          <Route path="discord/success" element={<DiscordCallback type="success" />} />
          <Route path="discord/error" element={<DiscordCallback type="error" />} />
          {/* Community access is resolved by the membership-gated pod probe.
              Keep this outside V2RequireAuth so an anonymous 401 can fall
              through to the public invite preview instead of the login wall. */}
          <Route path="community" element={<V2CommunityRedirect />} />
          {/* Pod invite redeem — handles its own auth gate (redirects to
              /v2/login?next=... when anonymous). Must sit OUTSIDE the
              V2RequireAuth wrapper so an anonymous click on the share link
              hits the gate cleanly instead of bouncing to / first. */}
          <Route path="invite/:token" element={<V2InviteRedeem />} />
          <Route
            path="*"
            element={(
              <V2RequireAuth>
                <Routes>
                {/* Board must precede the param routes: the static "board"
                    segment outranks both pods/:podId and pods/:podType/:roomId
                    in v6 matching, but keeping it first makes intent legible. */}
                <Route
                  path="pods/:podId/board"
                  element={feature(
                    'Board',
                    <V2PodBoard />,
                    false,
                    /* V2PodBoard owns its own header (pod name + back). */
                    false,
                    'v2-feature--board',
                  )}
                />
                <Route
                  path="pods/:podType/:roomId"
                  element={feature(
                    'Pod Tools',
                    <ChatRoom />,
                    false,
                    /* ChatRoom owns its own sticky AppBar with title/tabs;
                       suppress the v2 feature header so the user does not
                       get stacked chrome along the top of the route. */
                    false,
                  )}
                />
                <Route
                  path="chat/:podId"
                  element={<V2LegacyChatRedirect />}
                />
                <Route
                  path="agents"
                  element={feature(
                    'Your Team',
                    <V2YourTeamPage />,
                    false,
                    /* V2YourTeamPage owns its own header — suppress the
                       generic V2FeaturePage chrome to avoid stacked titles. */
                    false,
                  )}
                />
                <Route
                  path="agents/manage"
                  element={<Navigate to="/v2/agents" replace />}
                />
                <Route
                  path="agents/byo"
                  element={<V2AgentBYO />}
                />
                <Route
                  path="agents/:agentName/:instanceId"
                  element={feature('Agent settings', <V2AgentSettingsPage />, false, false, 'v2-feature--agent-settings')}
                />
                <Route
                  path="connect"
                  element={<V2FeaturePage title="Connect" hint="MCP uses an agent token created during setup."><V2ConnectPage /></V2FeaturePage>}
                />
                <Route
                  path="connectors"
                  element={feature(
                    'Connectors',
                    <V2ConnectorsPage />,
                    false,
                    // The Signal artboard owns this page's display-sized head.
                    false,
                  )}
                />
                <Route
                  path="artifacts"
                  element={feature('Artifacts', <V2ArtifactsPage />, false, false, 'v2-feature--artifacts')}
                />
                <Route
                  path="pods/:podId/runs/:runId"
                  element={feature('Run trace', <V2RunTrace />, false, false)}
                />
                <Route
                  path="activity"
                  element={feature('Activity', <V2ActivityPage />, false, false, 'v2-feature--activity')}
                />
                <Route
                  path="settings"
                  element={feature('Settings', <V2SettingsPage />, false, false)}
                />
                <Route
                  path="settings/devices"
                  element={<Navigate to="/v2/settings" replace />}
                />
                <Route
                  path="profile"
                  element={<Navigate to="/v2/settings" replace />}
                />
                <Route
                  path="profile/:id"
                  element={feature('Profile', <UserProfile />)}
                />
                <Route
                  path="admin/integrations/global"
                  element={feature(
                    'Global Integrations',
                    <ProtectedRoute requireAdmin><GlobalIntegrations /></ProtectedRoute>,
                    false,
                  )}
                />
                <Route
                  path="admin/users"
                  element={feature(
                    'User Admin',
                    <ProtectedRoute requireAdmin><V2AdminUsers /></ProtectedRoute>,
                    false,
                  )}
                />
                <Route
                  path="admin/analytics"
                  element={feature(
                    'Usage Analytics',
                    <ProtectedRoute requireAdmin><V2AdminAnalytics /></ProtectedRoute>,
                    false,
                  )}
                />
                <Route
                  path="dev/api"
                  element={feature(
                    'API Dev',
                    <ProtectedRoute requireAdmin><ApiDevPage /></ProtectedRoute>,
                    false,
                  )}
                />
                <Route
                  path="dev/pod-context"
                  element={feature(
                    'Pod Context Dev',
                    <ProtectedRoute requireAdmin><PodContextDevPage /></ProtectedRoute>,
                    false,
                  )}
                />
                <Route path="*" element={<Navigate to="/v2" replace />} />
                </Routes>
              </V2RequireAuth>
            )}
          />
        </Routes>
        </React.Suspense>
      </V2ErrorBoundary>
    </div>
  );
};

export default V2App;
