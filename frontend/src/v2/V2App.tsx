import React from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import V2Layout from './components/V2Layout';
import V2Login from './components/V2Login';
import V2FeaturePage from './components/V2FeaturePage';
import V2YourTeamPage from './components/V2YourTeamPage';
import V2InviteRedeem from './components/V2InviteRedeem';
import V2CommunityRedirect from './components/V2CommunityRedirect';
import { useAuth } from '../context/AuthContext';
import V2Register from './components/V2Register';
import V2OAuthComplete from './components/V2OAuthComplete';
import V2ForgotPassword from './components/V2ForgotPassword';
import V2ResetPassword from './components/V2ResetPassword';
import RegistrationInviteRequired from '../components/RegistrationInviteRequired';
import VerifyEmail from '../components/VerifyEmail';
import DiscordCallback from '../components/DiscordCallback';
import V2LandingPage from './landing/V2LandingPage';
import V2Showcase from './showcase/V2Showcase';
import V2BillingPanel from './components/V2BillingPanel';
import V2AgentProfile from './agents/V2AgentProfile';
import UseCasePage from '../components/landing/UseCasePage';
import PostFeed from '../components/PostFeed';
import Thread from '../components/Thread';
import UserProfile from '../components/UserProfile';
import Dashboard from '../components/Dashboard';
import DailyDigest from '../components/DailyDigest';
import V2MarketplacePage from './marketplace/V2MarketplacePage';
import V2MarketplaceDetailPage from './marketplace/V2MarketplaceDetailPage';
import './marketplace/V2MarketplaceDetailPage.css';
import AgentsHub from '../components/agents/AgentsHub';
import V2AgentBYO from './components/V2AgentBYO';
import V2PodBoard from './components/V2PodBoard';
import SkillsCatalogPage from '../components/skills/SkillsCatalogPage';
import ActivityFeedPage from '../components/activity/ActivityFeedPage';
import AnalyticsDashboard from '../components/analytics/AnalyticsDashboard';
import ChatRoom from '../components/ChatRoom';
import ApiDevPage from '../components/ApiDevPage';
import PodContextDevPage from '../components/PodContextDevPage';
import GlobalIntegrations from '../components/admin/GlobalIntegrations';
import V2AdminUsers from './components/V2AdminUsers';
import V2AdminAnalytics from './components/V2AdminAnalytics';
import ProtectedRoute from '../components/ProtectedRoute';
import './v2.css';

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

const V2RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <V2Boot />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/v2/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

// Index gate at `/v2`. Logged-out visitors see the public landing (the front
// door); authenticated users drop straight into the app shell. Deep routes
// stay behind V2RequireAuth (the `*` branch below), so an unauthenticated
// deep link still bounces through /v2/login?next=… and lands where it meant to.
const V2Home: React.FC = () => {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return <V2Boot />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/v2/landing" replace />;
  }

  return <V2Layout selectionMode="auto" />;
};

const feature = (
  title: string,
  description: string,
  children: React.ReactNode,
  showPodsSidebar = false,
  showHeader = true,
) => (
  <V2FeaturePage
    title={title}
    description={description}
    showPodsSidebar={showPodsSidebar}
    showHeader={showHeader}
  >
    {children}
  </V2FeaturePage>
);

const V2LegacyChatRedirect: React.FC = () => {
  const { podId } = useParams<{ podId: string }>();
  return <Navigate to={podId ? `/v2/pods/chat/${podId}` : '/v2'} replace />;
};

const V2PodIdRoute: React.FC = () => {
  const { podId } = useParams<{ podId: string }>();
  const podTypeRoutes = new Set(['chat', 'study', 'games', 'gaming', 'agent-admin', 'agent-room']);
  if (podId && podTypeRoutes.has(podId)) {
    return <Navigate to="/v2" replace />;
  }
  return <V2Layout selectionMode="param" />;
};

