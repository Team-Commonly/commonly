// Public-facing redeem page for pod invite links. Lives at
// `/v2/invite/:token`. Logged-in users resolve + join in one click.
// Anonymous visitors see a minimal preview ("you've been invited to X")
// with sign-up / log-in CTAs that carry this URL as `?next=`, so the
// shared link is a registration funnel instead of a blank login wall.
import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation, Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../../context/AuthContext';
import { useV2Api } from '../hooks/useV2Api';
import V2Avatar from './V2Avatar';
import V2AuthBrand from './V2AuthBrand';
import V2AuthNotice from './V2AuthNotice';
import './V2InviteRedeem.css';
import { Trans, useTranslation } from 'react-i18next';

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
  isOwner?: boolean;
  expiresAt?: string | null;
}

interface InvitePreviewResponse {
  pod: { name?: string; memberCount?: number };
  expiresAt?: string | null;
}

const V2InviteRedeem: React.FC = () => {
  const { t, i18n } = useTranslation();
  const numberFormatter = new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language || 'en');
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, loading: authLoading } = useAuth();
  const api = useV2Api();
  const [invite, setInvite] = useState<InviteResolveResponse | null>(null);
  const [preview, setPreview] = useState<InvitePreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  const nextParam = encodeURIComponent(location.pathname + location.search);

  // Anonymous visitor → fetch the minimal preview (no auth required) so we
  // can show what they were invited to before asking them to sign up.
  useEffect(() => {
    if (authLoading || isAuthenticated || !token) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await axios.get<InvitePreviewResponse>(
          `/api/invites/${encodeURIComponent(token)}/preview`,
        );
        if (!cancelled) setPreview(res.data);
      } catch {
        if (!cancelled) setError(t('inviteRedeem.errors.invalid'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authLoading, isAuthenticated, t, token]);

  // Resolve the invite once auth is confirmed. Idempotent — server returns
  // alreadyMember=true if the user already belongs to the pod, and the UI
  // renders a "Go to pod" affordance instead of "Join".
  useEffect(() => {
    if (authLoading || !isAuthenticated || !token) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await api.get<InviteResolveResponse>(`/api/invites/${encodeURIComponent(token)}`);
        if (!cancelled) setInvite(data);
      } catch (err) {
        if (cancelled) return;
        const e = err as { response?: { data?: { msg?: string } }; message?: string };
        setError(e.response?.data?.msg || e.message || t('inviteRedeem.errors.invalid'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authLoading, isAuthenticated, token, api, t]);

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
      const e = err as { response?: { data?: { code?: string; msg?: string } }; message?: string };
      setError(
        e.response?.data?.code === 'dm_membership_refused'
          ? t('inviteRedeem.errors.dmRefused')
          : (e.response?.data?.msg || e.message || t('inviteRedeem.errors.joinFailed')),
      );
    } finally {
      setRedeeming(false);
    }
  };

  // Layout: the d215 invite frames. The sign-in card family holding a pod:
  // brand row, the pod's mark beside its name as the title, one key per state.
  const card = (children: React.ReactNode) => (
    <div className="v2-login">
      <div className="v2-login__card v2-login__card--stack">
        <V2AuthBrand />
        {children}
      </div>
    </div>
  );
  const podHead = (name: string) => (
    <div className="v2-invite__pod">
      <V2Avatar name={name} size="lg" className="v2-invite__mark" />
      <div className="v2-invite__heading">
        <span className="v2-invite__eyebrow">{t('inviteRedeem.invitedEyebrow')}</span>
        <h1 className="v2-login__title">{name}</h1>
      </div>
    </div>
  );
  const unavailable = (message: string, action: React.ReactNode) => card(
    <>
      <h1 className="v2-login__title">{t('inviteRedeem.unavailable')}</h1>
      <V2AuthNotice>{message}</V2AuthNotice>
      {action}
    </>,
  );

  if (authLoading || loading) {
    return card(<p className="v2-login__subtitle" role="status">{t('inviteRedeem.loading')}</p>);
  }

  // ---- anonymous: preview + signup funnel ----
  if (!isAuthenticated) {
    if (error || !preview) {
      return unavailable(
        error || t('inviteRedeem.errors.invalid'),
        <button type="button" className="v2-login__submit v2-login__submit--ghost" onClick={() => navigate('/v2')}>
          {t('inviteRedeem.whatIsCommonly')}
        </button>,
      );
    }
    const podName = preview.pod?.name || t('inviteRedeem.fallbackPod');
    const count = preview.pod?.memberCount ?? 0;
    return card(
      <>
        {podHead(podName)}
        <p className="v2-invite__meta">
          {t('inviteRedeem.previewMeta', { count, formattedCount: numberFormatter.format(count) })}
        </p>
        <button
          type="button"
          className="v2-login__submit"
          onClick={() => navigate(`/v2/register?next=${nextParam}`)}
        >
          {t('inviteRedeem.signUpToJoin')}
        </button>
        <p className="v2-login__alt">
          <Trans
            i18nKey="inviteRedeem.alreadyHaveAccount"
            components={{ login: <Link to={`/v2/login?next=${nextParam}`} className="v2-login__link" /> }}
          />
        </p>
      </>,
    );
  }

  // ---- authenticated ----
  if (error && !invite) {
    return unavailable(
      error,
      <button type="button" className="v2-login__submit v2-login__submit--ghost" onClick={() => navigate('/v2', { replace: true })}>
        {t('inviteRedeem.goToPods')}
      </button>,
    );
  }
  if (!invite) return null;

  const pod = invite.pod;
  const podName = pod.name || t('inviteRedeem.untitledPod');

  return card(
    <>
      {podHead(podName)}
      {pod.description && (
        <p className="v2-invite__description">
          {/* Invite resolution sends the ownership fact, not the creator ID.
              Keep the owner's original description while correcting it for guests. */}
          {invite.isOwner === false && pod.name === 'My Workspace' && pod.description === 'Your private workspace'
            ? t('inviteRedeem.sharedWorkspaceDescription') : pod.description}
        </p>
      )}
      <p className="v2-invite__meta">
        {t('inviteRedeem.memberCount', {
          count: pod.memberCount ?? 0,
          formattedCount: numberFormatter.format(pod.memberCount ?? 0),
        })}
      </p>
      {error && <V2AuthNotice>{error}</V2AuthNotice>}
      {invite.alreadyMember ? (
        <button
          type="button"
          className="v2-login__submit"
          onClick={() => navigate(`/v2/pods/${pod._id}`, { replace: true })}
        >
          {t('inviteRedeem.goToPod')}
        </button>
      ) : (
        <button
          type="button"
          className="v2-login__submit"
          onClick={handleJoin}
          disabled={redeeming}
        >
          {redeeming ? t('inviteRedeem.joining') : t('inviteRedeem.joinPod', { podName })}
        </button>
      )}
    </>,
  );
};

export default V2InviteRedeem;
