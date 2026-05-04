// Public-facing redeem page for pod invite links. Lives at
// `/v2/invite/:token`. Logged-in users only — anonymous visitors are
// redirected to login with the invite URL preserved as `?next=`.
import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useV2Api } from '../hooks/useV2Api';
import V2Avatar from './V2Avatar';

interface InvitePodInfo {
  _id: string;
  name?: string;
  description?: string;
  type?: string;
  memberCount?: number;
}

interface InviteResolveResponse {
  token: string;
  pod: InvitePodInfo;
  alreadyMember?: boolean;
  expiresAt?: string | null;
}

const V2InviteRedeem: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, loading: authLoading } = useAuth();
  const api = useV2Api();
  const [invite, setInvite] = useState<InviteResolveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  // Anonymous visitor → bounce through login, preserving the invite URL
  // so they land back here after auth. Login page reads `?next=` and
  // navigates there on success.
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      const next = encodeURIComponent(location.pathname + location.search);
      navigate(`/v2/login?next=${next}`, { replace: true });
    }
  }, [authLoading, isAuthenticated, location, navigate]);

  // Resolve the invite once auth is confirmed. Idempotent — server returns
  // alreadyMember=true if the user already belongs to the pod, and the UI
  // renders a "Go to pod" affordance instead of "Join".
  useEffect(() => {
    if (authLoading || !isAuthenticated || !token) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const data = await api.get<InviteResolveResponse>(`/api/invites/${encodeURIComponent(token)}`);
        if (!cancelled) setInvite(data);
      } catch (err) {
        if (cancelled) return;
        const e = err as { response?: { data?: { msg?: string } }; message?: string };
        setError(e.response?.data?.msg || e.message || 'This invite is no longer valid.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authLoading, isAuthenticated, token, api]);

  const handleJoin = async () => {
    if (!token) return;
    setRedeeming(true);
    setError(null);
    try {
      const data = await api.post<{ ok: boolean; pod: { _id: string } }>(
        `/api/invites/${encodeURIComponent(token)}/redeem`,
        {},
      );
      if (data?.pod?._id) navigate(`/v2/pods/${data.pod._id}`, { replace: true });
    } catch (err) {
      const e = err as { response?: { data?: { msg?: string } }; message?: string };
      setError(e.response?.data?.msg || e.message || 'Could not join — try again.');
    } finally {
      setRedeeming(false);
    }
  };

  if (authLoading || (loading && isAuthenticated)) {
    return <div className="v2-invite-page"><div className="v2-invite-card v2-invite-card--loading">Loading invite…</div></div>;
  }
  if (!isAuthenticated) return null; // redirect already in flight

  if (error && !invite) {
    return (
      <div className="v2-invite-page">
        <div className="v2-invite-card">
          <div className="v2-invite-card__title">Invite unavailable</div>
          <div className="v2-invite-card__error">{error}</div>
          <button type="button" className="v2-invite-card__cta" onClick={() => navigate('/v2', { replace: true })}>
            Go to your pods
          </button>
        </div>
      </div>
    );
  }
  if (!invite) return null;

  const pod = invite.pod;
  const podName = pod.name || 'Untitled pod';

  return (
    <div className="v2-invite-page">
      <div className="v2-invite-card">
        <V2Avatar name={podName} size="lg" />
        <div className="v2-invite-card__title">{podName}</div>
        {pod.description && (
          <div className="v2-invite-card__description">{pod.description}</div>
        )}
        <div className="v2-invite-card__meta">
          {pod.memberCount ?? 0} member{pod.memberCount === 1 ? '' : 's'}
        </div>
        {error && <div className="v2-invite-card__error">{error}</div>}
        {invite.alreadyMember ? (
          <button
            type="button"
            className="v2-invite-card__cta"
            onClick={() => navigate(`/v2/pods/${pod._id}`, { replace: true })}
          >
            Go to pod →
          </button>
        ) : (
          <button
            type="button"
            className="v2-invite-card__cta"
            onClick={handleJoin}
            disabled={redeeming}
          >
            {redeeming ? 'Joining…' : `Join ${podName}`}
          </button>
        )}
      </div>
    </div>
  );
};

export default V2InviteRedeem;
