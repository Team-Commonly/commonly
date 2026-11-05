import React, { useContext, useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../context/AuthContext';
import axios from 'axios';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
}

// Only the v2 admin and dev routes mount this (V2App.tsx), inside the
// V2FeaturePage chrome, so the check and the denial speak the v2 state grammar
// (`.v2-state`, the shell twin of memory's `p.v2m-state`): Plex 13.5 in the
// secondary grey, no icon, no red, no exclamation. It was a MuiAlert with a red
// exclamation until the 11-04 consistency audit (finding 9).
const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, requireAdmin = false }) => {
  const { t } = useTranslation();
  const ctx = useContext(AuthContext);
  const isAuthenticated = ctx?.isAuthenticated;
  const [loading, setLoading] = useState(requireAdmin);
  const [hasAccess, setHasAccess] = useState(false);

  useEffect(() => {
    if (requireAdmin && isAuthenticated) {
      const checkAdminAccess = async (): Promise<void> => {
        try {
          const token = localStorage.getItem('token');
          await axios.get('/api/auth/admin/check', {
            headers: { Authorization: `Bearer ${token}` },
          });
          setHasAccess(true);
        } catch (error) {
          console.error('Admin access check failed:', error);
          setHasAccess(false);
        } finally {
          setLoading(false);
        }
      };

      checkAdminAccess();
    } else if (!requireAdmin) {
      setHasAccess(true);
      setLoading(false);
    }
  }, [requireAdmin, isAuthenticated]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (loading) {
    return <p className="v2-state" role="status">{t('common.adminGate.checking')}</p>;
  }

  if (requireAdmin && !hasAccess) {
    return <p className="v2-state" role="alert">{t('common.adminGate.denied')}</p>;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
