import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { createTheme } from '@mui/material/styles';
import Login from './components/Login';
import Register from './components/Register';
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
import DiscordCallback from './components/DiscordCallback';
import DailyDigest from './components/DailyDigest';
import ProtectedRoute from './components/ProtectedRoute';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { LayoutProvider } from './context/LayoutContext';
import { setupFocusManagement } from './utils/focusUtils';
import { checkAndRefresh } from './utils/refreshUtils';
import './App.css';

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
      primary: '#0f1419',
      secondary: '#536471',
    },
    background: {
      default: '#f7f9f9',
      paper: '#ffffff',
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

// Component to handle navigation events
function NavigationHandler() {
  const location = useLocation();
  
  useEffect(() => {
    // Force a re-render when the location changes
    const handleNavigation = () => {
      // Force a re-render by adding and removing a class
      document.body.classList.add('navigation-occurred');
      setTimeout(() => {
        document.body.classList.remove('navigation-occurred');
      }, 0);
    };
    
    handleNavigation();
  }, [location]);
  
  return null;
}

function App() {
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
                    <Route path="/" element={<Login />} />
                    <Route path="/register" element={<Register />} />
                    <Route path="/verify-email" element={<VerifyEmail />} />
                    <Route element={<Layout />}>
                      <Route path="/feed" element={<PostFeed />} />
                      <Route path="/thread/:id" element={<Thread />} />
                      <Route path="/profile" element={<UserProfile />} />
                      <Route path="/dashboard" element={<Dashboard />} />
                      <Route path="/digest" element={<DailyDigest />} />
                      <Route path="/pods" element={<PodRedirect />} />
                      <Route path="/pods/:podType" element={<Pod />} />
                      <Route path="/pods/:podType/:roomId" element={<ChatRoom />} />
                      <Route path="/dev/api" element={
                        <ProtectedRoute requireAdmin={true}>
                          <ApiDevPage />
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
  );
}

export default App;
