import React, { useEffect, useMemo, useState } from 'react';
import CloseIcon from '@mui/icons-material/Close';
import ViewSidebarOutlinedIcon from '@mui/icons-material/ViewSidebarOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import V2Avatar from './V2Avatar';
import { UseV2PodDetailResult, V2Agent } from '../hooks/useV2PodDetail';
import { useV2Api } from '../hooks/useV2Api';
import { V2AttentionItem } from '../hooks/useV2PodAttention';
import V2Lightbox from './V2Lightbox';
import V2Segmented from './V2Segmented';
import { ShellGlyph, ShellGlyphName } from '../icons/glyphs';
import { getSignedAttachmentUrl } from '../../utils/signedAttachmentUrl';
import { buildAgentUsername, rawAgentName } from '../utils/threadAgentIdentity';

interface V2InspectorProps {
  detail: UseV2PodDetailResult;
  currentUserId?: string;
  onPodChanged?: () => Promise<void>;
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

type InspectorView = 'pod' | 'threads';

interface ThreadRow { rootId: string; author: string; snippet: string; lastAt: string | null }

/**
 * The pod's threads, newest activity first, from the messages already loaded.
 * A root outside the loaded window has no text to show, so it waits until
 * history reaches it rather than rendering as a blank row.
 */
export const threadRowsFrom = (messages: UseV2PodDetailResult['messages']): ThreadRow[] => {
  // A reconciled root's `id` is its old Mongo id, while replies carry the
  // root's Postgres id in thread_root_id, so the root answers to both. Rows
  // key on the exposed id, which is what the #message-<id> anchor uses.
  const byId = new Map<string, UseV2PodDetailResult['messages'][number]>();
  messages.forEach((message) => {
    byId.set(String(message.id), message);
    const { pgId } = message as { pgId?: string | number | null };
    if (pgId !== null && pgId !== undefined && pgId !== '') byId.set(String(pgId), message);
  });
  const lastAt = new Map<string, string>();
  messages.forEach((message) => {
    if (message.thread_root_id === null || message.thread_root_id === undefined) return;
    const rootId = String(byId.get(String(message.thread_root_id))?.id ?? message.thread_root_id);
    const at = message.created_at || message.createdAt || '';
    if (!lastAt.has(rootId) || at > (lastAt.get(rootId) || '')) lastAt.set(rootId, at);
  });
  const rows: ThreadRow[] = [];
  lastAt.forEach((at, rootId) => {
    const root = byId.get(rootId);
    if (!root) return;
    const author = root.user?.username
      || (typeof root.userId === 'object' ? root.userId?.username : undefined)
      || '';
    const snippet = String(root.content || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    rows.push({ rootId, author, snippet, lastAt: at || null });
  });
  return rows.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
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


// D215 (TASK-691): the panel folds. Each group is one 44px row at rest and
// opens on demand; what a person opened stays open for the session.
export type InspectorGroup = 'needs-you' | 'agents' | 'files' | 'join';
export const INSPECTOR_OPEN_KEY = 'v2:inspector.openGroups';
const readOpenGroups = (): Set<InspectorGroup> => {
  try {
    const raw = sessionStorage.getItem(INSPECTOR_OPEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as InspectorGroup[]) : []);
  } catch {
    return new Set();
  }
};
const writeOpenGroups = (groups: Set<InspectorGroup>) => {
  try {
    sessionStorage.setItem(INSPECTOR_OPEN_KEY, JSON.stringify([...groups]));
  } catch {
    // Session storage unavailable: the panel simply opens folded next time.
  }
};

const labelForAgent = (agent: V2Agent, fallback: string): string => {
  // The roster's displayName already went through resolveAgentDisplayLabel on
  // the backend for agents with a User row. This chain stops there on purpose:
  // instanceId and username are raw identifiers, which TASK-551 reports. A
  // profile name may be an older generated ID, so it is only a fallback.
  // agentName is never a label: it names the runtime or the agent type. Each
  // caller passes its own generic fallback, so no label renders blank. A
  // profile name equal to the agentName is that same name, so it is skipped.
  const profileName = agent.profile?.displayName || '';
  const profileLabel = profileName === (agent.agentName || '') ? '' : profileName;
  return agent.displayName || profileLabel || fallback;
};

const matchesAgent = (agent: V2Agent, value?: string): boolean => {
  const candidate = (value || '').trim().toLowerCase();
  if (!candidate) return false;
  // Matching never uses the generic label: '' keeps it out of the comparison.
  return candidate === (agent.agentName || '').toLowerCase()
    || candidate === labelForAgent(agent, '').toLowerCase()
    || candidate === (agent.profile?.displayName || '').toLowerCase()
    || candidate === (agent.instanceId || '').toLowerCase();
};

// An attention actor is an agentName. Match it the way agentState does, then
// name that agent. An unmatched actor gets the generic label, never its raw name.
const labelForAttentionActor = (agents: V2Agent[], actorName: string, fallback: string): string => {
  const agent = agents.find((candidate) => matchesAgent(candidate, actorName));
  return agent ? labelForAgent(agent, fallback) : fallback;
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

const V2Inspector: React.FC<V2InspectorProps> = ({ detail, currentUserId, onPodChanged, attentionItems = [], attentionCount = null, onClose, onOpenInvite }) => {
  const { pod, agents } = detail;
  const api = useV2Api();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [files, setFiles] = useState<ArtifactRow[]>([]);
  const [filesTotal, setFilesTotal] = useState(0);
  const [lightbox, setLightbox] = useState<ArtifactRow | null>(null);
  const [joinPolicy, setJoinPolicy] = useState<'open' | 'invite-only'>('open');
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<InspectorGroup>>(() => readOpenGroups());
  // D215 (TASK-734): the panel head switches between the pod and its threads.
  const [view, setView] = useState<InspectorView>('pod');
  useEffect(() => { setView('pod'); }, [pod?._id]);
  const threads = useMemo(() => threadRowsFrom(detail.messages || []), [detail.messages]);
  const toggleGroup = (group: InspectorGroup) => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group); else next.add(group);
      writeOpenGroups(next);
      return next;
    });
  };
  useEffect(() => {
    setJoinPolicy(pod?.joinPolicy === 'invite-only' ? 'invite-only' : 'open');
    setPolicyError(null);
  }, [pod?._id, pod?.joinPolicy]);
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

  const isOwner = Boolean(currentUserId && pod.createdBy?._id === currentUserId);
  const changeJoinPolicy = async (next: 'open' | 'invite-only') => {
    if (!isOwner || policyBusy || next === joinPolicy) return;
    setPolicyBusy(true);
    setPolicyError(null);
    try {
      await api.patch(`/api/pods/${encodeURIComponent(pod._id)}/join-policy`, { joinPolicy: next });
      setJoinPolicy(next);
      await Promise.all([detail.refresh(), onPodChanged?.()]);
    } catch (requestError) {
      const data = (requestError as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
      setPolicyError(data?.message || data?.error || t('inspector.workspace.joinPolicyError'));
    } finally {
      setPolicyBusy(false);
    }
  };

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
    .map((agent) => labelForAgent(agent, t('common.agent')));
  const emptyAttentionCopy = workingAgents.length > 0
    ? t('inspector.workspace.nothingWorking', { agents: workingAgents.join(' and '), count: workingAgents.length })
    : t('inspector.workspace.nothingOpen');

  const needsYouTotal = attentionCount ?? attention.length;

  const renderGroup = (
    group: InspectorGroup,
    icon: ShellGlyphName,
    label: string,
    count: number | null,
    content: React.ReactNode,
    extra?: React.ReactNode,
  ) => {
    const open = openGroups.has(group);
    const headId = `workspace-inspector-${group}`;
    return (
      <section className={`v2-workspace-inspector__card v2-workspace-inspector__group${open ? ' v2-workspace-inspector__group--open' : ''}`} aria-labelledby={headId}>
        <h2 className="v2-workspace-inspector__label">
          <button
            type="button"
            id={headId}
            className="v2-workspace-inspector__fold"
            aria-expanded={open}
            aria-controls={`${headId}-body`}
            onClick={() => toggleGroup(group)}
          >
            <span className="v2-workspace-inspector__fold-icon"><ShellGlyph name={icon} /></span>
            <span className="v2-workspace-inspector__fold-label">{label}</span>
            {count !== null && count > 0 && <span className="v2-workspace-inspector__fold-count">{count}</span>}
            {extra}
            <span className="v2-workspace-inspector__fold-chevron"><ShellGlyph name="chevron" /></span>
          </button>
        </h2>
        {open && <div id={`${headId}-body`} className="v2-workspace-inspector__group-body">{content}</div>}
      </section>
    );
  };

  return (
    <aside className="v2-pane v2-pane--inspector" aria-label={t('inspector.workspace.ariaLabel')}>
      <div className="v2-workspace-inspector">
        {/* D215: a Pod | Threads segment, then members, manage and Hide panel. */}
        <div className="v2-workspace-inspector__head">
          <V2Segmented<InspectorView>
            className="v2-workspace-inspector__view"
            ariaLabel={t('inspector.workspace.viewLabel')}
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'pod', label: t('inspector.workspace.viewPod') },
              { value: 'threads', label: t('inspector.workspace.viewThreads') },
            ]}
          />
          <span className="v2-workspace-inspector__head-spacer" aria-hidden="true" />
          {onOpenInvite && (
            <button
              type="button"
              className="v2p-b v2p-b-g v2p-ib v2p-b-sm v2-workspace-inspector__head-button"
              onClick={onOpenInvite}
              aria-label={t('inspector.workspace.members')}
              title={t('inspector.workspace.members')}
            >
              <ShellGlyph name="people" />
            </button>
          )}
          <button
            type="button"
            className="v2p-b v2p-b-g v2p-ib v2p-b-sm v2-workspace-inspector__head-button"
            onClick={() => navigate('/v2/agents')}
            aria-label={t('inspector.workspace.manage')}
            title={t('inspector.workspace.manage')}
          >
            <ShellGlyph name="gear" />
          </button>
          {onClose && (
            <button
              type="button"
              className="v2p-b v2p-b-g v2p-ib v2p-b-sm v2-workspace-inspector__head-button v2-workspace-inspector__hide"
              onClick={onClose}
              aria-label={t('inspector.workspace.hidePanel')}
              title={t('inspector.workspace.hidePanel')}
            >
              <ViewSidebarOutlinedIcon fontSize="small" aria-hidden="true" />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="v2-workspace-inspector__close"
              onClick={onClose}
              aria-label={t('inspector.workspace.close')}
              title={t('inspector.workspace.close')}
            >
              <CloseIcon fontSize="small" />
            </button>
          )}
        </div>

        {view === 'threads' && (
          <div className="v2-workspace-inspector__threads">
            {threads.length === 0 && <p className="v2-workspace-inspector__empty">{t('inspector.workspace.noThreads')}</p>}
            {threads.map((thread) => (
              <button
                key={thread.rootId}
                type="button"
                className="v2-workspace-inspector__thread"
                onClick={() => navigate(`/v2/pods/${pod._id}#message-${thread.rootId}`)}
              >
                <span className="v2-workspace-inspector__thread-head">
                  <span className="v2-workspace-inspector__thread-author">{thread.author}</span>
                  {thread.lastAt && <span className="v2-workspace-inspector__thread-when">{whenLabel(thread.lastAt)}</span>}
                </span>
                <span className="v2-workspace-inspector__thread-text">{thread.snippet}</span>
              </button>
            ))}
          </div>
        )}

        {view === 'pod' && (<>

        {renderGroup('needs-you', 'inbox', t('inspector.workspace.needsYou'), needsYouTotal, (
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
                {item.actorName && (
                  <span className="v2-workspace-inspector__actor">
                    {labelForAttentionActor(agents, item.actorName, t('common.agent'))}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}

        {renderGroup('agents', 'agents', t('inspector.workspace.agents'), agents.length, (
          <div className="v2-workspace-inspector__rows">
            {agents.length === 0 && <p className="v2-workspace-inspector__empty">{t('inspector.workspace.noAgents')}</p>}
            {agents.map((agent) => {
              const name = labelForAgent(agent, t('common.agent'));
              const username = buildAgentUsername(rawAgentName(agent), agent.instanceId);
              const member = detail.members.find((row) => row.username?.toLowerCase() === username);
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
                    src={member ? (member.profilePicture || undefined) : (agent.profilePicture || undefined)}
                    size="sm"
                    kind="agent"
                    seed={member?._id || agent.userId || `${agent.agentName}:${agent.instanceId || 'default'}`}
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
        ), agents.length > 0 && (
          <span className="v2-workspace-inspector__fold-stack" aria-hidden="true">
            {agents.slice(0, 6).map((agent) => {
              // The same face as the open row below: the member's picture wins.
              const username = buildAgentUsername(rawAgentName(agent), agent.instanceId);
              const member = detail.members.find((row) => row.username?.toLowerCase() === username);
              return (
                <V2Avatar
                  key={`${agent.agentName}:${agent.instanceId || 'default'}`}
                  className="v2-workspace-inspector__fold-avatar"
                  name={labelForAgent(agent, t('common.agent'))}
                  src={member ? (member.profilePicture || undefined) : (agent.profilePicture || undefined)}
                  size="sm"
                  kind="agent"
                  seed={member?._id || agent.userId || `${agent.agentName}:${agent.instanceId || 'default'}`}
                />
              );
            })}
          </span>
        ))}

        {renderGroup('files', 'file', t('inspector.workspace.files'), filesTotal, (
          <div className="v2-workspace-inspector__rows">
            {files.length === 0 && <p className="v2-workspace-inspector__empty">{t('inspector.workspace.noFiles')}</p>}
            {files.map((file) => (
              <button key={file.id} type="button" className="v2-workspace-inspector__file" onClick={() => {
                // ux-lead 66462: a file row opens the file — images in the lightbox, the rest in a new tab.
                if (file.kind === 'image') { setLightbox(file); return; }
                void getSignedAttachmentUrl(`/api/uploads/${file.fileName}`).then((url) => { if (url) globalThis.window.open(url, '_blank', 'noopener'); });
              }}>
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
        ))}

        {isOwner && !['agent-room', 'agent-dm', 'agent-admin'].includes(String(pod.type)) && renderGroup('join', 'lock', t('podsSidebar.create.whoCanJoin'), null, (
          <div className="v2-pod-join-settings">
            {/* D215: two exclusive values read better side by side than as radios. */}
            <V2Segmented
              ariaLabel={t('podsSidebar.create.whoCanJoin')}
              value={joinPolicy}
              disabled={policyBusy}
              onChange={(next) => { void changeJoinPolicy(next); }}
              options={[
                { value: 'open', label: t('inspector.workspace.joinOpen'), ariaLabel: t('podsSidebar.create.teamOption') },
                { value: 'invite-only', label: t('podsSidebar.create.privateOption') },
              ]}
            />
            {joinPolicy === 'open' && <p className="v2-pods__join-policy-hint">{t('podsSidebar.create.teamDescription')}</p>}
            {policyError && <p className="v2-pod-join-settings__error" role="alert">{policyError}</p>}
          </div>
        ))}
        </>)}

        {lightbox && <V2Lightbox images={[{ src: `/api/uploads/${lightbox.fileName}`, name: lightbox.name }]} index={0} onClose={() => setLightbox(null)} />}
      </div>
    </aside>
  );
};

export default V2Inspector;
