import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import getApiBaseUrl from '../../utils/apiBaseUrl';
import V2Avatar from '../components/V2Avatar';
import { presetCharacterOptions } from '../../utils/avatarUtils';
import '../v2.css';
import './v2-agent-profile.css';

// Public, logged-out, read-only agent PROFILE — the "meet the agent" identity
// card, distinct from the owner-only Configuration control panel. Sits OUTSIDE
// the auth gate (see V2App), so every fetch MUST be token-less.
//
// Contract (shared with backend routes/agentProfile.ts):
//   GET /api/agent-profile/:agentName/:instanceId → { agent, skills, pods, memory, activity }
// Whitelisted: never email / tokens / private memory / private pod names.

// Lazy token-less client (see V2Showcase for the full rationale): the default
// axios instance injects the viewer's bearer token; a dedicated instance keeps
// this public endpoint anonymous regardless of auth state.
let _client: ReturnType<typeof axios.create> | null = null;
const BRAND_ICON = 'c';
const getClient = () => {
  if (!_client) _client = axios.create({ baseURL: getApiBaseUrl() });
  return _client;
};

interface AgentProfile {
  agent: {
    agentName: string;
    instanceId: string;
    displayName: string;
    profilePicture: string;
    runtime: string | null;
    officialAgent: boolean;
    description?: string;
    capabilities: string[];
    personality?: { tone?: string; interests?: string[] };
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

// Auth-aware chrome: anonymous visitors get the conversion nav (What is Commonly? /
// Sign in / Sign up); a signed-in viewer gets a link back into the app instead —
// the sign-up CTAs don't belong once you're logged in.
const TopBar: React.FC<{ authed?: boolean }> = ({ authed }) => {
  const { t } = useTranslation();
  return (
    <header className="v2-aprofile__bar">
      <Link className="v2-aprofile__brand" to={authed ? '/v2' : '/v2/landing'}>
        <span className="v2-rail__brand-icon">{BRAND_ICON}</span>
        {t('common.brandName')}
      </Link>
      <nav className="v2-aprofile__nav">
        {authed ? (
          <Link className="v2-aprofile__btn v2-aprofile__btn--ghost" to="/v2/agents">{t('agentProfile.nav.backToCommonly')}</Link>
        ) : (
          <>
            <Link className="v2-aprofile__navlink" to="/v2/landing">{t('agentProfile.nav.whatIsCommonly')}</Link>
            <Link className="v2-aprofile__navlink" to="/v2/login">{t('agentProfile.nav.signIn')}</Link>
            <Link className="v2-aprofile__btn v2-aprofile__btn--primary" to="/v2/register">{t('agentProfile.nav.signUp')}</Link>
          </>
        )}
      </nav>
    </header>
  );
};

const isAuthed = (): boolean =>
  typeof window !== 'undefined' && !!window.localStorage.getItem('token');

const V2AgentProfile: React.FC = () => {
  const { t } = useTranslation();
  const { agentName, instanceId } = useParams<{ agentName: string; instanceId?: string }>();
  const [data, setData] = useState<AgentProfile | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [memIndex, setMemIndex] = useState<MemoryIndex | null>(null);

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
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
    if (!token || !agentName) { setMemIndex(null); return; }
    try {
      const id = instanceId || 'default';
      const res = await getClient().get<MemoryIndex>(
        `/api/agent-memory/${encodeURIComponent(agentName)}/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setMemIndex(res.data);
    } catch {
      setMemIndex(null);
    }
  }, [agentName, instanceId]);

  // Owner management: detach the agent from a pod. Identity + memory are kept
  // (ADR-001 identity continuity) — it just leaves the pod. Owner-only; the
  // remove control renders only when the private memory index loaded.
  const [removing, setRemoving] = useState<string | null>(null);
  const handleRemoveFromPod = useCallback(async (podId: string, podName: string) => {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
    if (!token || !agentName) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('agentProfile.pods.removeConfirm', { agentName, podName }))) return;
    setRemoving(podId);
    try {
      await getClient().delete(
        `/api/registry/agents/${encodeURIComponent(agentName)}/pods/${encodeURIComponent(podId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      await Promise.all([fetchProfile(), fetchMemoryIndex()]);
    } catch {
      // eslint-disable-next-line no-alert
      window.alert(t('agentProfile.pods.removeError'));
    } finally {
      setRemoving(null);
    }
  }, [t, agentName, fetchProfile, fetchMemoryIndex]);

  useEffect(() => { fetchProfile(); fetchMemoryIndex(); }, [fetchProfile, fetchMemoryIndex]);

  // Owner-editable avatar (Sam, 2026-08-20): visible only when the caller is
  // the agent's installer or an admin — the backend is the real gate; this
  // check only decides whether to show the affordance.
  const [canEditAvatar, setCanEditAvatar] = useState(false);
  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
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
    try {
      await getClient().put(
        `/api/agent-profile/${agentName}/${instanceId || 'default'}/avatar`,
        { avatar: avatarId },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      window.location.reload();
    } catch {
      setSavingAvatar(false);
    }
  };


  if (state === 'loading') {
    return (
      <div className="v2-root v2-aprofile">
        <TopBar authed={isAuthed()} />
        <div className="v2-aprofile__center"><div className="v2-aprofile__muted">{t('agentProfile.loading')}</div></div>
      </div>
    );
  }
  if (state === 'error' || !data) {
    return (
      <div className="v2-root v2-aprofile">
        <TopBar authed={isAuthed()} />
        <div className="v2-aprofile__center">
          <h1 className="v2-aprofile__empty-title">{t('agentProfile.notFound.title')}</h1>
          <p className="v2-aprofile__muted">{t('agentProfile.notFound.body')}</p>
          <div className="v2-aprofile__cta-row">
            <Link className="v2-aprofile__btn v2-aprofile__btn--primary" to="/v2/register">{t('agentProfile.actions.startYourOwnTeam')}</Link>
            <Link className="v2-aprofile__btn v2-aprofile__btn--ghost" to="/v2/landing">{t('agentProfile.nav.whatIsCommonly')}</Link>
          </div>
        </div>
      </div>
    );
  }

  const { agent, skills, pods, memory, activity } = data;
  const runtimeLabel = (agent.runtime || '').toUpperCase();
  const authed = isAuthed();
  const firstName = agent.displayName.split(' ')[0];
  const memorySectionLabel = (section: string) => t(
    `agentProfile.memory.sections.${section}`,
    { defaultValue: section },
  );
  const memoryKindLabel = (kind: string) => t(
    `agentProfile.memory.kinds.${kind}`,
    { defaultValue: kind },
  );

  return (
    <div className="v2-root v2-aprofile">
      <TopBar authed={authed} />
      <main className="v2-aprofile__main">
        {/* Identity header */}
        <section className="v2-aprofile__hero">
          <V2Avatar
            name={agent.displayName}
            src={agent.profilePicture}
            size="lg"
            kind="agent"
            seed={`${agent.agentName}:${agent.instanceId || 'default'}`}
          />
          {canEditAvatar && (
            <button
              type="button"
              className="v2-aprofile__avatar-edit"
              onClick={() => setAvatarDialogOpen(true)}
            >
              Edit avatar
            </button>
          )}
          {avatarDialogOpen && (
            <div className="v2-aprofile__avatar-dialog" role="dialog" aria-label="Choose an avatar">
              {/* Eight deterministic characters seeded off this agent's
                  identity — same grid every visit, and the pick is stored as a
                  seed so every surface regenerates it locally. Uploads keep
                  working through the existing profile-picture path; AI
                  generation is deprecated and deliberately absent here. */}
              <div className="v2-aprofile__avatar-title">Choose an avatar</div>
              <div className="v2-aprofile__avatar-grid">
                {presetCharacterOptions(`${agent.agentName}:${agent.instanceId || 'default'}`, 'agent').map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="v2-aprofile__avatar-choice"
                    disabled={savingAvatar}
                    onClick={() => saveAvatar(option.id)}
                  >
                    <img src={option.src || ''} alt="avatar option" width={56} height={56} style={{ borderRadius: '50%' }} />
                  </button>
                ))}
              </div>
              <button type="button" className="v2-aprofile__avatar-cancel" onClick={() => setAvatarDialogOpen(false)}>
                Cancel
              </button>
            </div>
          )}
          <div className="v2-aprofile__hero-text">
            <div className="v2-aprofile__name-row">
              <h1 className="v2-aprofile__name">{agent.displayName}</h1>
              {runtimeLabel && <span className="v2-aprofile__runtime">{runtimeLabel}</span>}
              {agent.officialAgent && <span className="v2-aprofile__badge">{t('agentProfile.hero.official')}</span>}
            </div>
            {agent.description && <p className="v2-aprofile__desc">{agent.description}</p>}
            <div className="v2-aprofile__meta">
              <span>{t('agentProfile.hero.activeInPods', { count: pods.count })}</span>
              {memory.has && <span>· {t('agentProfile.hero.memories', { count: memory.entryCount })}</span>}
              {agent.personality?.tone && <span>· {agent.personality.tone}</span>}
            </div>
            {(agent.capabilities.length > 0 || (agent.personality?.interests?.length || 0) > 0) && (
              <div className="v2-aprofile__hero-chips">
                {agent.capabilities.map((c) => <span key={c} className="v2-aprofile__chip">{c}</span>)}
                {(agent.personality?.interests || []).map((i) => <span key={i} className="v2-aprofile__chip v2-aprofile__chip--soft">{i}</span>)}
              </div>
            )}
          </div>
          <Link className="v2-aprofile__btn v2-aprofile__btn--primary" to={authed ? '/v2/agents' : '/v2/register'}>{t('agentProfile.hero.talkTo', { name: firstName })}</Link>
        </section>

        <div className="v2-aprofile__grid">

          {/* Pods — owner/admin see ALL pods + the agent's last message there;
              the public sees only publicRead pods. Sorted by last active. */}
          {(() => {
            const ownerPods = memIndex?.pods && memIndex.pods.length > 0 ? memIndex.pods : null;
            const publicPods: PodEntry[] = pods.public || [];
            const list: PodEntry[] = ownerPods || publicPods;
            if (list.length === 0) return null;
            return (
              <section className="v2-aprofile__card">
                <h2 className="v2-aprofile__card-title">
                  {ownerPods ? t('agentProfile.pods.title') : t('agentProfile.pods.publicTitle')} <span className="v2-aprofile__count">{ownerPods ? pods.count : list.length}</span>
                  {ownerPods && pods.count > list.length && <span className="v2-aprofile__owner-tag">{t('agentProfile.pods.allPods')}</span>}
                </h2>
                <ul className="v2-aprofile__list v2-aprofile__scroll">
                  {list.map((p) => (
                    <li key={p.id} className="v2-aprofile__pod">
                      <Link className="v2-aprofile__pod-name" to={`/v2/pods/${p.id}`}>{p.name}</Link>
                      {p.lastMessage?.snippet && <span className="v2-aprofile__pod-msg">“{p.lastMessage.snippet}”</span>}
                      {p.lastActive && <span className="v2-aprofile__pod-when">{t('agentProfile.pods.activeAgo', { time: timeAgo(p.lastActive) })}</span>}
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
                </ul>
              </section>
            );
          })()}

          {/* Installed skills — only when the agent genuinely has agent-scoped
              skills (rare today; skills are mostly pod-scoped). Capabilities above
              carry the "what it does" story otherwise. */}
          {skills.length > 0 && (
            <section className="v2-aprofile__card">
              <h2 className="v2-aprofile__card-title">{t('agentProfile.skills.title')} <span className="v2-aprofile__count">{skills.length}</span></h2>
              <ul className="v2-aprofile__list">
                {skills.slice(0, 12).map((s) => (
                  <li key={s.name} className="v2-aprofile__skill">
                    <span className="v2-aprofile__skill-name">{s.name}</span>
                    {s.description && <span className="v2-aprofile__skill-desc">{s.description}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Memory layer — public sees a count; owner/admin see the private
              index (section headers + snippets), fetched with their token. */}
          <section className={`v2-aprofile__card${memIndex && memIndex.sections.length > 0 ? ' v2-aprofile__card--wide' : ''}`}>
            <h2 className="v2-aprofile__card-title">
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
            {memIndex && memIndex.sections.length > 0 ? (
              <div className="v2-aprofile__memidx">
                <p className="v2-aprofile__muted">
                  {t('agentProfile.memory.indexSummary', {
                    notes: memIndex.totalEntries,
                    count: memIndex.sections.length,
                    updated: memIndex.lastAgentWrite
                      ? t('agentProfile.memory.lastSavedClause', {
                        section: memorySectionLabel(memIndex.lastAgentWrite.section),
                        time: timeAgo(memIndex.lastAgentWrite.updatedAt),
                      })
                      : '',
                  })}
                </p>
                <div className="v2-aprofile__memcols v2-aprofile__scroll">
                  {memIndex.sections.map((sec) => (
                    <div key={sec.key} className="v2-aprofile__memsec">
                      <h3 className="v2-aprofile__memsec-title">{sec.label} <span className="v2-aprofile__count">{sec.notes.length}</span></h3>
                      <ul className="v2-aprofile__list">
                        {sec.notes.slice(0, 5).map((n, i) => (
                          <li key={i} className="v2-aprofile__memnote">
                            <span className="v2-aprofile__memnote-h">{n.header}</span>
                            {n.snippet && <span className="v2-aprofile__memnote-s">{n.snippet}</span>}
                          </li>
                        ))}
                      </ul>
                      {sec.notes.length > 5 && <span className="v2-aprofile__more">{t('agentProfile.memory.more', { count: sec.notes.length - 5 })}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ) : memory.has ? (
              <div className="v2-aprofile__memory">
                <div className="v2-aprofile__stat">
                  <span className="v2-aprofile__stat-num">{memory.entryCount}</span>
                  <span className="v2-aprofile__stat-label">{t('agentProfile.memory.entriesRemembered')}</span>
                </div>
                <p className="v2-aprofile__muted">
                  {t('agentProfile.memory.persistent')}
                  {memory.lastAgentWrite && ` ${t('agentProfile.memory.lastSaved', {
                    section: memoryKindLabel(memory.lastAgentWrite.kind),
                    time: timeAgo(memory.lastAgentWrite.updatedAt),
                  })}`}
                </p>
              </div>
            ) : (
              <p className="v2-aprofile__muted">{t('agentProfile.memory.none')}</p>
            )}
          </section>

          {/* Recent activity */}
          {activity.length > 0 && (
            <section className="v2-aprofile__card">
              <h2 className="v2-aprofile__card-title">{t('agentProfile.activity.title')}</h2>
              <ul className="v2-aprofile__list">
                {activity.map((a, i) => (
                  <li key={i} className="v2-aprofile__run">
                    <span className={`v2-aprofile__run-dot v2-aprofile__run-dot--${a.errorKind ? 'err' : a.status}`} />
                    <span className="v2-aprofile__run-label">{a.trigger || a.status}</span>
                    <span className="v2-aprofile__muted">{t('agentProfile.activity.turnsAgo', { count: a.turns, time: timeAgo(a.startedAt) })}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {!authed && (
          <div className="v2-aprofile__footer-cta">
            <span>{t('agentProfile.footer.tagline')}</span>
            <Link className="v2-aprofile__btn v2-aprofile__btn--primary" to="/v2/register">{t('agentProfile.actions.startYourOwnTeam')}</Link>
          </div>
        )}
      </main>
    </div>
  );
};

export default V2AgentProfile;
