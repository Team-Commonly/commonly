import React, { useEffect } from 'react';
import { BrowserRouter, Navigate, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { createTheme } from '@mui/material/styles';
import Login from './components/Login';
import Register from './components/Register';
import RegistrationInviteRequired from './components/RegistrationInviteRequired';
import LandingPage from './components/landing/LandingPage';
import UseCasePage from './components/landing/UseCasePage';
import VerifyEmail from './components/VerifyEmail';
import PostFeed from './components/PostFeed';
import Thread from './components/Thread';
import UserProfile from './components/UserProfile';
import Dashboard from './components/Dashboard';
import Layout from './components/Layout';
import Pod from './components/Pod';
import PodRedirect from './components/PodRedirect';
import ChatRoom from './components/ChatRoom';
import ApiDevPage from './components/ApiDevPage';
import PodContextDevPage from './components/PodContextDevPage';
import DiscordCallback from './components/DiscordCallback';
import DailyDigest from './components/DailyDigest';
import ProtectedRoute from './components/ProtectedRoute';
// New agent-related pages
import AgentsHub from './components/agents/AgentsHub';
import ActivityFeedPage from './components/activity/ActivityFeedPage';
import SkillsCatalogPage from './components/skills/SkillsCatalogPage';
import AppsMarketplacePage from './components/apps/AppsMarketplacePage';
import GlobalIntegrations from './components/admin/GlobalIntegrations';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { LayoutProvider } from './context/LayoutContext';
import V2App from './v2/V2App';
import { setupFocusManagement } from './utils/focusUtils';
import { checkAndRefresh } from './utils/refreshUtils';
import './App.css';

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('App runtime error:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh',
          padding: 32,
          background: '#0b1220',
          color: '#e2e8f0',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
        >
          <h1 style={{ marginTop: 0 }}>Something went wrong</h1>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#fca5a5' }}>
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// Create a theme
const theme = createTheme({
  palette: {
    primary: {
      main: '#1da1f2',
      light: '#58b7f6',
      dark: '#0c8bd9',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#9c27b0',
      light: '#ba68c8',
      dark: '#7b1fa2',
      contrastText: '#ffffff',
    },
    success: {
      main: '#4caf50',
      light: '#81c784',
      dark: '#388e3c',
    },
    error: {
      main: '#f44336',
      light: '#e57373',
      dark: '#d32f2f',
    },
    warning: {
      main: '#ff9800',
      light: '#ffb74d',
      dark: '#f57c00',
    },
    info: {
      main: '#2196f3',
      light: '#64b5f6',
      dark: '#1976d2',
    },
    text: {
      primary: '#e2e8f0',
      secondary: '#94a3b8',
    },
    background: {
      default: '#0b1220',
      paper: '#111827',
    },
  },
  typography: {
    fontFamily: [
      '-apple-system',
      'BlinkMacSystemFont',
      '"Segoe UI"',
      'Roboto',
      'Oxygen',
      'Ubuntu',
      'Cantarell',
      '"Fira Sans"',
      '"Droid Sans"',
      '"Helvetica Neue"',
      'sans-serif',
    ].join(','),
    h1: {
      fontWeight: 800,
    },
    h2: {
      fontWeight: 800,
    },
    h3: {
      fontWeight: 800,
    },
    h4: {
      fontWeight: 700,
    },
    h5: {
      fontWeight: 700,
    },
    h6: {
      fontWeight: 700,
    },
    button: {
      textTransform: 'none',
      fontWeight: 600,
    },
  },
  shape: {
    borderRadius: 12,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 30,
          padding: '8px 16px',
          textTransform: 'none',
          fontWeight: 600,
        },
        containedPrimary: {
          boxShadow: '0 4px 12px rgba(29, 161, 242, 0.3)',
          '&:hover': {
            boxShadow: '0 6px 16px rgba(29, 161, 242, 0.4)',
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        rounded: {
          borderRadius: 16,
        },
      },
    },
    MuiContainer: {
      styleOverrides: {
        root: {
          '&.search-container': {
            boxShadow: 'none',
            backgroundColor: '#ffffff',
          },
        },
      },
    },
  },
});

const getV2EquivalentPath = (pathname: string, search: string): string | null => {
  if (pathname === '/') return '/v2';
  if (pathname === '/login') return '/v2/login';
  if (pathname === '/register' || pathname === '/register/invite-required') return `/v2${pathname}${search}`;
  if (pathname === '/verify-email') return `/v2${pathname}${search}`;
  if (pathname.startsWith('/discord/')) return `/v2${pathname}${search}`;
  if (pathname.startsWith('/use-cases/')) return `/v2${pathname}${search}`;
  if (pathname === '/feed') return `/v2/feed${search}`;
  if (pathname.startsWith('/thread/')) return `/v2${pathname}${search}`;
  if (pathname === '/dashboard') return `/v2/dashboard${search}`;
  if (pathname === '/digest') return `/v2/digest${search}`;
  if (pathname === '/agents') return `/v2/agents${search}`;
  if (pathname === '/skills') return `/v2/skills${search}`;
  if (pathname === '/activity') return `/v2/activity${search}`;
  if (pathname === '/apps') return `/v2/marketplace${search}`;
  if (pathname === '/profile' || pathname.startsWith('/profile/')) return `/v2${pathname}${search}`;
  if (pathname === '/admin/users') return '/v2/profile?tab=user-admin';
  if (pathname === '/admin/integrations/global') return `/v2${pathname}${search}`;
  if (pathname === '/dev/api' || pathname === '/dev/pod-context') return `/v2${pathname}${search}`;
  if (pathname === '/pods') return `/v2${search}`;
  if (pathname.startsWith('/pods/')) return `/v2${pathname}${search}`;
  if (pathname.startsWith('/chat/')) return `/v2${pathname}${search}`;
  return null;
};

// Component to handle navigation events
function NavigationHandler(): null {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    try {
      const v2Active = sessionStorage.getItem('commonly.v2.active') === '1';
      if (v2Active && !location.pathname.startsWith('/v2')) {
        const v2Path = getV2EquivalentPath(location.pathname, location.search);
        if (v2Path) {
          navigate(v2Path, { replace: true });
          return;
        }
      }
    } catch {
      // sessionStorage may be blocked; navigation still works normally.
    }

    // Force a re-render when the location changes
    const handleNavigation = (): void => {
      // Force a re-render by adding and removing a class
      document.body.classList.add('navigation-occurred');
      setTimeout(() => {
        document.body.classList.remove('navigation-occurred');
      }, 0);
    };

    handleNavigation();
  }, [location, navigate]);

  return null;
}

