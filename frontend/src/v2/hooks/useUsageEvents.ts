import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';
import { setUsageEventsEnabled, trackUsage } from '../utils/usageEvents';

/**
 * Signed-in usage events (D286): reads the person's Settings choice, then sends
 * one app-open per UTC day and a screen-view per route. Until the choice is
 * known, events wait in memory; if it's off (or the request fails) they're
 * dropped. The server applies the same rules on its side.
 */
const openKey = (userId: string) => `commonly.usageAppOpen:${userId}`;

export const useUsageEvents = (): void => {
  const { isAuthenticated, currentUser } = useAuth();
  const userId = currentUser?._id;
  const { pathname } = useLocation();

  useEffect(() => {
    if (!isAuthenticated || !userId) return undefined;
    let live = true;
    axios.get('/api/users/me/usage-events')
      .then(({ data }) => {
        if (live) setUsageEventsEnabled(Boolean(data?.usageEvents) && !data?.browserSignal);
      })
      .catch(() => { if (live) setUsageEventsEnabled(false); });
    const day = new Date().toISOString().slice(0, 10);
    let sentDay: string | null = null;
    try { sentDay = window.localStorage.getItem(openKey(userId)); } catch { sentDay = null; }
    if (sentDay !== day) {
      trackUsage('app-open');
      try { window.localStorage.setItem(openKey(userId), day); } catch { /* sent again next load */ }
    }
    return () => { live = false; };
  }, [isAuthenticated, userId]);

  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    trackUsage('screen-view', { pathname });
  }, [isAuthenticated, userId, pathname]);
};
