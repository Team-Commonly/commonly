import React, { useEffect, useMemo, useState } from 'react';
import CloseIcon from '@mui/icons-material/Close';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import V2Avatar from './V2Avatar';
import { UseV2PodDetailResult, V2Agent } from '../hooks/useV2PodDetail';
import { useV2Api } from '../hooks/useV2Api';
import { V2AttentionItem } from '../hooks/useV2PodAttention';

interface V2InspectorProps {
  detail: UseV2PodDetailResult;
  attentionItems?: V2AttentionItem[];
  attentionCount?: number | null;
  onClose?: () => void;
  onOpenInvite?: () => void;
}

interface ArtifactRow { id: string; fileName: string; name: string; kind: 'image' | 'page' | 'doc'; createdAt: string | null }
interface ArtifactsPage { items?: ArtifactRow[]; total?: number }

const extOf = (name: string): string => { const m = /\.([a-z0-9]{1,5})$/i.exec(name || ''); return m ? m[1].toUpperCase() : 'FILE'; };
const whenLabel = (value: string | null | undefined): string => {
  if (!value) return '';
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`;
};

interface TaskItem {
  taskId: string;
  title: string;
  status: string;
  assignee?: string;
  updatedAt?: string;
}

const isWorkingTask = (task: TaskItem): boolean => (
  task.status === 'claimed' || task.status === 'in_progress'
);

const isDoneTask = (task: TaskItem): boolean => (
  task.status === 'done' || task.status === 'completed'
);

const labelForAgent = (agent: V2Agent): string => (
  agent.profile?.displayName || agent.displayName || agent.agentName
);

// Pods often carry a longer descriptive title, while the compact inspector
// heading uses the room's short leading name (for example, “Sharpen”).
const shortRoomName = (name: string): string => (
  name.trim().split(/\s*[·—–:|]\s*/)[0].trim() || name.trim()
);

const matchesAgent = (agent: V2Agent, value?: string): boolean => {
  const candidate = (value || '').toLowerCase();
  return candidate === (agent.agentName || '').toLowerCase()
    || candidate === labelForAgent(agent).toLowerCase()
    || candidate === (agent.instanceId || '').toLowerCase();
};

const agentState = (
  agent: V2Agent,
  attention: V2AttentionItem[],
  tasks: TaskItem[],
): { kind: 'needs-you' | 'working' | 'idle'; title?: string } => {
  const request = attention.find((item) => matchesAgent(agent, item.actorName));
  if (request) return { kind: 'needs-you', title: request.title };

  const task = tasks.find((item) => isWorkingTask(item) && matchesAgent(agent, item.assignee));
  if (task) return { kind: 'working', title: task.title };

  if (agent.status === 'working') return { kind: 'working' };
  return { kind: 'idle' };
};

const V2Inspector: React.FC<V2InspectorProps> = ({ detail, attentionItems = [], attentionCount = null, onClose, onOpenInvite }) => {
  const { pod, agents } = detail;
  const api = useV2Api();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [files, setFiles] = useState<ArtifactRow[]>([]);
  const [filesTotal, setFilesTotal] = useState(0);
  const attention = useMemo(
    () => attentionItems.filter((item) => item.podId === pod?._id),
    [attentionItems, pod?._id],
  );

  useEffect(() => {
    if (!pod?._id) {
      setTasks([]);
      return undefined;
    }
    let active = true;
    api.get<{ tasks?: TaskItem[] }>(`/api/v1/tasks/${encodeURIComponent(pod._id)}`)
      .then((data) => { if (active) setTasks(Array.isArray(data?.tasks) ? data.tasks : []); })
      .catch(() => { if (active) setTasks([]); });
    return () => { active = false; };
  }, [api, pod?._id]);

  const board = useMemo(() => {
    const open = tasks.filter((task) => task.status === 'pending').length;
    const inProgress = tasks.filter(isWorkingTask).length;
    const done = tasks.filter(isDoneTask).length;
    const rows = [...tasks]
      .sort((left, right) => {
        const rank = (task: TaskItem) => isWorkingTask(task) ? 0 : task.status === 'pending' ? 1 : isDoneTask(task) ? 2 : 3;
        return rank(left) - rank(right)
          || new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
      })
      .slice(0, 3);
    return { open, inProgress, done, rows };
  }, [tasks]);

  // Files pane (PR 5, 66366 §4): the same /api/artifacts query with podId fixed.
  useEffect(() => {
    if (!pod?._id) { setFiles([]); setFilesTotal(0); return undefined; }
    let active = true;
    api.get<ArtifactsPage>(`/api/artifacts?podId=${encodeURIComponent(pod._id)}&limit=5`)
      .then((data) => {
        if (!active) return;
        setFiles(Array.isArray(data?.items) ? data.items : []);
        setFilesTotal(typeof data?.total === 'number' ? data.total : (Array.isArray(data?.items) ? data.items.length : 0));
      })
      .catch(() => { if (active) { setFiles([]); setFilesTotal(0); } });
    return () => { active = false; };
  }, [api, pod?._id]);

  if (!pod) return null;

  const openAttention = (item: V2AttentionItem) => {
    const target = item.threadRootId || item.messageId;
    navigate(`/v2/pods/${item.podId}${target ? `#message-${target}` : ''}`);
  };

  const agentStatus = (state: ReturnType<typeof agentState>): string => {
    if (state.kind === 'needs-you') return t('inspector.workspace.agentStatus.needsYou', { title: state.title });
    if (state.kind === 'working' && state.title) return t('inspector.workspace.agentStatus.workingTask', { title: state.title });
    if (state.kind === 'working') return t('inspector.workspace.agentStatus.working');
    return t('inspector.workspace.agentStatus.idle');
  };

  const workingAgents = agents
    .filter((agent) => agentState(agent, attention, tasks).kind === 'working')
    .map(labelForAgent);
  const emptyAttentionCopy = workingAgents.length > 0
    ? t('inspector.workspace.nothingWorking', { agents: workingAgents.join(' and '), count: workingAgents.length })
    : t('inspector.workspace.nothingOpen');

  return (
    <aside className="v2-pane v2-pane--inspector" aria-label={t('inspector.workspace.ariaLabel')}>
      <div className="v2-workspace-inspector">
        {onClose && (
          <button type="button" className="v2-workspace-inspector__close" onClick={onClose} aria-label={t('inspector.workspace.close')}>
            <CloseIcon fontSize="small" />
          </button>
        )}

        <section className="v2-workspace-inspector__card" aria-labelledby="workspace-inspector-agents">
          <h2 id="workspace-inspector-agents" className="v2-workspace-inspector__label">
            {t('inspector.workspace.agentsIn', { pod: shortRoomName(pod.name).toLowerCase() })}
          </h2>
          <div className="v2-workspace-inspector__rows">
            {agents.length === 0 && <p className="v2-workspace-inspector__empty">{t('inspector.workspace.noAgents')}</p>}
            {agents.map((agent) => {
              const name = labelForAgent(agent);
              const state = agentState(agent, attention, tasks);
              const status = agentStatus(state);
              return (
                <button
                  key={`${agent.agentName}:${agent.instanceId || 'default'}`}
                  type="button"
                  className="v2-workspace-inspector__agent"
                  onClick={() => agent.agentName && navigate(`/v2/agent/${encodeURIComponent(agent.agentName)}/${encodeURIComponent(agent.instanceId || 'default')}`)}
                  disabled={!agent.agentName}
                >
                  <V2Avatar
                    className="v2-workspace-inspector__avatar"
                    name={name}
                    src={agent.profile?.avatarUrl || agent.profile?.iconUrl || agent.iconUrl || undefined}
                    size="sm"
                  />
                  <span className="v2-workspace-inspector__agent-copy">
                    <span className="v2-workspace-inspector__agent-name">{name}</span>
                    <span className="v2-workspace-inspector__agent-status" title={status}>{status}</span>
                  </span>
                  <span className={`v2-workspace-inspector__state v2-workspace-inspector__state--${state.kind}`} aria-label={state.kind} />
                </button>
              );
            })}
          </div>
        </section>

        <section className="v2-workspace-inspector__card" aria-labelledby="workspace-inspector-needs-you">
          <h2 id="workspace-inspector-needs-you" className="v2-workspace-inspector__label">{t('inspector.workspace.needsYou')}</h2>
          <div className="v2-workspace-inspector__rows">
            {attentionCount === 0 && <p className="v2-workspace-inspector__empty">{emptyAttentionCopy}</p>}
            {attentionCount !== null && attentionCount > 0 && (
              <button type="button" className="v2-workspace-inspector__attention" onClick={() => navigate('/v2/activity')}>
                {t('activity.needsYou.countLabel', { count: attentionCount })}
              </button>
            )}
            {attention.map((item) => (
              <button key={`${item.kind}:${item.id}`} type="button" className="v2-workspace-inspector__attention" onClick={() => openAttention(item)}>
                <span>{item.title}</span>
                {item.actorName && <span className="v2-workspace-inspector__actor">{item.actorName}</span>}
              </button>
            ))}
          </div>
        </section>

        <section className="v2-workspace-inspector__card" aria-labelledby="workspace-inspector-board">
          <h2 id="workspace-inspector-board" className="v2-workspace-inspector__label">{t('inspector.workspace.boardToday')}</h2>
          <button type="button" className="v2-workspace-inspector__board-counts" onClick={() => navigate(`/v2/pods/${pod._id}/board`)}>
            {t('inspector.workspace.boardCounts', board)}
          </button>
          <div className="v2-workspace-inspector__rows">
            {board.rows.map((task) => (
              <button key={task.taskId} type="button" className="v2-workspace-inspector__task" onClick={() => navigate(`/v2/pods/${pod._id}/board`)}>
                <span>{task.title}</span>
                <span className="v2-workspace-inspector__task-meta">{task.assignee || (isWorkingTask(task) ? t('inspector.workspace.wip') : task.status)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="v2-workspace-inspector__card" aria-labelledby="workspace-inspector-files">
          <h2 id="workspace-inspector-files" className="v2-workspace-inspector__label">
            {t('inspector.workspace.filesIn', { pod: shortRoomName(pod.name).toLowerCase() })}
          </h2>
          <div className="v2-workspace-inspector__rows">
            {files.length === 0 && <p className="v2-workspace-inspector__empty">{t('inspector.workspace.noFiles')}</p>}
            {files.map((file) => (
              <button key={file.id} type="button" className="v2-workspace-inspector__file" onClick={() => navigate(`/v2/artifacts?podId=${encodeURIComponent(pod._id)}&q=${encodeURIComponent(file.name)}`)}>
                <span className="v2-workspace-inspector__ext" aria-hidden="true">{extOf(file.name)}</span>
                <span>{file.name}</span>
                <span className="v2-workspace-inspector__task-meta">{whenLabel(file.createdAt)}</span>
              </button>
            ))}
            {filesTotal > 0 && (
              <button type="button" className="v2-workspace-inspector__all-files" onClick={() => navigate(`/v2/artifacts?podId=${encodeURIComponent(pod._id)}`)}>
                {t('inspector.workspace.allFiles', { count: filesTotal })}
              </button>
            )}
          </div>
        </section>

        <footer className="v2-workspace-inspector__foot">
          {onOpenInvite && <button type="button" onClick={onOpenInvite}>{t('inspector.workspace.members')}</button>}
          <button type="button" onClick={() => navigate(`/v2/agents/manage?podId=${encodeURIComponent(pod._id)}`)}>{t('inspector.workspace.manage')}</button>
        </footer>
      </div>
    </aside>
  );
};

export default V2Inspector;
