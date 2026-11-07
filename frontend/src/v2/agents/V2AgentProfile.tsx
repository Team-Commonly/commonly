import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import axios from 'axios';
import getApiBaseUrl from '../../utils/apiBaseUrl';
import V2Avatar from '../components/V2Avatar';
import { presetCharacterOptions } from '../../utils/avatarUtils';
import { characterAvatarFor } from '../utils/avatars';
import { AgentConnection, connectionLabel } from '../utils/agentConnection';
import '../v2.css';
import './v2-agent-profile.css';
import { roomRefusal } from '../utils/roomRefusal';
import { useV2Confirm } from '../hooks/useV2Confirm';

// The agent PROFILE — the "meet the agent" page, distinct from the owner-only
// Settings panel — drawn as d215 section s-agent-profile
// (docs/design/artboards/d215/index.html). It sits OUTSIDE the auth gate (see
// V2App): signed in, V2App passes `shell` and the page renders inside the app
// shell; signed out, and for a missing agent, it renders its own public bar.
// The public fetch MUST stay token-less.
//
// Contract (shared with backend routes/agentProfile.ts):
//   GET /api/agent-profile/:agentName/:instanceId → { agent, skills, pods, memory, activity }
// Whitelisted: never email / tokens / private memory / private pod names.

// The default axios instance injects the viewer's bearer token; a dedicated
// instance keeps this public endpoint anonymous regardless of auth state.
let _client: ReturnType<typeof axios.create> | null = null;
const getClient = () => {
  if (!_client) _client = axios.create({ baseURL: getApiBaseUrl() });
  return _client;
};

interface AgentProfile {
  agent: {
    agentName: string;
    instanceId: string;
    displayName: string;
    /** The bot user's id: chat and Your Team seed the unpicked face on it. */
    userId?: string;
    profilePicture: string;
    runtime: string | null;
    officialAgent: boolean;
    description?: string;
    capabilities: string[];
    createdAt?: string;
  };
  skills: Array<{ name: string; description?: string }>;
  pods: { count: number; public: Array<{ id: string; name: string; lastActive?: string | null }> };
  memory: {
    has: boolean;
    entryCount: number;
    // Public profile: coarse kind only. The owner/admin memory index below
    // carries the exact section.
    lastAgentWrite?: { kind: 'durable' | 'bookkeeping'; updatedAt: string } | null;
  };
  activity: Array<{ status: string; trigger?: string; startedAt?: string; turns: number; errorKind?: string }>;
}

// Owner/admin-only memory index (fetched with the viewer's token; 401/403 for
// everyone else → public count is shown instead).
interface PodEntry {
  id: string;
  name: string;
  type?: string;
  lastActive?: string | null;
  lastMessage?: { snippet: string; at?: string | null } | null;
}
interface MemoryIndex {
  viewerRole: 'owner' | 'admin';
  totalEntries: number;
  lastAgentWrite?: { section: string; updatedAt: string } | null;
  sections: Array<{ key: string; label: string; kind: string; notes: Array<{ header: string; snippet: string }> }>;
  pods?: PodEntry[];
}

const timeAgo = (iso?: string | null): string => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(1, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};

// V2Avatar's agent face (a prop value, not copy).
const AVATAR_KIND = 'agent' as const;

// Owner pod rows shown before "Show all N pods".
const OWNER_POD_CUT = 5;

// The standalone bar for signed-out visitors and the not-found state (d215:
// brand, What is Commonly?, Sign in, ink Sign up). Signed in, the app shell is
// the chrome instead.
const PublicBar: React.FC<{ signedIn: boolean }> = ({ signedIn }) => {
  const { t } = useTranslation();
  return (
    <header className="v2-aprofile__bar">
      <Link className="v2-aprofile__brand" to={signedIn ? '/v2' : '/v2/landing'}>
        <span className="v2-rail__brand-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <path d="M 50 17.7 A 22 22 0 1 0 50 46.3" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
            <circle cx="25" cy="32" r="2.4" fill="currentColor" />
            <circle cx="32" cy="32" r="2.4" fill="currentColor" />
            <circle cx="39" cy="32" r="2.4" fill="currentColor" />
          </svg>
        </span>
        {t('common.brandName')}
      </Link>
      <nav className="v2-aprofile__nav">
        <Link className="v2-aprofile__navlink v2-aprofile__navlink--wide" to="/v2/landing">{t('agentProfile.nav.whatIsCommonly')}</Link>
        <Link className="v2-aprofile__navlink" to="/v2/login">{t('agentProfile.nav.signIn')}</Link>
        <Link className="v2-aprofile__btn v2-aprofile__btn--primary" to="/v2/register">{t('agentProfile.nav.signUp')}</Link>
      </nav>
    </header>
  );
};

