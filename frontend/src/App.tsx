import React, { Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { createTheme } from '@mui/material/styles';
import { AppProvider } from './context/AppContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { LayoutProvider } from './context/LayoutContext';
import { setupFocusManagement } from './utils/focusUtils';
import { checkAndRefresh } from './utils/refreshUtils';
// TASK-145 — the entry keeps the stylesheet and the font faces that the first
// paint uses, because every route's UI is now a lazy chunk and must not be the
// thing that delivers them. Without these static imports the @font-face rules
// would move into the app shell's async CSS, and the public landing would paint
// in fallback fonts until the shell loaded (it never does on the landing).
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/500.css';
import './v2/v2.css';
import './App.css';

// TASK-145 — route-level split. One 4.18 MB (1.16 MB gzip) entry chunk used to
// be the whole product for every visitor: the landing carried the authenticated
// shell, and the shell carried the marketing pages and every admin surface.
// Each route family is now its own chunk, fetched when its route renders and
// covered by the single Suspense boundary in App() below. Canonical public
// landing, comparison and use-case routes stay reachable by URL exactly as
// before — only the moment their code arrives changed.
const Login = React.lazy(() => import('./components/Login'));
const Register = React.lazy(() => import('./components/Register'));
const RegistrationInviteRequired = React.lazy(() => import('./components/RegistrationInviteRequired'));
const GuidePage = React.lazy(() => import('./components/landing/GuidePage'));
const GuidesIndexPage = React.lazy(() => import('./components/landing/GuidesIndexPage'));
const UseCasePage = React.lazy(() => import('./components/landing/UseCasePage'));
const VerifyEmail = React.lazy(() => import('./components/VerifyEmail'));
const DiscordCallback = React.lazy(() => import('./components/DiscordCallback'));
const V2App = React.lazy(() => import('./v2/V2App'));
const V2LandingPage = React.lazy(() => import('./v2/landing/V2LandingPage'));
const V2CliAuthorize = React.lazy(() => import('./v2/components/V2CliAuthorize'));

// Covers the moment a route's chunk is in flight. It deliberately depends on no
// route chunk and paints NOTHING of its own: the pre-mount canvas belongs to
// the bare body (App.css `body { background-color: #f8f8fb }`, the light
// default Sam's 2026-08-24 ruling established), so the frame only has to not
// cover it.
//
// It must NOT use `var(--v2-page-bg, …)`: that token is declared on `.v2-root`
// (v2.css:22, `#eef0f4`) and this frame mounts in `.App`, before any `.v2-root`
// exists — so the fallback always wins. ux-lead's #1861 gate measured exactly
// that on a 1.6 Mbps phone: entry CSS painted light at 3.0 s, this frame then
// painted its navy fallback for three seconds (4.4 s → 7.35 s), and the viewport
// went light again — the dark flash App.css:25 records as ruled out on 08-24,
// and invisible unthrottled (<150 ms). The app shell shows its own <V2Boot/>
// mark once the shell's code has arrived.
const RouteBoot: React.FC = () => (
  <div
    role="status"
    aria-label="Loading Commonly"
    style={{ minHeight: '100vh' }}
  />
);

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
  if (pathname === '/login') return '/v2/login';
  if (pathname === '/register' || pathname === '/register/invite-required') return `/v2${pathname}${search}`;
  if (pathname === '/verify-email') return `/v2${pathname}${search}`;
  if (pathname.startsWith('/discord/')) return `/v2${pathname}${search}`;
  if (pathname === '/agents') return `/v2/agents${search}`;
  if (pathname === '/activity') return `/v2/activity${search}`;
  if (pathname === '/profile') return '/v2/settings';
  if (pathname.startsWith('/profile/')) return `/v2${pathname}${search}`;
  if (pathname === '/admin/users') return '/v2/admin/users';
  if (pathname === '/admin/integrations/global') return `/v2${pathname}${search}`;
  if (pathname === '/dev/api' || pathname === '/dev/pod-context') return `/v2${pathname}${search}`;
  if (pathname === '/pods') return `/v2${search}`;
  if (pathname.startsWith('/pods/')) return `/v2${pathname}${search}`;
  if (pathname.startsWith('/chat/')) return `/v2${pathname}${search}`;
  return null;
};

const PublicHome: React.FC = () => {
  const { isAuthenticated, loading } = useAuth();

  // Order matters (TASK-145): rendering the landing while the auth check is in
  // flight made a signed-in cold load fetch the marketing chunk it was about to
  // navigate away from. The boot canvas covers that check instead.
  if (loading) return <RouteBoot />;
  if (!isAuthenticated) return <V2LandingPage />;
  return <Navigate to="/v2" replace />;
};

// Component to handle navigation events
function NavigationHandler(): null {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    // Public marketing routes deliberately stay canonical outside /v2. Legacy
    // app paths still redirect into the v2 shell, which remains directly
    // routable for authenticated work.
    if (!location.pathname.startsWith('/v2')) {
      const v2Path = getV2EquivalentPath(location.pathname, location.search);
      if (v2Path) {
        navigate(v2Path, { replace: true });
        return;
      }
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
                    <Suspense fallback={<RouteBoot />}>
                    <Routes>
                    <Route path="/settings/devices" element={<Navigate to="/v2/settings" replace />} />
                    <Route path="/v2/*" element={<V2App />} />
                    <Route path="/" element={<PublicHome />} />
                    {/* Legacy auth/OAuth entry points preserve their query strings. */}
                    <Route path="/guides" element={<GuidesIndexPage />} />
                    <Route path="/guides/:guideId" element={<GuidePage />} />
                    <Route path="/use-cases/:useCaseId" element={<UseCasePage />} />
                    <Route path="/login" element={<Login />} />
                    <Route path="/register" element={<Register />} />
                    <Route path="/register/invite-required" element={<RegistrationInviteRequired />} />
                    <Route path="/verify-email" element={<VerifyEmail />} />
                    {/* Device-code sign-in (#1405): the backend's /api/auth/device/start
                        answers with `verifyUrl: <origin>/cli/authorize`. Deleting this
                        route 404'd every `commonly login` (#1534, 2026-09-04 → 09-08). */}
                    <Route path="/cli/authorize" element={<V2CliAuthorize />} />
                    <Route path="/discord/callback" element={<DiscordCallback />} />
                    <Route path="/discord/success" element={<DiscordCallback type="success" />} />
                    <Route path="/discord/error" element={<DiscordCallback type="error" />} />
                    </Routes>
                    </Suspense>
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
