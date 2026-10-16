import { useEffect } from 'react';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';

/**
 * Sends this browser's IANA time zone once per signed-in account, so the daily
 * digest arrives at 08:00 in the person's own day (TASK-257 Phase 2b). The
 * server keeps the first zone it is sent and never overwrites it (POST
 * /api/users/me/timezone), so this only saves repeat requests. A browser that
 * cannot report a zone, or storage that throws, just means "try next time".
 */
const sentKey = (userId: string) => `commonly.timeZoneSent:${userId}`;

export const browserTimeZone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

export const useTimeZoneCapture = (): void => {
  const { isAuthenticated, currentUser } = useAuth();
  const userId = currentUser?._id;
  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    const zone = browserTimeZone();
    if (!zone) return;
    try {
      if (window.localStorage.getItem(sentKey(userId)) === zone) return;
    } catch {
      // Unreadable storage: send anyway; the server is write-once.
    }
    axios.post('/api/users/me/timezone', { timeZone: zone })
      .then(() => {
        try { window.localStorage.setItem(sentKey(userId), zone); } catch { /* next time */ }
      })
      .catch(() => {});
  }, [isAuthenticated, userId]);
};