function App(): React.ReactElement {
  useEffect(() => {
    // Setup focus management to prevent accessibility issues
    setupFocusManagement();

    // Check if a page refresh is needed
    checkAndRefresh();

    // Add a class to the body for global styling
    document.body.classList.add('modern-ui');

    return () => {
      document.body.classList.remove('modern-ui');
    };
  }, []);

  return (
    <AppErrorBoundary>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <AuthProvider>
          <AppProvider>
            <SocketProvider>
              <LayoutProvider>
                <BrowserRouter>
                  <NavigationHandler />
                  <div className="App">
                    <Routes>
                    <Route path="/v2/*" element={<V2App />} />
                    <Route path="/" element={<LandingPage />} />
                    <Route path="/use-cases/:useCaseId" element={<UseCasePage />} />
                    <Route path="/login" element={<Login />} />
                    <Route path="/register" element={<Register />} />
                    <Route path="/register/invite-required" element={<RegistrationInviteRequired />} />
                    <Route path="/verify-email" element={<VerifyEmail />} />
                    <Route element={<Layout />}>
                      <Route path="/feed" element={<PostFeed />} />
                      <Route path="/thread/:id" element={<Thread />} />
                      <Route path="/profile" element={<UserProfile />} />
                      <Route path="/profile/:id" element={<UserProfile />} />
                      <Route path="/dashboard" element={<Dashboard />} />
                      <Route path="/digest" element={<DailyDigest />} />
                      <Route path="/apps" element={<AppsMarketplacePage />} />
                      <Route path="/agents" element={<AgentsHub />} />
                      <Route path="/skills" element={<SkillsCatalogPage />} />
                      <Route path="/activity" element={<ActivityFeedPage />} />
                      <Route path="/admin/integrations/global" element={
                        <ProtectedRoute requireAdmin={true}>
                          <GlobalIntegrations />
                        </ProtectedRoute>
                      } />
                      <Route path="/admin/users" element={
                        <ProtectedRoute requireAdmin={true}>
                          <Navigate to="/profile?tab=user-admin" replace />
                        </ProtectedRoute>
                      } />
                      <Route path="/pods" element={<PodRedirect />} />
                      <Route path="/pods/:podType" element={<Pod />} />
                      <Route path="/pods/:podType/:roomId" element={<ChatRoom />} />
                      <Route path="/dev/api" element={
                        <ProtectedRoute requireAdmin={true}>
                          <ApiDevPage />
                        </ProtectedRoute>
                      } />
                      <Route path="/dev/pod-context" element={
                        <ProtectedRoute requireAdmin={true}>
                          <PodContextDevPage />
                        </ProtectedRoute>
                      } />
                    </Route>
                    <Route path="/chat/:podId" element={<Layout><ChatRoom /></Layout>} />
                    <Route path="/discord/callback" element={<DiscordCallback />} />
                    <Route path="/discord/success" element={<DiscordCallback type="success" />} />
                    <Route path="/discord/error" element={<DiscordCallback type="error" />} />
                    </Routes>
                  </div>
                </BrowserRouter>
              </LayoutProvider>
            </SocketProvider>
          </AppProvider>
        </AuthProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  );
}

export default App;
