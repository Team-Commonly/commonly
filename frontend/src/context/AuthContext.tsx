import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';

interface User {
  _id: string;
  id?: string;
  username: string;
  email: string;
  profilePicture?: string;
  role?: string;
  isBot?: boolean;
  [key: string]: unknown;
}

interface AuthContextValue {
  currentUser: User | null;
  user: User | null;
  token: string | null;
  loading: boolean;
  error: string | null;
  isAuthenticated: boolean;
  register: (formData: unknown) => Promise<unknown>;
  login: (email: string, password: string) => Promise<unknown>;
  logout: () => void;
  updateProfile: (formData: FormData) => Promise<unknown>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export { AuthContext };
export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};

interface JwtPayload {
  exp?: number;
  [key: string]: unknown;
}

const decodeToken = (t: string): JwtPayload | null => {
  try { return JSON.parse(atob(t.split('.')[1])) as JwtPayload; } catch { return null; }
};

interface AuthProviderProps {
  children: React.ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRefresh = useCallback((t: string) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const decoded = decodeToken(t);
    if (!decoded?.exp) return;
    const msUntilRefresh = decoded.exp * 1000 - Date.now() - 5 * 60 * 1000;
    if (msUntilRefresh <= 0) return;
    refreshTimerRef.current = setTimeout(async () => {
      try {
        const res = await axios.post<{ token: string }>('/api/auth/refresh', {}, {
          headers: { Authorization: `Bearer ${t}` },
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

  useEffect(() => {
    const loadUser = async () => {
      if (token) {
        try {
          const res = await axios.get<User>('/api/auth/user', {
            headers: { Authorization: `Bearer ${token}` },
          });
          setCurrentUser(res.data);
          setError(null);
          scheduleRefresh(token);
        } catch (err: unknown) {
          const e = err as { message?: string; response?: { status?: number } };
          console.error('Error loading user:', e.message);
          if (e.response?.status === 401) {
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

  const register = async (formData: unknown): Promise<unknown> => {
    try {
      setLoading(true);
      const res = await axios.post<{ token: string; user: User }>('/api/auth/register', formData);
      localStorage.setItem('token', res.data.token);
      setToken(res.data.token);
      setCurrentUser(res.data.user);
      setError(null);
      return res.data;
    } catch (err: unknown) {
      const e = err as { response?: { data?: { msg?: string } } };
      setError(e.response?.data?.msg || 'Registration failed');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const login = async (email: string, password: string): Promise<unknown> => {
    try {
      setLoading(true);
      const res = await axios.post<{ token: string; user: User }>('/api/auth/login', { email, password });
      localStorage.setItem('token', res.data.token);
      setToken(res.data.token);
      setCurrentUser(res.data.user);
      setError(null);
      scheduleRefresh(res.data.token);
      return res.data;
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string; msg?: string } } };
      setError(e.response?.data?.error || e.response?.data?.msg || 'Login failed');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const logout = (): void => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    localStorage.removeItem('token');
    setToken(null);
    setCurrentUser(null);
  };

  const updateProfile = async (formData: FormData): Promise<unknown> => {
    try {
      setLoading(true);
      const res = await axios.put<User>('/api/users/profile', formData, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
      });
      setCurrentUser(res.data);
      setError(null);
      return res.data;
    } catch (err: unknown) {
      const e = err as { response?: { data?: { msg?: string } } };
      setError(e.response?.data?.msg || 'Failed to update profile');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        user: currentUser,
        token,
        loading,
        error,
        register,
        login,
        logout,
        updateProfile,
        isAuthenticated: !!token,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