interface V2AgentProfileProps {
  /**
   * Present when the viewer is signed in: wraps the page in the app shell
   * (rail at 1440, tab bar at 390). Absent, the page is public.
   */
  shell?: (page: React.ReactNode) => React.ReactNode;
}

const V2AgentProfile: React.FC<V2AgentProfileProps> = ({ shell }) => {
  const { t } = useTranslation();
  const { agentName, instanceId } = useParams<{ agentName: string; instanceId?: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<AgentProfile | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [memIndex, setMemIndex] = useState<MemoryIndex | null>(null);
  const memoryRequestId = useRef(0);
  const [ownedConnection, setOwnedConnection] = useState<{
    connection: AgentConnection; podId: string; runtimeType?: string;
  } | null>(null);
  const [openingRoom, setOpeningRoom] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [showAllPods, setShowAllPods] = useState(false);
  const podListRef = useRef<HTMLUListElement | null>(null);
  // "Show all" removes itself, so focus moves to the first pod it revealed
  // instead of falling back to the page.
  useEffect(() => {
    if (!showAllPods) return;
    podListRef.current?.querySelectorAll<HTMLElement>('.v2-aprofile__pod-name')[OWNER_POD_CUT]?.focus();
  }, [showAllPods]);
  const signedIn = Boolean(shell);

  const fetchProfile = useCallback(async () => {
    setState('loading');
    try {
      const id = instanceId || 'default';
      const res = await getClient().get<AgentProfile>(
        `/api/agent-profile/${encodeURIComponent(agentName || '')}/${encodeURIComponent(id)}`,
      );
      setData(res.data);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [agentName, instanceId]);

  // Progressive enhancement: if the viewer is signed in AND owns this agent (or
  // is an admin), pull the private memory index. Public visitors 401/403 here and
  // just see the count. Token passed explicitly since getClient() is token-less.
  const fetchMemoryIndex = useCallback(async () => {
    const requestId = ++memoryRequestId.current;
    setMemIndex(null);
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
    if (!token || !agentName) { setMemIndex(null); return; }
    try {
      const id = instanceId || 'default';
      const res = await getClient().get<MemoryIndex>(
        `/api/agent-memory/${encodeURIComponent(agentName)}/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (requestId === memoryRequestId.current) setMemIndex(res.data);
    } catch {
      if (requestId === memoryRequestId.current) setMemIndex(null);
    }
  }, [agentName, instanceId]);

  // Owner management: detach the agent from a pod. Identity + memory are kept
  // (ADR-001 identity continuity) — it just leaves the pod. Owner-only; the
  // remove control renders only when the private memory index loaded.
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeFailed, setRemoveFailed] = useState(false);
  const { confirm, dialog: confirmDialog } = useV2Confirm();
  const handleRemoveFromPod = useCallback(async (podId: string, podName: string) => {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
    if (!token || !agentName) return;
    const confirmed = await confirm({
      message: t('agentProfile.pods.removeConfirm', { agentName, podName }),
      confirmLabel: t('agentProfile.pods.remove'),
    });
    if (!confirmed) return;
    setRemoving(podId);
    setRemoveFailed(false);
    try {
      await getClient().delete(
        `/api/registry/agents/${encodeURIComponent(agentName)}/pods/${encodeURIComponent(podId)}?instanceId=${encodeURIComponent(instanceId || 'default')}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      await Promise.all([fetchProfile(), fetchMemoryIndex()]);
    } catch {
      setRemoveFailed(true);
    } finally {
      setRemoving(null);
    }
  }, [t, agentName, confirm, fetchProfile, fetchMemoryIndex]);

  useEffect(() => {
    setShowAllPods(false);
    fetchProfile();
    fetchMemoryIndex();
  }, [fetchProfile, fetchMemoryIndex]);

  // The public profile is deliberately tokenless. Connection details come
  // only from the owner's authenticated roster, never from the public API.
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token || !agentName || !['owner', 'admin'].includes(memIndex?.viewerRole || '')) {
      setOwnedConnection(null);
      return undefined;
    }
    let cancelled = false;
    const headers = { Authorization: `Bearer ${token}` };
    getClient().get<{ writablePodId?: string | null }>(
      `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings?instanceId=${encodeURIComponent(instanceId || 'default')}`,
      { headers },
    ).then(async (writable) => {
      const podId = writable.data.writablePodId;
      if (!podId) return null;
      const roster = await getClient().get<{ agents?: Array<{
        name: string; instanceId: string; runtime?: { runtimeType?: string }; connection?: AgentConnection;
      }> }>(`/api/registry/pods/${encodeURIComponent(podId)}/agents`, { headers });
      return { podId, roster };
    }).then((result) => {
      if (cancelled) return;
      const match = result?.roster.data.agents?.find((row) => row.name === agentName
        && row.instanceId === (instanceId || 'default') && row.connection);
      setOwnedConnection(match?.connection ? {
        connection: match.connection, podId: result!.podId, runtimeType: match.runtime?.runtimeType,
      } : null);
    }).catch(() => { if (!cancelled) setOwnedConnection(null); });
    return () => { cancelled = true; };
  }, [agentName, instanceId, memIndex]);

  // Owner-editable avatar (2026-08-20): visible only when the caller is
  // the agent's installer or an admin — the backend is the real gate; this
  // check only decides whether to show the affordance.
  const [canEditAvatar, setCanEditAvatar] = useState(false);
  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token || !agentName) return;
    getClient()
      .get(`/api/agent-profile/${agentName}/${instanceId || 'default'}/avatar/can-edit`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((r) => setCanEditAvatar(Boolean(r.data?.canEdit)))
      .catch(() => setCanEditAvatar(false));
  }, [agentName, instanceId]);

  const saveAvatar = async (avatarId: string) => {
    const token = localStorage.getItem('token');
    if (!token || !agentName) return;
    setSavingAvatar(true);
    setAvatarError(false);
    try {
      await getClient().put(
        `/api/agent-profile/${agentName}/${instanceId || 'default'}/avatar`,
        { avatar: avatarId },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      window.location.reload();
    } catch {
      setSavingAvatar(false);
      setAvatarError(true);
    }
  };

  // A public profile is a useful introduction, but it must not be a dead end
  // for a signed-in teammate. The same room endpoint backs every first-DM
  // entry point (Your Team, inspector, and this profile); it is idempotent, so
  // this also returns an existing conversation without a fork in the flow.
  const handleTalkTo = useCallback(async () => {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
    if (!token || !data?.agent) return;
    setOpeningRoom(true);
    setRoomError(null);
    try {
      const room = await getClient().post<{ room?: { _id?: string } }>(
        '/api/agents/runtime/room',
        {
          agentName: data.agent.agentName,
          instanceId: data.agent.instanceId || 'default',
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const roomId = room.data?.room?._id;
      if (!roomId) throw new Error('Agent room not returned');
      navigate(`/v2/pods/${roomId}`);
    } catch (error) {
      // The profile is a human-facing entry point. Server diagnostics (for
      // example, installation-selection detail) belong in observability, not
      // as raw red copy on the profile page. A refusal the person can act on
      // still says so.
      setRoomError(roomRefusal(error, t) || t('agentProfile.hero.openRoomFailed'));
      setOpeningRoom(false);
    }
  }, [data, navigate, t]);

  const publicPage = (content: React.ReactNode) => (
    <div className="v2-root v2-aprofile v2-aprofile--public">
      <PublicBar signedIn={signedIn} />
      {content}
    </div>
  );

  if (state === 'loading') {
    // Signed in: the shell with an empty pane. Signed out: the bar and one line.
    return shell
      ? <>{shell(<div className="v2-aprofile" aria-busy="true" />)}</>
      : publicPage(<div className="v2-aprofile__center"><p className="v2-aprofile__muted">{t('agentProfile.loading')}</p></div>);
  }
  if (state === 'error' || !data) {
    // Not found keeps the public layout, signed in or not.
    return publicPage(
      <div className="v2-aprofile__center">
        <h1 className="v2-aprofile__empty-title">{t('agentProfile.notFound.title')}</h1>
        <p className="v2-aprofile__muted">{t('agentProfile.notFound.body')}</p>
        <div className="v2-aprofile__cta-row">
          <Link className="v2-aprofile__btn v2-aprofile__btn--primary" to="/v2/register">{t('agentProfile.actions.startYourOwnTeam')}</Link>
          <Link className="v2-aprofile__btn v2-aprofile__btn--ghost" to="/v2/landing">{t('agentProfile.nav.whatIsCommonly')}</Link>
        </div>
      </div>,
    );
  }

  const { agent, skills, pods, memory, activity } = data;
  const identity = `${agent.agentName}:${agent.instanceId || 'default'}`;
  const agentPath = `/v2/agents/${encodeURIComponent(agent.agentName)}/${encodeURIComponent(agent.instanceId || 'default')}`;
  // The same seed chat and Your Team use, so the unpicked face matches them.
  const faceSeed = agent.userId || identity;
  const currentAvatar = agent.profilePicture && agent.profilePicture !== 'default' ? agent.profilePicture : 'default';
  // 'default' first, then the stored picks, which stay seeded on the identity
  // so a pick made before this change is still in the grid.
  const avatarOptions = [
    { id: 'default', src: characterAvatarFor(faceSeed, 'agent') },
    ...presetCharacterOptions(identity, 'agent'),
  ];
  const runtimeLabel = (agent.runtime || '').toUpperCase();
  const isOwner = Boolean(memIndex?.viewerRole);
  const memorySectionLabel = (section: string) => t(
    `agentProfile.memory.sections.${section}`,
    { defaultValue: section },
  );

  // Owner/admin see every pod with the agent's last message; a visitor sees
  // only the publicRead pods the public response lists.
  const ownerPods = memIndex?.pods && memIndex.pods.length > 0 ? memIndex.pods : null;
  const podList: PodEntry[] = ownerPods || pods.public || [];
  const shownPods = ownerPods && !showAllPods ? podList.slice(0, OWNER_POD_CUT) : podList;
  // Installed skills; an agent with none shows its declared capabilities.
  const skillChips = skills.length > 0
    ? skills.map((s) => ({ name: s.name, title: s.description }))
    : (agent.capabilities || []).map((c) => ({ name: c, title: undefined }));

  const reconnecting = ownedConnection && ['revoked', 'stale'].includes(ownedConnection.connection.state);
  const talkLabel = t('agentProfile.hero.talkTo', { name: agent.displayName });
  let primaryKey: React.ReactNode;
  if (reconnecting && ownedConnection) {
    primaryKey = (
      <Link className="v2-aprofile__btn v2-aprofile__btn--primary"
        to={`/v2/agents/byo?pod=${encodeURIComponent(ownedConnection.podId)}&name=${encodeURIComponent(agent.agentName)}&instanceId=${encodeURIComponent(instanceId || 'default')}&reconnect=1${ownedConnection.runtimeType === 'wrapper' ? '&mode=machine' : ''}`}>
        {t('agentConnection.reconnect')}
      </Link>
    );
  } else if (signedIn) {
    primaryKey = (
      <button
        type="button"
        className="v2-aprofile__btn v2-aprofile__btn--primary"
        title={talkLabel}
        onClick={() => { void handleTalkTo(); }}
        disabled={openingRoom}
      >
        <span className="v2-aprofile__btn-label">{openingRoom ? t('agentProfile.hero.opening') : talkLabel}</span>
      </button>
    );
  } else {
    primaryKey = <Link className="v2-aprofile__btn v2-aprofile__btn--primary" to="/v2/register" title={talkLabel}><span className="v2-aprofile__btn-label">{talkLabel}</span></Link>;
  }

  const avatar = (
    <V2Avatar
      name={agent.displayName}
      src={agent.profilePicture}
      size="lg"
      kind={AVATAR_KIND}
      seed={faceSeed}
    />
  );

  const main = (
    <main className="v2-aprofile__main">
      <header className="v2-aprofile__hero">
        {/* The avatar IS the edit control (2026-09-01). Non-owners get the
            plain avatar; owners get the same avatar as a button. */}
        {canEditAvatar ? (
          <button
            type="button"
            className="v2-aprofile__avatar-button"
            onClick={() => setAvatarDialogOpen((open) => !open)}
            aria-label={t('agentProfile.avatar.change')}
            aria-expanded={avatarDialogOpen}
            aria-controls="agent-avatar-picker"
            title={t('agentProfile.avatar.change')}
          >
            {avatar}
            <span className="v2-aprofile__avatar-hint" aria-hidden="true">{t('agentProfile.avatar.edit')}</span>
          </button>
        ) : (
          <span className="v2-aprofile__avatar">{avatar}</span>
        )}
        <div className="v2-aprofile__hero-text">
          <div className="v2-aprofile__name-row">
            <h1 className="v2-aprofile__name">{agent.displayName}</h1>
            {runtimeLabel && <span className="v2-aprofile__runtime">{runtimeLabel}</span>}
            {agent.officialAgent && <span className="v2-aprofile__badge">{t('agentProfile.hero.official')}</span>}
          </div>
          {agent.description && <p className="v2-aprofile__desc">{agent.description}</p>}
          <p className="v2-aprofile__meta">
            {t('agentProfile.hero.activeInPods', { count: pods.count })}
            {memory.has && ` · ${t('agentProfile.hero.memories', { count: memory.entryCount })}`}
            {ownedConnection && (
              <span data-testid="agent-profile-connection">
                {` · ${connectionLabel(ownedConnection.connection, t)}`}
              </span>
            )}
          </p>
        </div>
        <div className="v2-aprofile__keys">
          {isOwner && signedIn && (
            <Link className="v2-aprofile__btn v2-aprofile__btn--ghost" to={agentPath}>{t('agentSettings.settings')}</Link>
          )}
          {primaryKey}
        </div>
      </header>
      {avatarDialogOpen && (
        <section id="agent-avatar-picker" className="v2-aprofile__avatar-picker" aria-labelledby="agent-avatar-picker-title">
          <h2 id="agent-avatar-picker-title" className="v2-aprofile__avatar-title">{t('agentProfile.avatar.title')}</h2>
          <div className="v2-aprofile__avatar-grid" role="group" aria-labelledby="agent-avatar-picker-title">
            {avatarOptions.map((option, index) => {
              const current = option.id === currentAvatar;
              const label = option.id === 'default'
                ? t('agentProfile.avatar.defaultOption')
                : t('agentProfile.avatar.option', { number: index });
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`v2-aprofile__avatar-choice${current ? ' is-current' : ''}`}
                  // aria-pressed already announces the current avatar.
                  aria-pressed={current}
                  aria-label={label}
                  title={label}
                  disabled={savingAvatar}
                  onClick={() => { if (!current) void saveAvatar(option.id); }}
                >
                  <img src={option.src || ''} alt="" />
                </button>
              );
            })}
          </div>
          {avatarError && <p className="v2-aprofile__avatar-error" role="alert">{t('agentProfile.avatar.saveFailed')}</p>}
          <button type="button" className="v2-aprofile__avatar-cancel" onClick={() => setAvatarDialogOpen(false)}>
            {t('agentProfile.avatar.cancel')}
          </button>
        </section>
      )}
      {roomError && <p className="v2-aprofile__room-error" role="alert">{roomError}</p>}

      {isOwner && (
        <nav className="v2-agent-settings__tabs" aria-label={t('agentSettings.tabs')}>
          <span aria-current="page">{t('agentSettings.profile')}</span>
          <Link to={agentPath}>{t('agentSettings.settings')}</Link>
          <Link to={`${agentPath}/memory`}>{t('agentSettings.memory', { defaultValue: 'Memory' })}</Link>
        </nav>
      )}

      {podList.length > 0 && (
        <section className="v2-aprofile__card" aria-labelledby="aprof-pods">
          <h2 className="v2-aprofile__card-title" id="aprof-pods">
            {ownerPods ? t('agentProfile.pods.title') : t('agentProfile.pods.publicTitle')}
            {' '}
            <span className="v2-aprofile__count">{podList.length}</span>
            {ownerPods && <span className="v2-aprofile__owner-tag">{t('agentProfile.pods.everyPod')}</span>}
          </h2>
          {removeFailed && <p className="v2-aprofile__pod-error" role="alert">{t('agentProfile.pods.removeError')}</p>}
          <ul className="v2-aprofile__list" ref={podListRef}>
            {shownPods.map((p) => (
              <li key={p.id} className="v2-aprofile__row v2-aprofile__pod">
                <span className="v2-aprofile__pod-id">
                  <Link className="v2-aprofile__pod-name" to={`/v2/pods/${p.id}`}>{p.name}</Link>
                  {ownerPods && p.lastMessage?.snippet && <span className="v2-aprofile__pod-msg">“{p.lastMessage.snippet}”</span>}
                </span>
                {p.lastActive && (
                  <span className="v2-aprofile__pod-when">
                    {ownerPods ? timeAgo(p.lastActive) : t('agentProfile.pods.activeAgo', { time: timeAgo(p.lastActive) })}
                  </span>
                )}
                {ownerPods && (
                  <button
                    type="button"
                    className="v2-aprofile__pod-remove"
                    onClick={() => handleRemoveFromPod(p.id, p.name)}
                    disabled={removing === p.id}
                    aria-label={t('agentProfile.pods.removeAria', { agentName, podName: p.name })}
                  >
                    {removing === p.id ? t('agentProfile.pods.removing') : t('agentProfile.pods.remove')}
                  </button>
                )}
              </li>
            ))}
            {shownPods.length < podList.length && (
              <li className="v2-aprofile__row">
                <button type="button" className="v2-aprofile__more" onClick={() => setShowAllPods(true)}>
                  {t('agentProfile.pods.showAll', { count: podList.length })}
                </button>
              </li>
            )}
          </ul>
        </section>
      )}

      {skillChips.length > 0 && (
        <section className="v2-aprofile__card" aria-labelledby="aprof-skills">
          <h2 className="v2-aprofile__card-title" id="aprof-skills">
            {t('agentProfile.skills.title')}
            {' '}
            <span className="v2-aprofile__count">{skillChips.length}</span>
          </h2>
          <div className="v2-aprofile__chips">
            {skillChips.map((chip) => (
              <span key={chip.name} className="v2-aprofile__chip" title={chip.title}>{chip.name}</span>
            ))}
          </div>
        </section>
      )}

      {/* One line. A visitor sees the public count; the owner/admin line
          comes from the private index fetched with their token. */}
      <section className="v2-aprofile__card" aria-labelledby="aprof-memory">
        <h2 className="v2-aprofile__card-title" id="aprof-memory">
          {t('agentProfile.memory.title')}
          {memIndex && (
            <span className="v2-aprofile__owner-tag">
              {t('agentProfile.memory.viewTag', {
                role: memIndex.viewerRole === 'admin'
                  ? t('agentProfile.memory.roleAdmin')
                  : t('agentProfile.memory.roleOwner'),
              })}
            </span>
          )}
        </h2>
        {memIndex && memIndex.totalEntries > 0 ? (
          <p className="v2-aprofile__note" data-testid="agent-profile-memory">
            <Trans
              i18nKey={memIndex.lastAgentWrite ? 'agentProfile.memory.ownerLineSaved' : 'agentProfile.memory.ownerLine'}
              values={{
                notes: memIndex.totalEntries,
                count: memIndex.sections.length,
                section: memIndex.lastAgentWrite ? memorySectionLabel(memIndex.lastAgentWrite.section) : '',
                time: memIndex.lastAgentWrite ? timeAgo(memIndex.lastAgentWrite.updatedAt) : '',
              }}
              components={{ b: <b /> }}
            />
            {' '}
            {memIndex.viewerRole === 'admin' ? t('agentProfile.memory.privateAdmin') : t('agentProfile.memory.privateOwner')}
            {' '}
            <Link to={`${agentPath}/memory`}>{t('agentProfile.memory.open')}</Link>
          </p>
        ) : !memIndex && memory.has ? (
          <p className="v2-aprofile__note" data-testid="agent-profile-memory">
            <Trans
              i18nKey="agentProfile.memory.publicLine"
              values={{ count: memory.entryCount }}
              components={{ b: <b /> }}
            />
            {memory.lastAgentWrite && ` ${t('agentProfile.memory.lastSavedAgo', { time: timeAgo(memory.lastAgentWrite.updatedAt) })}`}
          </p>
        ) : (
          <p className="v2-aprofile__note">{t('agentProfile.memory.none')}</p>
        )}
      </section>

      {activity.length > 0 && (
        <section className="v2-aprofile__card" aria-labelledby="aprof-activity">
          <h2 className="v2-aprofile__card-title" id="aprof-activity">{t('agentProfile.activity.title')}</h2>
          <ul className="v2-aprofile__list">
            {activity.map((a, i) => (
              <li key={i} className="v2-aprofile__row v2-aprofile__run">
                <span
                  className={`v2-aprofile__run-dot${a.errorKind || a.status === 'failed' ? ' v2-aprofile__run-dot--err' : ''}`}
                  aria-hidden="true"
                />
                <span className="v2-aprofile__run-label">{a.trigger || a.status}</span>
                <span className="v2-aprofile__pod-when">{t('agentProfile.activity.turnsAgo', { count: a.turns, time: timeAgo(a.startedAt) })}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );

  return (
    <>
      {shell ? shell(<div className="v2-aprofile">{main}</div>) : publicPage(main)}
      {confirmDialog}
    </>
  );
};

export default V2AgentProfile;
