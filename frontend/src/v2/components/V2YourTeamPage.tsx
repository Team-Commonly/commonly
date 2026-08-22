import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import V2Avatar from './V2Avatar';
import { useAuth } from '../../context/AuthContext';

interface PodSummary {
  _id: string;
  name?: string;
  title?: string;
}

interface AgentInstallationSummary {
  name: string;
  instanceId: string;
  displayName?: string;
  iconUrl?: string;
  status?: string;
  installedAt?: string;
  lastHeartbeatAt?: string | null;
  // Max across heartbeats, runtime-token use, and native AgentRuns (#915).
  // Older backends omit it — fall back to lastHeartbeatAt via lastSeenTime.
  lastActiveAt?: string | null;
  runtime?: { runtimeType?: string; provider?: string } | null;
  category?: string | null;
  podId?: string;
  podName?: string;
}

// Runtime labels removed from cards 2026-08-22: ADR-022 D1 (ratified) bans
// runtime vocabulary on user-facing cards; the craft audit found this surface
// violating it on every card. Owner-facing runtime detail lives on the agent
// profile, not the roster.

const formatRelative = (
  iso: string | null | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string => {
  // An agent that has NEVER been seen is not the same as a quiet one, and
  // conflating them is how 13 unreachable installs sat in Your Team looking
  // healthy (#887). Callers pass lastSeenIso() — the max across heartbeat
  // events, runtime-token use, and native AgentRuns — because any single
  // source lies for the runtime classes it doesn't cover: heartbeat-only
  // showed the Guide as "Never connected" minutes after it replied (#915).
  if (!iso) return t('yourTeam.activity.neverConnected');
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return t('yourTeam.activity.noRecent');
  const min = Math.floor(ms / 60000);
  if (min < 1) return t('yourTeam.activity.justNow');
  if (min < 60) return t('yourTeam.activity.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('yourTeam.activity.hoursAgo', { count: hr });
  const d = Math.floor(hr / 24);
  return t('yourTeam.activity.daysAgo', { count: d });
};

const lastSeenIso = (a: AgentInstallationSummary): string | null =>
  a.lastActiveAt ?? a.lastHeartbeatAt ?? null;

const lastSeenTime = (a: AgentInstallationSummary): number => {
  const iso = lastSeenIso(a);
  return iso ? new Date(iso).getTime() : 0;
};

const dedupeAgents = (agents: AgentInstallationSummary[]): AgentInstallationSummary[] => {
  const seen = new Map<string, AgentInstallationSummary>();
  for (const a of agents) {
    const key = `${a.name}:${a.instanceId || 'default'}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, a);
      continue;
    }
    if (lastSeenTime(a) > lastSeenTime(existing)) seen.set(key, a);
  }
  return Array.from(seen.values());
};

const V2YourTeamPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user } = useAuth();
  // Hosted (cloud) agents require an entitlement the open-registration tier
  // doesn't have. Until the user payload carries an explicit `entitlements`
  // flag we proxy on role==='admin' (see followups). Entitled users get the
  // cloud catalog as their primary hire path; everyone else is routed to the
  // BYO flow, which works for any account.
  const entitledFromUser = useMemo(() => {
    const entitlements = (user as { entitlements?: { cloudAgents?: boolean } } | null)?.entitlements;
    return Boolean(entitlements?.cloudAgents) || user?.role === 'admin';
  }, [user]);
  const [agents, setAgents] = useState<AgentInstallationSummary[]>([]);
  const [pods, setPods] = useState<PodSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Active category filter — 'all' means no filter. Tabs build dynamically
  // from the union of categories present on loaded agents so a sparse team
  // doesn't render empty filters.
  const [filter, setFilter] = useState<string>('all');
  // Key (`name:instanceId`) of the agent whose 1:1 room is currently opening,
  // so its "Talk to" button can show progress and block a double-submit.
  const [opening, setOpening] = useState<string | null>(null);
  // Invite-code redemption for BYO-tier users — a valid code flips the
  // hosted-agent entitlement server-side (POST /api/auth/redeem-invitation).
  // `redeemed` overrides isEntitled locally so the CTA updates without a
  // full user-payload refetch.
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState(false);
  const isEntitled = entitledFromUser || redeemed;
  // ADR-022 D2, first step (Sam, 2026-08-21: "two buttons go to the same
  // place"): the entitlement fork used to send unentitled users' Hire button
  // to BYO — the same destination as the Connect button beside it. Everyone
  // sees the same catalog now; entitlement gates at install time (the
  // where-step, once Phase 1 lands), not at the storefront door.
  const primaryHirePath = '/v2/agents/browse';

  const handleRedeem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!redeemCode.trim() || redeeming) return;
    setRedeeming(true);
    setRedeemError(null);
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        '/api/auth/redeem-invitation',
        { invitationCode: redeemCode.trim() },
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      );
      setRedeemed(true);
      setRedeemOpen(false);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setRedeemError(msg || t('yourTeam.errors.redeemFailed'));
    } finally {
      setRedeeming(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = localStorage.getItem('token');
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        const podsRes = await axios.get<PodSummary[] | { pods: PodSummary[] }>('/api/pods', { headers });
        const userPods: PodSummary[] = Array.isArray(podsRes.data)
          ? podsRes.data
          : podsRes.data?.pods || [];
        if (cancelled) return;
        setPods(userPods);

        const perPod = await Promise.all(userPods.map(async (p) => {
          try {
            const r = await axios.get<{ agents: AgentInstallationSummary[] }>(
              `/api/registry/pods/${p._id}/agents`,
              { headers },
            );
            return (r.data?.agents || []).map((a) => ({
              ...a,
              podId: p._id,
              podName: p.name || p.title || t('yourTeam.untitledProject'),
            }));
          } catch {
            return [];
          }
        }));
        if (cancelled) return;
        const flat = perPod.flat();
        setAgents(dedupeAgents(flat));
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = (e as { message?: string })?.message || t('yourTeam.errors.loadFailed');
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => lastSeenTime(b) - lastSeenTime(a));
  }, [agents]);

  // Available categories — derived from loaded agents. Order: deterministic
  // alpha so the tab bar doesn't reflow as activity timestamps change.
  const categories = useMemo(() => {
    const set = new Set<string>();
    sortedAgents.forEach((a) => { if (a.category) set.add(a.category); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [sortedAgents]);

  const filteredAgents = useMemo(() => (
    filter === 'all'
      ? sortedAgents
      : sortedAgents.filter((a) => (a.category || 'Uncategorized') === filter)
  ), [sortedAgents, filter]);

  // Open the coached 1:1 (agent-room) for this agent — the same surface the
  // post-install handoff lands on. Without this, "talk to your agent" is only
  // reachable from the project pod (a group), so the 1:1 relationship a user
  // forms at install has no entry point on their primary team surface.
  const handleTalkTo = async (a: AgentInstallationSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    const key = `${a.name}:${a.instanceId}`;
    setOpening(key);
    setError(null);
    try {
      const token = localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      const res = await axios.post<{ room?: { _id?: string } }>(
        '/api/agents/runtime/room',
        { agentName: a.name, instanceId: a.instanceId || 'default', podId: a.podId || undefined },
        { headers },
      );
      const roomId = res.data?.room?._id;
      if (!roomId) throw new Error('Agent room not returned');
      navigate(`/v2/pods/${roomId}`);
    } catch (err: unknown) {
      const resp = (err as { response?: { data?: { message?: string } } })?.response;
      setError(resp?.data?.message || t('yourTeam.errors.openRoomFailed'));
      setOpening(null);
    }
  };

  return (
    <div className="v2-team">
      <header className="v2-team__header">
        <div>
          <h1 className="v2-team__title">{t('yourTeam.title')}</h1>
          <p className="v2-team__subtitle">
            {loading
              ? t('yourTeam.loading')
              : sortedAgents.length === 0
                ? t('yourTeam.subtitle.empty')
                : t('yourTeam.subtitle.summary', {
                    agents: t('yourTeam.subtitle.agentCount', { count: sortedAgents.length }),
                    projects: t('yourTeam.subtitle.projectCount', { count: pods.length }),
                  })}
          </p>
        </div>
        <div className="v2-team__actions">
          <button
            type="button"
            className="v2-team__hire-cta"
            onClick={() => navigate(primaryHirePath)}
          >
            {t('yourTeam.actions.hire')}
          </button>
          <button
            type="button"
            className="v2-team__byo-cta"
            onClick={() => navigate('/v2/agents/byo')}
          >
            {t('yourTeam.actions.connectOwn')}
          </button>
        </div>
      </header>

      {!isEntitled && (
        <div className="v2-team__redeem">
          {redeemOpen ? (
            <form className="v2-team__redeem-form" onSubmit={handleRedeem}>
              <input
                className="v2-login__input"
                type="text"
                placeholder={t('yourTeam.redeem.placeholder')}
                value={redeemCode}
                onChange={(e) => setRedeemCode(e.target.value)}
                autoFocus
              />
              <button type="submit" className="v2-team__hire-cta" disabled={redeeming || !redeemCode.trim()}>
                {redeeming ? t('yourTeam.redeem.unlocking') : t('yourTeam.redeem.unlock')}
              </button>
              <button type="button" className="v2-team__byo-cta" onClick={() => { setRedeemOpen(false); setRedeemError(null); }}>
                {t('yourTeam.actions.cancel')}
              </button>
              {redeemError && <span className="v2-team__redeem-error">{redeemError}</span>}
            </form>
          ) : (
            <span>
              {t('yourTeam.redeem.gated')}
              {' '}
              <button type="button" className="v2-team__redeem-link" onClick={() => setRedeemOpen(true)}>
                {t('yourTeam.redeem.haveCode')}
              </button>
            </span>
          )}
        </div>
      )}
      {redeemed && (
        <div className="v2-team__redeem v2-team__redeem--success">
          {t('yourTeam.redeem.success')}
        </div>
      )}

      {error && (
        <div className="v2-team__error">{error}</div>
      )}

      {!loading && sortedAgents.length === 0 && !error && (
        <div className="v2-team__empty">
          <div className="v2-team__empty-title">{t('yourTeam.empty.title')}</div>
          <div className="v2-team__empty-text">
            {t('yourTeam.empty.text')}
          </div>
          <div className="v2-team__empty-actions">
            <button
              type="button"
              className="v2-team__hire-cta"
              onClick={() => navigate(primaryHirePath)}
            >
              {t('yourTeam.empty.hireFirst')}
            </button>
            <button
              type="button"
              className="v2-team__byo-cta"
              onClick={() => navigate('/v2/agents/byo')}
            >
              {t('yourTeam.actions.connectOwn')}
            </button>
          </div>
        </div>
      )}

      {categories.length > 1 && (
        <div className="v2-team__tabs" role="tablist" aria-label={t('yourTeam.tabs.ariaLabel')}>
          <button
            type="button"
            role="tab"
            className={`v2-team__tab${filter === 'all' ? ' v2-team__tab--active' : ''}`}
            aria-selected={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            {t('yourTeam.tabs.all', { count: sortedAgents.length })}
          </button>
          {categories.map((cat) => {
            const count = sortedAgents.filter((a) => a.category === cat).length;
            return (
              <button
                key={cat}
                type="button"
                role="tab"
                className={`v2-team__tab${filter === cat ? ' v2-team__tab--active' : ''}`}
                aria-selected={filter === cat}
                onClick={() => setFilter(cat)}
              >
                {t('yourTeam.tabs.category', { label: cat, count })}
              </button>
            );
          })}
        </div>
      )}

      <div className="v2-team__grid">
        {filteredAgents.map((a) => {
          const display = a.displayName || a.name;
          const podLabel = a.podName || t('yourTeam.untitledProject');

          const lastSeen = formatRelative(lastSeenIso(a), t);
          const cardKey = `${a.name}:${a.instanceId}`;
          const isOpening = opening === cardKey;
          const onCardClick = () => {
            if (a.podId) navigate(`/v2/pods/${a.podId}`);
          };
          return (
            <article
              key={cardKey}
              className="v2-team-card"
              onClick={onCardClick}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onCardClick(); }}
            >
              <V2Avatar
                name={display}
                src={a.iconUrl && a.iconUrl.trim() ? a.iconUrl.trim() : undefined}
                size="lg"
                kind="agent"
                seed={`${a.name}:${a.instanceId || 'default'}`}
                online={a.status === 'active'}
              />
              <div className="v2-team-card__body">
                <div className="v2-team-card__name-row">
                  <span className="v2-team-card__name">{display}</span>
                  {a.category && (
                    <span className="v2-role-chip" title={t('yourTeam.card.roleTitle', { role: a.category })}>{a.category}</span>
                  )}
                </div>
                <div className="v2-team-card__pod">{t('yourTeam.card.inProject')} <em>{podLabel}</em></div>
                <div className="v2-team-card__activity">
                  <span className="v2-team-card__dot" data-active={a.status === 'active'} />
                  {lastSeen}
                </div>
              </div>
              <div className="v2-team-card__actions">
                <button
                  type="button"
                  className="v2-team-card__profile"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/v2/agent/${encodeURIComponent(a.name)}/${encodeURIComponent(a.instanceId || 'default')}`);
                  }}
                  aria-label={t('yourTeam.card.viewProfileAria', { name: display })}
                >
                  {t('yourTeam.card.profile')}
                </button>
                <button
                  type="button"
                  className="v2-team-card__talk"
                  onClick={(e) => handleTalkTo(a, e)}
                  disabled={isOpening}
                  aria-label={t('yourTeam.card.talkToAria', { name: display })}
                >
                  {isOpening ? t('yourTeam.card.opening') : t('yourTeam.card.talkTo')}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
};

export default V2YourTeamPage;
