import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import PropTypes from 'prop-types';
import axios from 'axios';

const AuthContext = createContext();

export { AuthContext };
export const useAuth = () => useContext(AuthContext);

// Decode JWT payload without a library
const decodeToken = (t) => {
  try { return JSON.parse(atob(t.split('.')[1])); } catch { return null; }
};

export const AuthProvider = ({ children }) => {
  const [currentUser, setCurrentUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const refreshTimerRef = useRef(null);

  const scheduleRefresh = useCallback((t) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const decoded = decodeToken(t);
    if (!decoded?.exp) return;
    // Refresh 5 minutes before expiry
    const msUntilRefresh = (decoded.exp * 1000) - Date.now() - 5 * 60 * 1000;
    if (msUntilRefresh <= 0) return; // already too close/expired, let loadUser handle it
    refreshTimerRef.current = setTimeout(async () => {
      try {
        const res = await axios.post('/api/auth/refresh', {}, {
          headers: { 'Authorization': `Bearer ${t}` }
        });
        const newToken = res.data.token;
        localStorage.setItem('token', newToken);
        setToken(newToken);
        scheduleRefresh(newToken);
      } catch {
        // Refresh failed — let the next 401 from loadUser clear the session
      }
    }, msUntilRefresh);
  }, []);

  // Load user data if token exists
  useEffect(() => {
    const loadUser = async () => {
      if (token) {
        try {
          const res = await axios.get('/api/auth/user', {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });
          setCurrentUser(res.data);
          setError(null);
          scheduleRefresh(token);
        } catch (err) {
          console.error('Error loading user:', err.message);
          // If token is invalid/expired, clear it
          if (err.response && err.response.status === 401) {
            localStorage.removeItem('token');
            setToken(null);
            if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
          }
          setError('Failed to load user data');
        }
      }
      setLoading(false);
    };

    loadUser();
  }, [token, scheduleRefresh]);

  // Register a new user
  const register = async (formData) => {
    try {
      setLoading(true);
      const res = await axios.post('/api/auth/register', formData);
      localStorage.setItem('token', res.data.token);
      setToken(res.data.token);
      setCurrentUser(res.data.user);
      setError(null);
      return res.data;
    } catch (err) {
      setError(err.response?.data?.msg || 'Registration failed');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Login a user
  const login = async (email, password) => {
    try {
      setLoading(true);
      const res = await axios.post('/api/auth/login', { email, password });
      localStorage.setItem('token', res.data.token);
      setToken(res.data.token);
      setCurrentUser(res.data.user);
      setError(null);
      scheduleRefresh(res.data.token);
      return res.data;
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.msg || 'Login failed');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  // Logout a user
  const logout = () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    localStorage.removeItem('token');
    setToken(null);
    setCurrentUser(null);
  };

  // Update user profile
  const updateProfile = async (formData) => {
    try {
      setLoading(true);
      const res = await axios.put('/api/users/profile', formData, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'multipart/form-data'
        }
      });
      setCurrentUser(res.data);
      setError(null);
      return res.data;
    } catch (err) {
      setError(err.response?.data?.msg || 'Failed to update profile');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        user: currentUser, // Alias for backward compatibility
        token,
        loading,
        error,
        register,
        login,
        logout,
        updateProfile,
        isAuthenticated: !!token
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

AuthProvider.propTypes = {
  children: PropTypes.node.isRequired
}; 