import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { forgetInvite, forgetInviteOAuthStart } from '../v2/utils/pendingInvite';

interface User {
  _id: string;
  id?: string;
  username: string;
  email: string;
  profilePicture?: string;
  role?: string;
  isBot?: boolean;
  verified?: boolean;
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
  signInWithToken: (token: string) => void;
  logout: () => void;
  updateProfile: (profile: FormData | Record<string, string>) => Promise<unknown>;
  updateUsername?: (username: string) => Promise<unknown>;
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
      if (localStorage.getItem('token') !== t) return;
      try {
        const res = await axios.post<{ token: string }>('/api/auth/refresh', {}, {
          headers: { Authorization: `Bearer ${t}` },
        });
        if (localStorage.getItem('token') !== t) return;
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
    let active = true;
    const loadUser = async () => {
      if (token) {
        try {
          const res = await axios.get<User>('/api/auth/user', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (active && localStorage.getItem('token') === token) {
            setCurrentUser(res.data);
            setError(null);
            scheduleRefresh(token);
          }
        } catch (err: unknown) {
          const e = err as { message?: string; response?: { status?: number } };
          if (!active) return;
          console.error('Error loading user:', e.message);
          if (e.response?.status === 401 && localStorage.getItem('token') === token) {
            localStorage.removeItem('token');
            setCurrentUser(null);
            setToken(null);
            if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
          }
          setError('Failed to load user data');
        }
      }
      if (active) setLoading(false);
    };
    void loadUser();
    return () => { active = false; };
  }, [token, scheduleRefresh]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'token' || event.newValue === token) return;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      if (!event.newValue) setCurrentUser(null);
      else setLoading(true);
      setToken(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    let checking = false;
    const checkSession = async () => {
      if (checking || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        await axios.get('/api/auth/user', { headers: { Authorization: `Bearer ${token}` } });
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (active && status === 401 && localStorage.getItem('token') === token) {
          if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
          localStorage.removeItem('token');
          setCurrentUser(null);
          setToken(null);
        }
      } finally {
        checking = false;
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void checkSession(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(() => { void checkSession(); }, 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token]);

  const register = async (formData: unknown): Promise<unknown> => {
    try {
      setLoading(true);
      // Registration does NOT return a session token — the backend either sends
      // a verification email or auto-verifies, then expects the user to sign in.
      // Return the response data (e.g. { message }) so callers can route to
      // /v2/login.
      const res = await axios.post<{ message?: string }>('/api/auth/register', formData);
      setError(null);
      return res.data;
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string; msg?: string } } };
      setError(e.response?.data?.error || e.response?.data?.msg || 'Registration failed');
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

  // Adopt a session token minted elsewhere (the OAuth code exchange) without
  // reloading the page. The token effect above loads the user. Holding
  // loading until it has is load-bearing: isAuthenticated is !!token, so
  // without the hold a guarded page renders signed in with currentUser still
  // null (anything reading currentUser._id would crash), not the signed-out
  // page. The guards show the boot screen instead.
  const signInWithToken = useCallback((newToken: string): void => {
    localStorage.setItem('token', newToken);
    if (newToken === token) return;
    setLoading(true);
    setError(null);
    setToken(newToken);
  }, [token]);

  const logout = (): void => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    localStorage.removeItem('token');
    forgetInvite();
    forgetInviteOAuthStart();
    setToken(null);
    setCurrentUser(null);
  };

  const updateProfile = async (profile: FormData | Record<string, string>): Promise<unknown> => {
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (profile instanceof FormData) headers['Content-Type'] = 'multipart/form-data';
      const res = await axios.put<User>('/api/users/profile', profile, {
        headers,
      });
      setCurrentUser(res.data);
      setError(null);
      return res.data;
    } catch (err: unknown) {
      const e = err as { response?: { data?: { msg?: string } } };
      setError(e.response?.data?.msg || 'Failed to update profile');
      throw err;
    }
  };

  const updateUsername = async (username: string): Promise<unknown> => {
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      const res = await axios.put<User>('/api/users/username', { username }, { headers });
      setCurrentUser(res.data);
      setError(null);
      return res.data;
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string; msg?: string } } };
      setError(e.response?.data?.error || e.response?.data?.msg || 'Failed to update username');
      throw err;
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
        signInWithToken,
        logout,
        updateProfile,
        updateUsername,
        isAuthenticated: !!token,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
