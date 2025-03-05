import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
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
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { setupFocusManagement } from './utils/focusUtils';
import { checkAndRefresh } from './utils/refreshUtils';
import './App.css';

// Create a theme
const theme = createTheme({
  palette: {
    primary: {
      main: '#1976d2',
    },
    secondary: {
      main: '#dc004e',
    },
  },
});

function App() {
  useEffect(() => {
    // Setup focus management to prevent accessibility issues
    setupFocusManagement();
    
    // Check if a page refresh is needed
    checkAndRefresh();
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AuthProvider>
        <AppProvider>
          <SocketProvider>
            <BrowserRouter>
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
                    <Route path="/pods" element={<PodRedirect />} />
                    <Route path="/pods/:podType" element={<Pod />} />
                    <Route path="/pods/:podType/:roomId" element={<ChatRoom />} />
                  </Route>
                  <Route path="/chat/:podId" element={<Layout><ChatRoom /></Layout>} />
                </Routes>
              </div>
            </BrowserRouter>
          </SocketProvider>
        </AppProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
