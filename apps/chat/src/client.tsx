import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createClient, webTokenStore, type Client, type User } from '@commonly/core';

/**
 * The app's one client. The core is constructed once, here, from the build's
 * API origin and a localStorage-backed token store; every screen reaches it
 * through useClient(). Nothing else in the app may construct a client.
 */
const apiUrl = import.meta.env.VITE_API_URL || '';
export const client: Client = createClient(apiUrl, webTokenStore('token'));

interface SessionState {
  user: User | null;
  /** true until the first /api/auth/user answer, so routes do not flash the wrong screen */
  loading: boolean;
  setUser: (user: User | null) => void;
}

const ClientContext = createContext<{ client: Client; session: SessionState } | null>(null);

export function ClientProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await client.session.token();
      if (!token) { setLoading(false); return; }
      try {
        const me = await client.auth.me();
        if (!cancelled) setUser(me);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const off = client.session.onChange((token) => { if (!token) setUser(null); });
    return () => { cancelled = true; off(); };
  }, []);

  const value = useMemo(() => ({ client, session: { user, loading, setUser } }), [user, loading]);
  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

export function useClient() {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useClient must be used inside ClientProvider');
  return ctx;
}
