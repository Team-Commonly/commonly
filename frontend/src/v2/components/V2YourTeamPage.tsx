import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { useAuth } from '../../context/AuthContext';
import { initialsFor } from '../utils/avatars';

/**
 * Your Team — direction C, built to `YourTeam.dc.html` (canvas: Workspace in C)
 * under the Signal identity (`docs/design/signal-identity.md`).
 *
 * One card per agent in a three-column grid. The card is: a 40px square mark
 * whose colour IS the state (cobalt needs-you, ink working, divider idle), the
 * name in display 18, one mono status line, one sentence from the curated
 * description (or no line — never a quote), the pods it sits in as mono
 * chips, and an action row: Answer (ink) + Talk (bordered) when the agent is
 * waiting on you, Talk alone otherwise. The card that needs you carries the
 * 2px cobalt ring — the only cobalt on the page beside the rail mark.
 *
 * Rulings carried (ux-lead, Sharpen 66163–66165):
 *  - the sentence is `description` from the listing (botMetadata), else nothing;
 *  - `working · TASK-nnn` comes from the tasks API: a claimed task whose
 *    `claimedBy` is this seat's instanceId (agentName fallback); `working ·
 *    <pod>` when it holds none;
 *  - needs-you is keyed on the queue item's `actorUserId`, never on a name;
 *  - Hire an agent is ink; Bring your own is bordered.
 */

interface PodSummary {
  _id: string;
  name?: string;
  title?: string;
}

interface AgentInstallationSummary {
  name: string;
  instanceId: string;
  displayName?: string;
  iconUrl?: string; // never rendered on the card: the mark is the state (identity §4)
  status?: string;
  installedAt?: string;
  lastHeartbeatAt?: string | null;
  lastActiveAt?: string | null;
  runtime?: { runtimeType?: string; provider?: string } | null;
  category?: string | null;
  podId?: string;
  podName?: string;
  podCount?: number;
  podNames?: string[];
  internal?: boolean;
  userId?: string | null;
  description?: string | null;
}

interface TaskRow {
  taskId?: string;
  status?: string;
  claimedBy?: string | null;
  assignee?: string | null;
}

interface QueueItem {
  id: string;
  kind: string;
  title: string;
  podId?: string;
  actorUserId?: string;
  messageId?: string;
}

const QUIET_MS = 7 * 24 * 60 * 60 * 1000;

const lastSeenIso = (a: AgentInstallationSummary): string | null | undefined => a.lastActiveAt ?? a.lastHeartbeatAt;
const lastSeenTime = (a: AgentInstallationSummary): number => {
  const iso = lastSeenIso(a);
  const ms = iso ? new Date(iso).getTime() : 0;
  return Number.isNaN(ms) ? 0 : ms;
};

