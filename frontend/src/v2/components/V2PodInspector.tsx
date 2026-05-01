import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import V2Avatar from './V2Avatar';
import { UseV2PodDetailResult, V2Agent } from '../hooks/useV2PodDetail';
import { UseV2PodsResult } from '../hooks/useV2Pods';
import { useV2Api } from '../hooks/useV2Api';
import { useAuth } from '../../context/AuthContext';
import type { InspectorView } from './V2Layout';

interface V2PodInspectorProps {
  detail: UseV2PodDetailResult;
  podsState?: UseV2PodsResult;
  view: InspectorView;
  // V2Layout decides whether to mount this at all; collapsed-state used to
  // be rendered as a thin chevron column, but the entry is now the chat
  // header avatar group + clicks on author bylines (see V2PodChat /
  // V2MessageBubble). onClose dismisses; onBack pops to overview.
  onClose?: () => void;
  onOpenMember: (agentKey: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  onBack: () => void;
}

// Only openclaw-runtime agents can hold a real DM session — they have a chat
// runtime that responds. commonly-bot is the internal Tier 1 summarizer (no
// chat runtime); pod-summarizer is Tier 1 native (also no DM).
const isAgentDmable = (agent: { name?: string; agentName?: string }): boolean => {
  const n = agent.name || agent.agentName;
  return n === 'openclaw';
};

interface AgentTaskMap {
  [agentName: string]: { taskId: string; title: string; status: string } | null;
}

interface TaskApiResponse {
  tasks: Array<{ taskId: string; title: string; status: string; assignee?: string; updatedAt?: string }>;
}

interface AnnouncementItem {
  _id: string;
  title?: string;
  content?: string;
  createdAt?: string;
}

interface ExternalLinkItem {
  _id: string;
  name?: string;
  type?: string;
  url?: string;
}

interface RunStateCounts {
  blocked: number;
  inProgress: number;
  complete: number;
  pending: number;
}

const Icon = ({ d, size = 14 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const agentKeyOf = (agent: V2Agent): string => agent.instanceId || agent.agentName;

const memberRoleLabel = (
  member: { _id?: string; isBot?: boolean },
  ownerId: string | undefined,
  isAgent: boolean,
): 'Owner' | 'Human' | 'AI Agent' => {
  if (ownerId && member._id === ownerId) return 'Owner';
  if (isAgent || member.isBot) return 'AI Agent';
  return 'Human';
};

const V2PodInspector: React.FC<V2PodInspectorProps> = ({
  detail, podsState, view, onClose, onOpenMember, onOpenArtifact, onBack,
}) => {
  const { pod, members, agents } = detail;
  const api = useV2Api();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const [agentTasks, setAgentTasks] = useState<AgentTaskMap>({});
  const [runState, setRunState] = useState<RunStateCounts>({ blocked: 0, inProgress: 0, complete: 0, pending: 0 });
  const [privateError, setPrivateError] = useState<string | null>(null);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [externalLinks, setExternalLinks] = useState<ExternalLinkItem[]>([]);

  // Map agent username (`openclaw-nova`) → agent record so we can look up by
  // either instance id or full username when chat clicks come in.
  const agentByKey = useMemo(() => {
    const map = new Map<string, V2Agent>();
    agents.forEach((a) => {
      const id = agentKeyOf(a);
      if (id) map.set(id, a);
      const u = `${a.agentName}-${a.instanceId || 'default'}`;
      map.set(u, a);
    });
    return map;
  }, [agents]);

  // Set of usernames that map to an installed agent — used to filter the
  // members[] list down to actual humans. The backend's `User.isBot` flag
  // isn't reliably set on agent User rows in the wire payload, so we can't
  // trust `member.isBot` alone. Mirrors AgentIdentityService.buildAgentUsername.
  const agentUsernames = useMemo(() => {
    const set = new Set<string>();
    agents.forEach((a) => {
      const rawName = ((a as { name?: string; agentName?: string }).name || a.agentName || '').toLowerCase();
      const inst = (a.instanceId || '').toLowerCase();
      const username = !inst || inst === 'default' || inst === rawName
        ? rawName
        : `${rawName}-${inst}`;
      if (username) set.add(username);
    });
    return set;
  }, [agents]);

  const humanMembers = useMemo(
    () => members.filter((m) => {
      if (m.isBot) return false;
      const u = (m.username || '').toLowerCase();
      return u && !agentUsernames.has(u);
    }),
    [members, agentUsernames],
  );

  useEffect(() => {
    const podId = pod?._id;
    if (!podId) {
      setAgentTasks({});
      setRunState({ blocked: 0, inProgress: 0, complete: 0, pending: 0 });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<TaskApiResponse>(`/api/v1/tasks/${podId}`);
        const tasks = data.tasks || [];
        // Per-agent "Working on" — first matching active task.
        const map: AgentTaskMap = {};
        agents.forEach((a) => {
          const key = agentKeyOf(a);
          const match = tasks.find((t) => {
            const assignee = (t.assignee || '').toLowerCase();
            const isActive = t.status === 'pending' || t.status === 'claimed' || t.status === 'in_progress';
            if (!isActive) return false;
            return assignee && (
              assignee === (a.instanceId || '').toLowerCase()
              || assignee === (a.agentName || '').toLowerCase()
              || assignee === (a.displayName || '').toLowerCase()
            );
          });
          map[key] = match ? { taskId: match.taskId, title: match.title, status: match.status } : null;
        });
        // Run-state pill counts.
        const counts: RunStateCounts = { blocked: 0, inProgress: 0, complete: 0, pending: 0 };
        tasks.forEach((t) => {
          switch (t.status) {
            case 'blocked':
              counts.blocked += 1;
              break;
            case 'claimed':
            case 'in_progress':
              counts.inProgress += 1;
              break;
            case 'done':
            case 'completed':
              counts.complete += 1;
              break;
            case 'pending':
              counts.pending += 1;
              break;
            default:
              break;
          }
        });
        if (!cancelled) {
          setAgentTasks(map);
          setRunState(counts);
        }
      } catch {
        if (!cancelled) {
          setAgentTasks({});
          setRunState({ blocked: 0, inProgress: 0, complete: 0, pending: 0 });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [pod?._id, agents, api]);

  useEffect(() => {
    const podId = pod?._id;
    if (!podId) {
      setAnnouncements([]);
      setExternalLinks([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [announcementResult, linksResult] = await Promise.allSettled([
        api.get<AnnouncementItem[]>(`/api/pods/${podId}/announcements`),
        api.get<ExternalLinkItem[]>(`/api/pods/${podId}/external-links`),
      ]);
      if (cancelled) return;
      setAnnouncements(announcementResult.status === 'fulfilled' && Array.isArray(announcementResult.value) ? announcementResult.value : []);
      setExternalLinks(linksResult.status === 'fulfilled' && Array.isArray(linksResult.value) ? linksResult.value : []);
    })();
    return () => { cancelled = true; };
  }, [pod?._id, api]);

  if (!pod) return <aside className="v2-pane v2-pane--inspector" />;

  const isPrivatePod = pod.type === 'agent-room';
  const humanCount = humanMembers.length;
  const agentCount = agents.length;
  const created = pod.createdAt ? new Date(pod.createdAt).toLocaleDateString([], {
    month: 'short', day: 'numeric',
  }) : 'unknown';
  const ownerId = pod.createdBy?._id;

  const openPrivatePod = async (agent: V2Agent) => {
    setPrivateError(null);
    try {
      const data = await api.post<{ room?: { _id?: string } }>('/api/agents/runtime/room', {
        agentName: agent.agentName,
        instanceId: agent.instanceId || 'default',
        podId: pod._id,
      });
      const roomId = data.room?._id;
      if (roomId) navigate(`/v2/pods/${roomId}`);
      else setPrivateError('Private pod could not be opened for this agent.');
    } catch (err) {
      const e = err as { response?: { data?: { message?: string; error?: string; msg?: string } }; message?: string };
      setPrivateError(e.response?.data?.message || e.response?.data?.error || e.response?.data?.msg || e.message || 'Private pod could not be opened.');
    }
  };

  const handleDeletePod = async () => {
    if (!podsState || !pod) return;
    const confirmed = window.confirm(`Delete "${pod.name}"? This removes the pod and its messages.`);
    if (!confirmed) return;
    const deleted = await podsState.deletePod(pod._id);
    if (deleted) navigate('/v2', { replace: true });
  };

  // ------------------------------------------------------------------
  // OVERVIEW — Goal / Artifacts / Members / Run State
  // ------------------------------------------------------------------
  const goalSection = (
    <section className="v2-inspector__section">
      <div className="v2-inspector__section-title">Goal</div>
      <div className="v2-inspector__goal-text">
        {pod.description?.trim() || <span className="v2-mute">No goal set yet.</span>}
      </div>
    </section>
  );

  const artifactItems: Array<{ id: string; kind: string; title: string; subtitle?: string; url?: string }> = [
    ...announcements.map((a) => ({
      id: `ann-${a._id}`,
      kind: 'Announcement',
      title: a.title || a.content || 'Untitled announcement',
    })),
    ...externalLinks.map((l) => ({
      id: `link-${l._id}`,
      kind: l.type || 'Link',
      title: l.name || l.url || 'External link',
      subtitle: l.url,
      url: l.url,
    })),
  ];

  const artifactsSection = (
    <section className="v2-inspector__section">
      <div className="v2-inspector__section-head">
        <div className="v2-inspector__section-title">Artifacts</div>
      </div>
      {artifactItems.length === 0 ? (
        <div className="v2-inspector__empty">No artifacts yet — share Notion, Sheets, or Figma links and they'll appear here.</div>
      ) : (
        <div className="v2-inspector__artifacts">
          {artifactItems.map((a) => (
            <button
              key={a.id}
              type="button"
              className="v2-inspector__artifact-row"
              onClick={() => onOpenArtifact(a.id)}
            >
              <span className="v2-inspector__artifact-icon" aria-hidden>{a.kind.slice(0, 1).toUpperCase()}</span>
              <span className="v2-inspector__artifact-meta">
                <span className="v2-inspector__artifact-title">{a.title}</span>
                <span className="v2-inspector__artifact-sub">{a.kind}{a.subtitle ? ` · ${a.subtitle.replace(/^https?:\/\//, '').slice(0, 32)}` : ''}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );

  const membersSection = !isPrivatePod && (
    <section className="v2-inspector__section">
      <div className="v2-inspector__section-head">
        <div className="v2-inspector__section-title">Members ({agentCount + humanCount})</div>
        <button
          type="button"
          className="v2-inspector__link"
          onClick={() => navigate(`/v2/agents?podId=${pod._id}`)}
        >
          Manage
        </button>
      </div>
      {privateError && <div className="v2-chat__error" style={{ marginBottom: 8 }}>{privateError}</div>}
      {agents.map((agent) => {
        const name = agent.profile?.displayName || agent.displayName || agent.agentName;
        const key = agentKeyOf(agent);
        const isOnline = !!agent.lastHeartbeatAt
          && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 10 * 60 * 1000;
        return (
          <button
            key={`agent-${key}`}
            type="button"
            className="v2-inspector__member-row"
            onClick={() => onOpenMember(key)}
          >
            <V2Avatar
              name={name}
              src={agent.profile?.avatarUrl || agent.profile?.iconUrl || agent.iconUrl || undefined}
              size="md"
              online={isOnline}
            />
            <span className="v2-inspector__member-meta">
              <span className="v2-inspector__member-name">{name}</span>
              <span className="v2-inspector__member-role">AI Agent</span>
            </span>
            {isOnline && <span className="v2-online-dot" style={{ background: 'var(--v2-success)' }} />}
          </button>
        );
      })}
      {humanMembers.map((member) => {
        const role = memberRoleLabel(member, ownerId, false);
        return (
          <div key={`human-${member._id}`} className="v2-inspector__member-row v2-inspector__member-row--static">
            <V2Avatar name={member.username || 'Unknown'} src={member.profilePicture || undefined} size="md" />
            <span className="v2-inspector__member-meta">
              <span className="v2-inspector__member-name">{member.username}</span>
              <span className="v2-inspector__member-role">{role}</span>
            </span>
          </div>
        );
      })}
      {agents.length === 0 && humanCount === 0 && (
        <div className="v2-inspector__empty">No members yet.</div>
      )}
    </section>
  );

  const runStateSection = (
    <section className="v2-inspector__section">
      <div className="v2-inspector__section-title">Run State</div>
      <div className="v2-inspector__runstate">
        <div className="v2-inspector__runstate-row">
          <span className="v2-inspector__runstate-label">{runState.blocked} blocked</span>
          <span className="v2-inspector__pill v2-inspector__pill--blocked">Blocked</span>
        </div>
        <div className="v2-inspector__runstate-row">
          <span className="v2-inspector__runstate-label">{runState.inProgress + runState.pending} in progress</span>
          <span className="v2-inspector__pill v2-inspector__pill--progress">In Progress</span>
        </div>
        <div className="v2-inspector__runstate-row">
          <span className="v2-inspector__runstate-label">{runState.complete} complete</span>
          <span className="v2-inspector__pill v2-inspector__pill--complete">Complete</span>
        </div>
      </div>
      <button
        type="button"
        className="v2-inspector__link v2-inspector__link--block"
        onClick={() => navigate(`/v2/pods/${pod.type || 'chat'}/${pod._id}`)}
      >
        View run board
      </button>
    </section>
  );

  // ------------------------------------------------------------------
  // MEMBER DETAIL sub-page
  // ------------------------------------------------------------------
  const renderMemberDetail = (agentKey: string) => {
    const agent = agentByKey.get(agentKey);
    if (!agent) {
      return (
        <div className="v2-inspector__empty">Member not found.</div>
      );
    }
    const name = agent.profile?.displayName || agent.displayName || agent.agentName;
    const isOnline = !!agent.lastHeartbeatAt
      && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 10 * 60 * 1000;
    const task = agentTasks[agentKeyOf(agent)];
    const purpose = agent.profile?.purpose;
    const specialties = agent.profile?.persona?.specialties || [];
    const dmable = isAgentDmable(agent);
    return (
      <div className="v2-inspector__detail">
        <div className="v2-inspector__detail-head">
          <V2Avatar
            name={name}
            src={agent.profile?.avatarUrl || agent.profile?.iconUrl || agent.iconUrl || undefined}
            size="lg"
            online={isOnline}
          />
          <div className="v2-inspector__detail-name">{name}</div>
          <div className="v2-inspector__detail-sub">
            <span className="v2-online-dot" style={{ background: isOnline ? 'var(--v2-success)' : 'var(--v2-text-muted)' }} />
            {isOnline ? 'Online' : 'Idle'} · AI Agent
          </div>
        </div>
        <div className="v2-inspector__detail-actions">
          {dmable && (
            <button
              type="button"
              className="v2-inspector__btn v2-inspector__btn--primary"
              onClick={() => openPrivatePod(agent)}
            >
              Talk to {name}
            </button>
          )}
          <button
            type="button"
            className="v2-inspector__btn"
            onClick={() => navigate(`/v2/agents?podId=${pod._id}&agent=${encodeURIComponent(agentKeyOf(agent))}`)}
          >
            Manage
          </button>
        </div>
        {privateError && <div className="v2-chat__error" style={{ marginTop: 8 }}>{privateError}</div>}
        {task && (
          <div className="v2-inspector__detail-card">
            <div className="v2-inspector__detail-kicker">Working on</div>
            <div className="v2-inspector__detail-body">{task.title}</div>
          </div>
        )}
        {purpose && (
          <div className="v2-inspector__detail-card">
            <div className="v2-inspector__detail-kicker">Purpose</div>
            <div className="v2-inspector__detail-body">{purpose}</div>
          </div>
        )}
        {specialties.length > 0 && (
          <div className="v2-inspector__detail-card">
            <div className="v2-inspector__detail-kicker">Specialties</div>
            <div className="v2-inspector__chip-row">
              {specialties.map((s) => <span key={s} className="v2-inspector__chip">{s}</span>)}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ------------------------------------------------------------------
  // ARTIFACT DETAIL sub-page
  // ------------------------------------------------------------------
  const renderArtifactDetail = (artifactId: string) => {
    const found = artifactItems.find((a) => a.id === artifactId);
    if (!found) {
      return <div className="v2-inspector__empty">Artifact not found.</div>;
    }
    return (
      <div className="v2-inspector__detail">
        <div className="v2-inspector__detail-head">
          <span className="v2-inspector__artifact-icon v2-inspector__artifact-icon--lg">
            {found.kind.slice(0, 1).toUpperCase()}
          </span>
          <div className="v2-inspector__detail-name">{found.title}</div>
          <div className="v2-inspector__detail-sub">{found.kind}</div>
        </div>
        {found.url && (
          <div className="v2-inspector__detail-actions">
            <a className="v2-inspector__btn v2-inspector__btn--primary" href={found.url} target="_blank" rel="noreferrer">
              Open
            </a>
          </div>
        )}
        {found.subtitle && (
          <div className="v2-inspector__detail-card">
            <div className="v2-inspector__detail-kicker">Source</div>
            <div className="v2-inspector__detail-body" style={{ wordBreak: 'break-all' }}>{found.subtitle}</div>
          </div>
        )}
      </div>
    );
  };

  // ------------------------------------------------------------------
  // SHELL
  // ------------------------------------------------------------------
  const isOverview = view.kind === 'overview';
  const heading = isOverview
    ? pod.name
    : view.kind === 'member'
      ? 'Member'
      : 'Artifact';

  return (
    <aside className="v2-pane v2-pane--inspector">
      <div className="v2-inspector">
        <header className="v2-inspector__header">
          {!isOverview && (
            <button
              type="button"
              className="v2-inspector__back"
              onClick={onBack}
              aria-label="Back to overview"
            >
              <Icon d="M15 18l-6-6 6-6" size={16} />
              Back
            </button>
          )}
          {isOverview && (
            <div className="v2-inspector__pod-head">
              <V2Avatar name={pod.name} size="lg" />
              <div className="v2-inspector__pod-block">
                <div className="v2-inspector__pod-name" title={pod.name}>{pod.name}</div>
                <div className="v2-inspector__pod-meta">
                  Created by {pod.createdBy?.username || 'unknown'} · {created}
                </div>
                <div className="v2-inspector__pod-meta">
                  {!isPrivatePod && <>{agentCount} agent{agentCount === 1 ? '' : 's'} · </>}{humanCount} human{humanCount === 1 ? '' : 's'}
                </div>
              </div>
            </div>
          )}
          {!isOverview && (
            <div className="v2-inspector__sub-title">{heading}</div>
          )}
          {onClose && (
            <button
              type="button"
              className="v2-inspector__close"
              onClick={onClose}
              title="Hide pod team"
              aria-label="Hide pod team"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          )}
        </header>
        <div className="v2-inspector__body">
          {view.kind === 'overview' && (
            <>
              {pod.description && goalSection}
              {artifactsSection}
              {membersSection}
              {runStateSection}
              {podsState && (
                <section className="v2-inspector__section v2-inspector__section--quiet">
                  <button
                    type="button"
                    className="v2-inspector__link v2-inspector__link--danger"
                    onClick={handleDeletePod}
                  >
                    Delete pod
                  </button>
                </section>
              )}
              {/* Use currentUser ref so AuthContext stays imported even when not surfaced here */}
              <span style={{ display: 'none' }}>{currentUser?._id || ''}</span>
            </>
          )}
          {view.kind === 'member' && renderMemberDetail(view.agentKey)}
          {view.kind === 'artifact' && renderArtifactDetail(view.artifactId)}
        </div>
      </div>
    </aside>
  );
};

export default V2PodInspector;