const V2App: React.FC = () => {
  React.useEffect(() => {
    try {
      sessionStorage.setItem('commonly.v2.active', '1');
    } catch {
      // Ignore browsers that disallow sessionStorage.
    }
  }, []);

  return (
    <div className="v2-root">
      <V2ErrorBoundary>
        <Routes>
          <Route index element={<V2Home />} />
          <Route path="landing" element={<V2LandingPage />} />
          {/* Public read-only showcase — a logged-out visitor's window onto a
              real room. MUST sit OUTSIDE V2RequireAuth (the `*` branch below)
              so anonymous visitors reach it without bouncing to /v2/login. */}
          <Route path="showcase" element={<V2Showcase />} />
          <Route path="showcase/:podId" element={<V2Showcase />} />
          {/* Public read-only agent profile — the "meet the agent" identity card.
              Singular /v2/agent/... so it never collides with the authed plural
              /v2/agents (Your Team). Outside V2RequireAuth, like the showcase. */}
          <Route path="agent/:agentName" element={<V2AgentProfile />} />
          <Route path="agent/:agentName/:instanceId" element={<V2AgentProfile />} />
          <Route path="use-cases/:useCaseId" element={<UseCasePage />} />
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
                <Route path="/" element={<V2Layout selectionMode="auto" />} />
                <Route
                  path="dashboard"
                  element={feature('Dashboard', 'Your dashboard tools, kept inside the v2 shell.', <Dashboard />)}
                />
                {/* Board must precede the param routes: the static "board"
                    segment outranks both pods/:podId and pods/:podType/:roomId
                    in v6 matching, but keeping it first makes intent legible. */}
                <Route
                  path="pods/:podId/board"
                  element={feature(
                    'Board',
                    'Pod task board inside the v2 shell.',
                    <V2PodBoard />,
                    false,
                    /* V2PodBoard owns its own header (pod name + back). */
                    false,
                  )}
                />
                <Route path="pods/:podId" element={<V2PodIdRoute />} />
                <Route
                  path="pods/:podType/:roomId"
                  element={feature(
                    'Pod Tools',
                    'Full pod chat, files, member, and agent tools without leaving v2.',
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
                  path="feed"
                  element={feature('Feed', 'Create, filter, search, like, and discuss posts using the existing feed APIs.', <PostFeed />)}
                />
                <Route
                  path="thread/:id"
                  element={feature('Thread', 'Read and reply to a feed thread without leaving v2.', <Thread />)}
                />
                <Route
                  path="agents"
                  element={feature(
                    'Your Team',
                    'Agents you have hired across your projects.',
                    <V2YourTeamPage />,
                    false,
                    /* V2YourTeamPage owns its own header — suppress the
                       generic V2FeaturePage chrome to avoid stacked titles. */
                    false,
                  )}
                />
                <Route
                  path="agents/browse"
                  element={feature('Hire an agent', 'Browse and install agents from the catalog.', <AgentsHub />)}
                />
                <Route
                  path="agents/byo"
                  element={<V2AgentBYO />}
                />
                <Route
                  path="marketplace"
                  element={feature('Marketplace', 'Browse and install agents, apps, and integrations.', <V2MarketplacePage />, false, false)}
                />
                <Route
                  path="marketplace/:installableId"
                  element={feature('Marketplace', 'Manifest detail.', <V2MarketplaceDetailPage />, false)}
                />
                <Route path="apps" element={<Navigate to="/v2/marketplace" replace />} />
                <Route
                  path="skills"
                  element={feature('Skills', 'Browse, rate, import, and attach skills to pods and agents.', <SkillsCatalogPage />)}
                />
                <Route
                  path="activity"
                  element={feature('Activity', 'Review updates, mentions, approvals, pod activity, and unread items.', <ActivityFeedPage />)}
                />
                <Route
                  path="digest"
                  element={feature('Daily Digest', 'Generate and review daily summaries and digest history.', <DailyDigest />)}
                />
                <Route
                  path="analytics"
                  element={feature('Analytics', 'Community analytics powered by the existing analytics summary, timeline, and keyword endpoints.', <AnalyticsDashboard />)}
                />
                <Route
                  path="settings"
                  element={feature('Settings', 'Plan and billing, profile, avatar, app management, and API token settings.', (
                    <>
                      <V2BillingPanel />
                      <UserProfile />
                    </>
                  ))}
                />
                <Route
                  path="profile"
                  element={feature('Profile', 'Profile, avatar, app management, and API token settings.', <UserProfile />)}
                />
                <Route
                  path="profile/:id"
                  element={feature('Profile', 'Public profile, activity, and pod membership.', <UserProfile />)}
                />
                <Route
                  path="admin/integrations/global"
                  element={feature(
                    'Global Integrations',
                    'Global integration administration inside v2.',
                    <ProtectedRoute requireAdmin><GlobalIntegrations /></ProtectedRoute>,
                    false,
                  )}
                />
                <Route
                  path="admin/users"
                  element={feature(
                    'User Admin',
                    'Review waitlist requests and manage invitation codes.',
                    <ProtectedRoute requireAdmin><V2AdminUsers /></ProtectedRoute>,
                    false,
                  )}
                />
                <Route
                  path="admin/analytics"
                  element={feature(
                    'Usage Analytics',
                    'Activation funnel, signups, messages, and active-user counts for this instance.',
                    <ProtectedRoute requireAdmin><V2AdminAnalytics /></ProtectedRoute>,
                    false,
                  )}
                />
                <Route
                  path="dev/api"
                  element={feature(
                    'API Dev',
                    'Developer API inspection tools inside v2.',
                    <ProtectedRoute requireAdmin><ApiDevPage /></ProtectedRoute>,
                    false,
                  )}
                />
                <Route
                  path="dev/pod-context"
                  element={feature(
                    'Pod Context Dev',
                    'Pod context inspection tools inside v2.',
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
      </V2ErrorBoundary>
    </div>
  );
};

export default V2App;
