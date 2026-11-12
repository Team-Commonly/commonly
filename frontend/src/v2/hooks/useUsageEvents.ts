import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';
import {
  forgetUsageEvents, reportSettingsReadFailed, setUsageEventsEnabled, trackUsage,
} from '../utils/usageEvents';

/**
 * Signed-in usage events (D286): reads the person's Settings choice, then sends
 * one app-open per UTC day and a screen-view per route. Until the choice is
 * known, events wait in memory; if it's off (or the request fails) they're
 * dropped. The server applies the same rules on its side.
 */
// Holds only the last UTC date an app-open went out, keyed by the signed-in
// user's own id so a shared browser doesn't skip someone else's. It never
// leaves the browser and is no visitor or device id.
const openKey = (userId: string) => `commonly.usageAppOpen:${userId}`;

export const useUsageEvents = (): void => {
  const { isAuthenticated, currentUser } = useAuth();
  const userId = currentUser?._id;
  const { pathname } = useLocation();

  useEffect(() => {
    if (!isAuthenticated || !userId) { forgetUsageEvents(); return undefined; }
    let live = true;
    const day = new Date().toISOString().slice(0, 10);
    let sentDay: string | null = null;
    try { sentDay = window.localStorage.getItem(openKey(userId)); } catch { sentDay = null; }
    if (sentDay !== day) trackUsage('app-open');
    axios.get('/api/users/me/usage-events')
      .then(({ data }) => {
        if (!live) return;
        const on = Boolean(data?.usageEvents) && !data?.browserSignal;
        setUsageEventsEnabled(on);
        // The day counts as opened only when the event could go out, so turning
        // usage on later the same day still sends one.
        if (on && sentDay !== day) {
          try { window.localStorage.setItem(openKey(userId), day); } catch { /* sent again next load */ }
        }
      })
      .catch(() => {
        if (!live) return;
        // F399: a load that recorded nothing through our fault is counted, per day only.
        setUsageEventsEnabled(false);
        reportSettingsReadFailed();
      });
    return () => { live = false; forgetUsageEvents(); };
  }, [isAuthenticated, userId]);

  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    trackUsage('screen-view', { pathname });
  }, [isAuthenticated, userId, pathname]);
};