// Short mono age for the idle line: `41m`, `2h`, `3d` — data, not a
// sentence, so no "ago" (ux-lead 66246 (2)). A seat that never connected
// keeps saying so: that is a fact about the wrapper, not an age.
const shortAge = (iso: string | null | undefined, t: (key: string, opts?: Record<string, unknown>) => string): string => {
  if (!iso) return t('yourTeam.activity.neverConnected');
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return t('yourTeam.activity.noRecent');
  const min = Math.floor(ms / 60000);
  if (min < 1) return t('yourTeam.card.age.now');
  if (min < 60) return t('yourTeam.card.age.minutes', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('yourTeam.card.age.hours', { count: hr });
  const d = Math.floor(hr / 24);
  return t('yourTeam.card.age.days', { count: d });
};
const formatRelative = shortAge;

type CardState = 'needsYou' | 'working' | 'idle';
// The state glyph is data, not copy: mono `● working · TASK-131`.
const STATE_DOT = '\u25CF';

const agentKey = (a: { name: string; instanceId?: string }) => `${a.name}:${a.instanceId || 'default'}`;

// Pods are titled `Sharpen — pod model, attention routing, hardening`; the
// chip and the status line carry the name before the subtitle.
const shortPodName = (name: string): string => name.split(' — ')[0].split(' - ')[0].trim();

// A seat can be installed in several pods; the listing is per pod. Fold to
// one card per identity and keep every pod's name for the chips.
const dedupeAgents = (rows: Array<AgentInstallationSummary & { podName?: string }>): AgentInstallationSummary[] => {
  const seen = new Map<string, AgentInstallationSummary>();
  const pods = new Map<string, Set<string>>();
  for (const a of rows) {
    const key = agentKey(a);
    const set = pods.get(key) || new Set<string>();
    if (a.podName) set.add(a.podName);
    pods.set(key, set);
    const existing = seen.get(key);
    if (!existing || lastSeenTime(a) > lastSeenTime(existing)) seen.set(key, { ...(existing || {}), ...a });
  }
  return Array.from(seen.values()).map((a) => {
    const names = Array.from(pods.get(agentKey(a)) || []);
    return { ...a, podNames: names, podCount: names.length || (a.podId ? 1 : 0) };
  });
};

const V2YourTeamPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user } = useAuth();
  const entitledFromUser = useMemo(() => {
    const entitlements = (user as { entitlements?: { cloudAgents?: boolean } } | null)?.entitlements;
    return Boolean(entitlements?.cloudAgents) || user?.role === 'admin';
  }, [user]);

  const [agents, setAgents] = useState<AgentInstallationSummary[]>([]);
  // holder → the claim it holds: the task id when the row has one, else the pod it lives in.
  const [tasksByClaimer, setTasksByClaimer] = useState<Map<string, { taskId: string | null; podName: string }>>(new Map());
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [internalOpen, setInternalOpen] = useState(false);

  // Invite gate for hosted agents (unchanged behaviour): the redeem line is
  // the only path to Hire an agent while the account is not entitled.
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState(false);
  const isEntitled = entitledFromUser || redeemed;

  const handleRedeem = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = redeemCode.trim();
    if (!code) return;
    setRedeeming(true);
    setRedeemError(null);
    try {
      const token = localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      await axios.post('/api/auth/redeem-invitation', { code }, { headers });
      setRedeemed(true);
      setRedeemOpen(false);
      setRedeemCode('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
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
        const podList: PodSummary[] = Array.isArray(podsRes.data) ? podsRes.data : podsRes.data?.pods || [];
        const perPod = await Promise.all(podList.map(async (p) => {
          try {
            const r = await axios.get<{ agents: AgentInstallationSummary[] }>(
              `/api/registry/pods/${p._id}/agents`,
              { headers },
            );
            return (r.data?.agents || []).map((a) => ({
              ...a, podId: p._id, podName: p.name || p.title || t('yourTeam.untitledProject'),
            }));
          } catch {
            return [];
          }
        }));
        // Claimed tasks per pod → who holds which task. Advisory: a pod whose
        // board fails to load just shows `working · <pod>`.
        const claims = new Map<string, { taskId: string | null; podName: string }>();
        await Promise.all(podList.map(async (p) => {
          try {
            const r = await axios.get<{ tasks: TaskRow[] } | TaskRow[]>(`/api/v1/tasks/${p._id}?status=claimed`, { headers });
            const rows = Array.isArray(r.data) ? r.data : r.data?.tasks || [];
            for (const task of rows) {
              // `claimedBy` only: `assignee` is written by PATCH and can sit on a
              // row nobody claimed (sprint-review, PR review at fa98adf7). A
              // claimed row without an id still marks its holder — the status
              // then reads `working · <pod>` (ruling 66163 (2)).
              // `claimedBy` is the runtime's instanceId, or the agentName when the
              // seat has none — and an installation without an instanceId writes the
              // literal 'default' (agentRuntimeAuth), which identifies nobody. Such a
              // claim must never light a card (sprint-review, 58fb4147).
              const holder = task.claimedBy ? String(task.claimedBy) : '';
              if (holder && holder !== 'default' && !claims.has(holder)) claims.set(holder, { taskId: task.taskId ? String(task.taskId) : null, podName: p.name || p.title || '' });
            }
          } catch { /* advisory */ }
        }));
        let items: QueueItem[] = [];
        try {
          const q = await axios.get<{ items: QueueItem[] }>('/api/activity/decision-queue', { headers });
          items = q.data?.items || [];
        } catch { /* advisory */ }
        if (cancelled) return;
        setAgents(dedupeAgents(perPod.flat()));
        setTasksByClaimer(claims);
        setQueue(items);
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = (e as { message?: string })?.message || t('yourTeam.errors.loadFailed');
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [t]);

  // A seat claims as its instanceId (agentName fallback) — tasksApi.ts:134.
  // The claim this seat holds, or null. A claim without a task id still counts.
  // One mechanism: 'default' claims are dropped at ingest (above), so a seat on
  // the default instance can only ever match by its agentName.
  const claimedTaskFor = (a: AgentInstallationSummary): { taskId: string | null; podName: string } | null => (
    tasksByClaimer.get(a.instanceId || 'default') || tasksByClaimer.get(a.name) || null
  );

  // Needs-you per agent, keyed on the principal's id (never a name).
  const asksByActor = useMemo(() => {
    const map = new Map<string, QueueItem[]>();
    for (const item of queue) {
      if (!item.actorUserId) continue;
      const list = map.get(item.actorUserId) || [];
      list.push(item);
      map.set(item.actorUserId, list);
    }
    return map;
  }, [queue]);

  // `working` means holding a claimed task. `lastActiveAt` is refreshed by
  // every runtime-token use, and a BYO seat polls every few seconds, so
  // recency alone read 8 of 10 seats as working on the first live walk —
  // liveness is what the idle line's age already says.
  const stateOf = (a: AgentInstallationSummary): CardState => {
    if (a.userId && asksByActor.has(a.userId)) return 'needsYou';
    if (claimedTaskFor(a) !== null) return 'working';
    return 'idle';
  };

  const cards = useMemo(() => {
    const rank: Record<CardState, number> = { needsYou: 0, working: 1, idle: 2 };
    const visible = agents.filter((a) => a.internal !== true);
    return visible
      .map((a) => ({ a, state: stateOf(a) }))
      .sort((x, y) => rank[x.state] - rank[y.state] || lastSeenTime(y.a) - lastSeenTime(x.a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, asksByActor, tasksByClaimer]);

  const internal = useMemo(() => agents.filter((a) => a.internal === true), [agents]);
  const counts = useMemo(() => ({
    agents: cards.length,
    working: cards.filter((c) => c.state === 'working').length,
    needsYou: cards.filter((c) => c.state === 'needsYou').length,
  }), [cards]);

  const handleTalk = async (a: AgentInstallationSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    const key = agentKey(a);
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

  // Answer lands on the ask itself when it is a message in a pod; otherwise
  // on Activity, where every open ask lives.
  const handleAnswer = (a: AgentInstallationSummary) => {
    const ask = a.userId ? asksByActor.get(a.userId)?.[0] : undefined;
    if (ask?.podId && ask.messageId) navigate(`/v2/pods/${ask.podId}#message-${ask.messageId}`);
    else navigate('/v2/activity');
  };

  const goToProfile = (a: AgentInstallationSummary) => {
    navigate(`/v2/agent/${encodeURIComponent(a.name)}/${encodeURIComponent(a.instanceId || 'default')}`);
  };

  const handleHire = () => {
    if (isEntitled) navigate('/v2/agents/manage');
    else setRedeemOpen(true);
  };

  const renderCard = ({ a, state }: { a: AgentInstallationSummary; state: CardState }) => {
    const display = a.displayName || a.name;
    const key = agentKey(a);
    const ask = a.userId ? asksByActor.get(a.userId)?.[0] : undefined;
    const task = claimedTaskFor(a);
    const statusText = state === 'needsYou'
      ? `${t('yourTeam.card.needsYou')} · ${ask?.title || ''}`.replace(/ · $/, '')
      : state === 'working'
        ? `${t('yourTeam.card.working')} · ${task?.taskId || shortPodName(task?.podName || a.podName || '')}`.replace(/ · $/, '')
        : `${t('yourTeam.card.idle')} · ${formatRelative(lastSeenIso(a), t).toLowerCase()}`;
    return (
      <article
        key={key}
        className={`v2-team-card v2-team-card--${state}`}
        data-testid="team-card"
        data-state={state}
      >
        <div className="v2-team-card__head">
          <button
            type="button"
            className={`v2-team-card__mark v2-team-card__mark--${state}`}
            onClick={() => goToProfile(a)}
            aria-label={t('yourTeam.card.viewProfileAria', { name: display })}
          >
            {initialsFor(display)}
          </button>
          <div className="v2-team-card__title">
            <div className="v2-team-card__name">{display}</div>
            <div className={`v2-team-card__status v2-team-card__status--${state}`}>
              {state !== 'idle' && <span className="v2-team-card__dot" aria-hidden="true">{STATE_DOT}</span>}
              {state !== 'idle' ? ' ' : ''}
              {statusText}
            </div>
          </div>
        </div>
        {a.description && <p className="v2-team-card__desc">{a.description}</p>}
        {(a.podNames?.length || 0) > 0 && (
          <div className="v2-team-card__pods" aria-label={t('yourTeam.card.podsAria')}>
            {(a.podNames || []).slice(0, 4).map((name) => (
              <span key={name} className="v2-team-card__pod">{shortPodName(name).toLowerCase()}</span>
            ))}
          </div>
        )}
        <div className="v2-team-card__actions">
          {state === 'needsYou' && (
            <button type="button" className="v2-team-card__answer" onClick={() => handleAnswer(a)}>
              {t('yourTeam.card.answer')}
            </button>
          )}
          <button
            type="button"
            className="v2-team-card__talk"
            onClick={(e) => handleTalk(a, e)}
            disabled={opening === key}
            aria-label={t('yourTeam.card.talkToAria', { name: display })}
          >
            {opening === key ? t('yourTeam.card.opening') : t('yourTeam.card.talk')}
          </button>
        </div>
      </article>
    );
  };

  return (
    <div className="v2-team">
      <header className="v2-team__head">
        <div className="v2-team__heading">
          <h1 className="v2-team__title">{t('yourTeam.title')}</h1>
          <span className="v2-team__meta">
            {loading
              ? t('yourTeam.loading')
              : t('yourTeam.head.meta', { agents: counts.agents, working: counts.working, needsYou: counts.needsYou })}
          </span>
        </div>
        <div className="v2-team__actions">
          <button type="button" className="v2-team__byo" onClick={() => navigate('/v2/agents/byo')}>
            {t('yourTeam.actions.bringYourOwn')}
          </button>
          <button type="button" className="v2-team__hire" onClick={handleHire}>
            {t('yourTeam.actions.hire')}
          </button>
        </div>
      </header>

      {!isEntitled && (
        <div className="v2-team__notice">
          {redeemOpen ? (
            <form className="v2-team__redeem" onSubmit={handleRedeem}>
              <input
                className="v2-team__redeem-input"
                type="text"
                placeholder={t('yourTeam.redeem.placeholder')}
                value={redeemCode}
                onChange={(e) => setRedeemCode(e.target.value)}
                autoFocus
              />
              <button type="submit" className="v2-team__hire" disabled={redeeming || !redeemCode.trim()}>
                {redeeming ? t('yourTeam.redeem.unlocking') : t('yourTeam.redeem.unlock')}
              </button>
              <button type="button" className="v2-team__byo" onClick={() => { setRedeemOpen(false); setRedeemError(null); }}>
                {t('yourTeam.actions.cancel')}
              </button>
              {redeemError && <span className="v2-team__redeem-error" role="alert">{redeemError}</span>}
            </form>
          ) : (
            <span>
              {t('yourTeam.redeem.gated')}
              {' '}
              <button type="button" className="v2-team__link" onClick={() => setRedeemOpen(true)}>
                {t('yourTeam.redeem.haveCode')}
              </button>
            </span>
          )}
        </div>
      )}
      {redeemed && <div className="v2-team__notice v2-team__notice--ok">{t('yourTeam.redeem.success')}</div>}
      {error && <div className="v2-team__error" role="alert">{error}</div>}

      {!loading && cards.length === 0 && !error && (
        <div className="v2-team__empty">
          <div className="v2-team__empty-title">{t('yourTeam.empty.title')}</div>
          <div className="v2-team__empty-text">{t('yourTeam.empty.text')}</div>
        </div>
      )}

      <div className="v2-team__grid">
        {cards.map(renderCard)}
        <article className="v2-team-card v2-team-card--own" data-testid="team-own-card">
          <div className="v2-team-card__name">{t('yourTeam.own.title')}</div>
          <p className="v2-team-card__desc">{t('yourTeam.own.text')}</p>
          <code className="v2-team-card__command">{t('yourTeam.own.command')}</code>
          <div className="v2-team-card__actions">
            <button type="button" className="v2-team-card__talk" onClick={() => navigate('/v2/agents/byo')}>
              {t('yourTeam.own.setup')}
            </button>
          </div>
        </article>
      </div>

      {internal.length > 0 && (
        <section className="v2-team__internal" aria-label={t('yourTeam.tiers.internal')}>
          <button
            type="button"
            className="v2-team__link v2-team__internal-toggle"
            aria-expanded={internalOpen}
            data-testid="team-internal-toggle"
            onClick={() => setInternalOpen((v) => !v)}
          >
            {t('yourTeam.tiers.internalCount', { count: internal.length })}
          </button>
          {internalOpen && (
            <div className="v2-team__internal-list">
              {internal.map((a) => (
                <span key={agentKey(a)} className="v2-team-card__pod">{a.displayName || a.name}</span>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default V2YourTeamPage;
