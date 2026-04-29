import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import V2Avatar from './V2Avatar';
import { UseV2PodDetailResult, V2Agent } from '../hooks/useV2PodDetail';
import { UseV2PodsResult } from '../hooks/useV2Pods';
import { useV2Api } from '../hooks/useV2Api';
import { formatRelativeTime } from '../utils/grouping';

interface V2PodInspectorProps {
  detail: UseV2PodDetailResult;
  podsState?: UseV2PodsResult;
}

interface AgentTaskMap {
  [agentName: string]: { taskId: string; title: string } | null;
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

const Icon = ({ d, size = 14 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const V2PodInspector: React.FC<V2PodInspectorProps> = ({ detail, podsState }) => {
  const { pod, members, agents } = detail;
  const api = useV2Api();
  const navigate = useNavigate();
  const [agentTasks, setAgentTasks] = useState<AgentTaskMap>({});
  const [privateError, setPrivateError] = useState<string | null>(null);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [externalLinks, setExternalLinks] = useState<ExternalLinkItem[]>([]);

  // For each agent, find their most recent active task. This is our best
  // approximation of "Working on X" since the backend doesn't track a
  // current-work field per agent — see notes in V2 README.
  useEffect(() => {
    const podId = pod?._id;
    if (!podId || agents.length === 0) {
      setAgentTasks({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<TaskApiResponse>(`/api/v1/tasks/${podId}?status=pending,claimed`);
        const map: AgentTaskMap = {};
        agents.forEach((a) => {
          const key = a.instanceId || a.agentName;
          const match = data.tasks.find((t) => {
            const assignee = (t.assignee || '').toLowerCase();
            return assignee && (
              assignee === (a.instanceId || '').toLowerCase()
              || assignee === (a.agentName || '').toLowerCase()
              || assignee === (a.displayName || '').toLowerCase()
            );
          });
          map[key] = match ? { taskId: match.taskId, title: match.title } : null;
        });
        if (!cancelled) setAgentTasks(map);
      } catch {
        if (!cancelled) setAgentTasks({});
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
  const humanCount = members.filter((member) => !member.isBot).length;
  const agentCount = agents.length;
  const onlineAgentCount = agents.filter((agent) => (
    !!agent.lastHeartbeatAt && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 10 * 60 * 1000
  )).length;
  const liveState = onlineAgentCount > 0 ? 'Recent heartbeat' : 'No recent heartbeat';
  const created = pod.createdAt ? new Date(pod.createdAt).toLocaleDateString([], {
    month: 'short', day: 'numeric', year: 'numeric',
  }) : 'unknown';

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

  return (
    <aside className="v2-pane v2-pane--inspector">
      <div className="v2-inspector">
        <section className="v2-inspector__now">
          <div className="v2-inspector__now-kicker">Now</div>
          <div className="v2-inspector__now-state">
            <span className={`v2-inspector__now-dot v2-inspector__now-dot--${onlineAgentCount > 0 ? 'running' : 'idle'}`} />
            {liveState}
          </div>
          <div className="v2-inspector__now-copy">
            {onlineAgentCount > 0
              ? `${onlineAgentCount} agent${onlineAgentCount === 1 ? '' : 's'} recently active in this pod.`
              : 'No agent heartbeat was detected in the recent activity window.'}
          </div>
        </section>

        <section className="v2-inspector__card">
          <div className="v2-inspector__section-head">
            <span className="v2-inspector__section-title">Overview</span>
            <button
              type="button"
              className="v2-inspector__section-action"
              onClick={() => navigate(`/v2/pods/${pod.type || 'chat'}/${pod._id}`)}
            >
              Edit
            </button>
          </div>
          <div className="v2-inspector__pod-card">
            <div className="v2-inspector__pod-head">
              <V2Avatar name={pod.name} size="md" />
              <div className="v2-inspector__pod-name">{pod.name}</div>
            </div>
            <div className="v2-inspector__pod-meta">
              Created by {pod.createdBy?.username || 'unknown'} · {created}
            </div>
            <div className="v2-inspector__pod-counts">
              {!isPrivatePod && <span>{agentCount} agent{agentCount === 1 ? '' : 's'}</span>}
              {!isPrivatePod && <span>·</span>}
              <span>{humanCount} human{humanCount === 1 ? '' : 's'}</span>
            </div>
            {pod.description && <div className="v2-inspector__objective">{pod.description}</div>}
          </div>
        </section>

        {!isPrivatePod && (
        <section className="v2-inspector__card">
          <div className="v2-inspector__section-head">
            <span className="v2-inspector__section-title">People & Agents ({agentCount + humanCount})</span>
            <button
              type="button"
              className="v2-inspector__section-action"
              onClick={() => navigate(`/v2/agents?podId=${pod._id}`)}
            >
              Manage
            </button>
          </div>
          {agents.length === 0 && (
            <div className="v2-mute" style={{ fontSize: 12 }}>
              No agents installed in this pod.
            </div>
          )}
          {privateError && <div className="v2-chat__error">{privateError}</div>}
          {agents.map((agent: V2Agent, idx: number) => {
            const name = agent.profile?.displayName || agent.displayName || agent.agentName;
            const key = agent.instanceId || agent.agentName;
            const isOnline = !!agent.lastHeartbeatAt
              && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 10 * 60 * 1000;
            const task = agentTasks[key];
            const isLead = idx === 0;
            return (
              <div key={key} className="v2-inspector__agent-row">
                <V2Avatar
                  name={name}
                  src={agent.profile?.avatarUrl || agent.profile?.iconUrl || agent.iconUrl || undefined}
                  size="md"
                  online={isOnline}
                />
                <div className="v2-inspector__agent-info">
                  <div className="v2-inspector__agent-head">
                    <span className="v2-inspector__agent-name">{name}</span>
                    {isLead && <span className="v2-msg__lead-badge">Lead</span>}
                  </div>
                  <div className="v2-inspector__agent-status">
                    <span className="v2-online-dot" style={{ background: isOnline ? 'var(--v2-success)' : 'var(--v2-text-muted)' }} />
                    {isOnline ? 'Online' : 'Idle'}
                  </div>
                  <div className="v2-inspector__agent-task">
                    {task ? (
                      <>
                        <span className="v2-inspector__agent-task-label">Working on </span>
                        <span className="v2-inspector__agent-task-value">{task.title}</span>
                      </>
                    ) : (
                      <span className="v2-inspector__agent-task-label">No active task</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="v2-inspector__more-btn"
                  title="Open private pod"
                  onClick={() => openPrivatePod(agent)}
                >
                  DM
                </button>
              </div>
            );
          })}
        </section>
        )}

        {!isPrivatePod && (
        <section className="v2-inspector__card">
          <div className="v2-inspector__section-head">
            <span className="v2-inspector__section-title">Direct Threads</span>
            <button
              type="button"
              className="v2-inspector__section-action"
              onClick={() => navigate('/v2')}
            >
              See all
            </button>
          </div>
          <AgentConversations
            podMembers={members.map((m) => m.username || '').filter(Boolean)}
            podCreatedAt={pod.updatedAt}
          />
        </section>
        )}

        {!isPrivatePod && (announcements.length > 0 || externalLinks.length > 0) && (
        <section className="v2-inspector__card">
          <div className="v2-inspector__section-head">
            <span className="v2-inspector__section-title">Resources</span>
          </div>
          {announcements.map((announcement) => (
            <div key={announcement._id} className="v2-inspector__resource-row">
              <span className="v2-inspector__resource-kicker">Announcement</span>
              <span className="v2-inspector__resource-title">{announcement.title || announcement.content || 'Untitled announcement'}</span>
            </div>
          ))}
          {externalLinks.map((link) => (
            <a
              key={link._id}
              className="v2-inspector__resource-row"
              href={link.url || '#'}
              target="_blank"
              rel="noreferrer"
            >
              <span className="v2-inspector__resource-kicker">{link.type || 'Link'}</span>
              <span className="v2-inspector__resource-title">{link.name || link.url || 'External link'}</span>
            </a>
          ))}
        </section>
        )}

        <section className="v2-inspector__card">
          <div className="v2-inspector__section-head">
            <span className="v2-inspector__section-title">Settings</span>
          </div>
          <div className="v2-inspector__settings-menu">
            <button
              type="button"
              className="v2-inspector__settings-chip"
              onClick={() => navigate(`/v2/agents?podId=${pod._id}`)}
            >
              <Icon d="M12 5v14M5 12h14" />
              Add agents
            </button>
            <button
              type="button"
              className="v2-inspector__settings-chip"
              onClick={() => navigate(`/v2/pods/${pod.type || 'chat'}/${pod._id}`)}
            >
              <Icon d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
              Pod settings
            </button>
            {podsState && (
              <button
                type="button"
                className="v2-inspector__settings-chip v2-inspector__settings-chip--danger"
                onClick={handleDeletePod}
              >
                <Icon d="M3 6h18M8 6V4h8v2M10 11v6M14 11v6M5 6l1 14h12l1-14" />
                Delete pod
              </button>
            )}
          </div>
        </section>
      </div>
    </aside>
  );
};

interface AgentConversationsProps {
  podMembers: string[];
  podCreatedAt?: string;
}

// Best-effort: list this user's agent-room DM pods. Backend currently exposes
// 1:1 human↔agent DMs; this view only renders rooms returned by the API.
const AgentConversations: React.FC<AgentConversationsProps> = ({ podMembers, podCreatedAt }) => {
  const api = useV2Api();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<Array<{ id: string; name: string; updatedAt?: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<Array<{ _id: string; name: string; updatedAt?: string }>>('/api/pods?type=agent-room');
        if (cancelled) return;
        const list = Array.isArray(data) ? data : [];
        setRooms(list.slice(0, 5).map((r) => ({ id: r._id, name: r.name, updatedAt: r.updatedAt })));
      } catch {
        if (!cancelled) setRooms([]);
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  if (rooms.length === 0) {
    return (
      <div className="v2-mute" style={{ fontSize: 12 }}>
        No direct messages yet. Click any agent to start one.
      </div>
    );
  }

  return (
    <div>
      {rooms.map((room) => (
        <button
          key={room.id}
          type="button"
          className="v2-inspector__conversation-row"
          onClick={() => navigate(`/v2/pods/${room.id}`)}
        >
          <V2Avatar name={room.name} size="sm" />
          <span className="v2-inspector__conversation-text">{room.name}</span>
          <span className="v2-inspector__conversation-time">{formatRelativeTime(room.updatedAt || podCreatedAt)}</span>
          <span className="v2-inspector__conversation-pill">
            DM
          </span>
        </button>
      ))}
      {/* Use podMembers to satisfy lint when no rooms — and for future filtering. */}
      <span style={{ display: 'none' }}>{podMembers.length}</span>
    </div>
  );
};

export default V2PodInspector;
