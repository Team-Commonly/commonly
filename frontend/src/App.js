import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Login from './components/Login';
import Register from './components/Register';
import VerifyEmail from './components/VerifyEmail';
import PostFeed from './components/PostFeed';
import Thread from './components/Thread';
import UserProfile from './components/UserProfile';
import Dashboard from './components/Dashboard';
import CreatePost from './components/CreatePost';
import Layout from './components/Layout';
import { AppProvider } from './context/AppContext';
import { setupFocusManagement } from './utils/focusUtils';
import './App.css';

function App() {
  useEffect(() => {
    // Setup focus management to prevent accessibility issues
    setupFocusManagement();
  }, []);

  return (
    <AppProvider>
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
              <Route path="/create-post" element={<CreatePost />} />
            </Route>
          </Routes>
        </div>
      </BrowserRouter>
    </AppProvider>
  );
}

export default App;
