import React from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import V2Layout from './components/V2Layout';
import V2Login from './components/V2Login';
import V2FeaturePage from './components/V2FeaturePage';
import V2YourTeamPage from './components/V2YourTeamPage';
import V2InviteRedeem from './components/V2InviteRedeem';
import { useAuth } from '../context/AuthContext';
import Register from '../components/Register';
import RegistrationInviteRequired from '../components/RegistrationInviteRequired';
import VerifyEmail from '../components/VerifyEmail';
import DiscordCallback from '../components/DiscordCallback';
import LandingPage from '../components/landing/LandingPage';
import UseCasePage from '../components/landing/UseCasePage';
import PostFeed from '../components/PostFeed';
import Thread from '../components/Thread';
import UserProfile from '../components/UserProfile';
import Dashboard from '../components/Dashboard';
import DailyDigest from '../components/DailyDigest';
import AppsMarketplacePage from '../components/apps/AppsMarketplacePage';
import AgentsHub from '../components/agents/AgentsHub';
import SkillsCatalogPage from '../components/skills/SkillsCatalogPage';
import ActivityFeedPage from '../components/activity/ActivityFeedPage';
import AnalyticsDashboard from '../components/analytics/AnalyticsDashboard';
import ChatRoom from '../components/ChatRoom';
import ApiDevPage from '../components/ApiDevPage';
import PodContextDevPage from '../components/PodContextDevPage';
import GlobalIntegrations from '../components/admin/GlobalIntegrations';
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

const V2RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="v2-empty">
        <span className="v2-spinner" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/v2/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
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
          <Route path="landing" element={<LandingPage />} />
          <Route path="use-cases/:useCaseId" element={<UseCasePage />} />
          <Route path="login" element={<V2Login />} />
          <Route path="register" element={<Register />} />
          <Route path="register/invite-required" element={<RegistrationInviteRequired />} />
          <Route path="verify-email" element={<VerifyEmail />} />
          <Route path="discord/callback" element={<DiscordCallback />} />
          <Route path="discord/success" element={<DiscordCallback type="success" />} />
          <Route path="discord/error" element={<DiscordCallback type="error" />} />
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
                  path="marketplace"
                  element={feature('Marketplace', 'Browse apps, integrations, official listings, and installed apps.', <AppsMarketplacePage />)}
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
                  element={feature('Settings', 'Profile, avatar, app management, and API token settings.', <UserProfile />)}
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
                <Route path="admin/users" element={<Navigate to="/v2/profile?tab=user-admin" replace />} />
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
