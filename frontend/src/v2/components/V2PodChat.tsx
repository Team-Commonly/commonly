import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import V2Avatar from './V2Avatar';
import V2MessageBubble from './V2MessageBubble';
import {
  UseV2PodDetailResult,
  V2Agent,
} from '../hooks/useV2PodDetail';
import { useV2Pinned } from '../hooks/useV2Pinned';
import { useV2Api } from '../hooks/useV2Api';
import { UseV2PodsResult, V2PodMember } from '../hooks/useV2Pods';
import { useSocket } from '../../context/SocketContext';
import { initialsFor } from '../utils/avatars';

const TABS = [
  { key: 'Chat', label: 'Chat', disabled: false, badge: undefined },
  { key: 'Tasks', label: 'Tasks', disabled: false, badge: undefined },
  { key: 'Summary', label: 'Summary', disabled: false, badge: undefined },
] as const;
type Tab = typeof TABS[number]['key'];

const PLAN_MODE_KEY = 'v2.podMode';

type PodMode = 'plan' | 'execute';

const podMarkFor = (name: string, type?: string): string => (
  type === 'agent-room' ? 'DM' : initialsFor(name).slice(0, 2)
);

const normalizeAgentSegment = (value: string | undefined): string =>
  (value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);

// Mirrors backend AgentIdentityService.buildAgentUsername — instance suffix
// elides when default/empty/equal to base name. Used to wire a mention back
// to the agent's User row username.
const buildAgentUsername = (agentName: string | undefined, instanceId: string | undefined): string => {
  const base = normalizeAgentSegment(agentName);
  const inst = normalizeAgentSegment(instanceId);
  if (!inst || inst === 'default' || inst === base) return base || 'agent';
  return `${base}-${inst}`;
};

// Find an "active" @-mention context in the textarea: the closest @ to the
// left of the cursor that's at start-of-string or preceded by whitespace/
// quotation, with no whitespace between it and the cursor. Mirrors v1
// ChatRoom.getMentionContext so behavior matches.
const getMentionContext = (text: string, cursor: number | null): { start: number; query: string } | null => {
  if (!text || cursor == null) return null;
  const atIndex = text.lastIndexOf('@', cursor - 1);
  if (atIndex < 0) return null;
  const beforeChar = text[atIndex - 1];
  if (beforeChar && !/\s|[([{"'`]/.test(beforeChar)) return null;
  const between = text.slice(atIndex + 1, cursor);
  if (/\s/.test(between)) return null;
  return { start: atIndex, query: between };
};

interface MentionItem {
  id: string;
  label: string;
  labelLower: string;
  subtitle: string;
  avatar?: string | null;
  isAgent: boolean;
  // Value inserted after `@`. For agents, prefer instanceId so mentions land
  // on the right instance ("@nova" not "@openclaw").
  value: string;
}

interface TypingAgentEntry {
  key: string;
  agentName: string;
  instanceId?: string;
  displayName: string;
  avatar?: string;
}

const TypingIndicator: React.FC<{ agents: TypingAgentEntry[] }> = ({ agents }) => {
  if (!agents || agents.length === 0) return null;
  const names = agents.map((a) => a.displayName);
  const label = names.length === 1
    ? `${names[0]} is thinking…`
    : names.length === 2
      ? `${names[0]} and ${names[1]} are thinking…`
      : `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length - 2 === 1 ? '' : 's'} are thinking…`;
  return (
    <div className="v2-chat__typing" aria-live="polite">
      <div className="v2-chat__typing-avatars">
        {agents.slice(0, 3).map((a) => (
          <V2Avatar key={a.key} name={a.displayName || a.agentName} src={a.avatar} size="sm" />
        ))}
      </div>
      <span className="v2-chat__typing-label">{label}</span>
      <span className="v2-chat__typing-dots" aria-hidden="true">
        <span /><span /><span />
      </span>
    </div>
  );
};

const modeCopy = (mode: PodMode) => (
  mode === 'plan'
    ? 'Discuss and plan with your agents — no actions are run.'
    : 'Agents can take actions and ship work.'
);

const readMode = (podId: string): PodMode => {
  try {
    const raw = localStorage.getItem(`${PLAN_MODE_KEY}.${podId}`);
    return raw === 'execute' ? 'execute' : 'plan';
  } catch {
    return 'plan';
  }
};

const writeMode = (podId: string, mode: PodMode) => {
  try {
    localStorage.setItem(`${PLAN_MODE_KEY}.${podId}`, mode);
  } catch {
    // localStorage unavailable; revert to default on next render.
  }
};

interface V2PodChatProps {
  detail: UseV2PodDetailResult;
  podsState?: UseV2PodsResult;
}

const Icon = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

interface V2Task {
  taskId: string;
  title: string;
  status?: string;
  assignee?: string;
  updatedAt?: string;
}

interface V2SummaryResponse {
  content?: string;
  summary?: { content?: string };
  message?: string;
}

const V2TasksView: React.FC<{ podId: string }> = ({ podId }) => {
  const api = useV2Api();
  const [tasks, setTasks] = useState<V2Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.get<{ tasks?: V2Task[] }>(`/api/v1/tasks/${podId}`);
        if (!cancelled) setTasks(Array.isArray(data.tasks) ? data.tasks : []);
      } catch (err) {
        const e = err as { response?: { data?: { error?: string; msg?: string } }; message?: string };
        if (!cancelled) setError(e.response?.data?.error || e.response?.data?.msg || e.message || 'Failed to load tasks');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api, podId]);

  if (loading) return <div className="v2-empty"><span className="v2-spinner" /></div>;
  if (error) return <div className="v2-chat__error">{error}</div>;
  if (tasks.length === 0) {
    return (
      <div className="v2-empty">
        <div className="v2-empty__title">No tasks yet</div>
        <div className="v2-empty__text">Tasks created by agents or humans in this pod will appear here.</div>
      </div>
    );
  }
  return (
    <div className="v2-tab-list">
      {tasks.map((task) => (
        <div key={task.taskId} className="v2-tab-card">
          <div className="v2-tab-card__title">{task.title}</div>
          <div className="v2-tab-card__meta">
            {task.taskId}
            {task.status ? ` · ${task.status}` : ''}
            {task.assignee ? ` · ${task.assignee}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
};

const V2SummaryView: React.FC<{ podId: string; description?: string }> = ({ podId, description }) => {
  const api = useV2Api();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = refresh
        ? await api.post<V2SummaryResponse>(`/api/summaries/pod/${podId}/refresh`, {})
        : await api.get<V2SummaryResponse>(`/api/summaries/pod/${podId}`);
      setContent(data?.summary?.content || data?.content || '');
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; msg?: string } }; message?: string };
      setError(e.response?.data?.error || e.response?.data?.msg || e.message || 'Failed to load summary');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podId]);

  return (
    <div className="v2-tab-list">
      <div className="v2-tab-card">
        <div className="v2-row v2-row--between">
          <div className="v2-tab-card__title">Pod Summary</div>
          <button type="button" className="v2-tab-card__action" onClick={() => loadSummary(true)} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        {error && <div className="v2-chat__error">{error}</div>}
        <div className="v2-tab-card__body">
          {content || description || 'No recent activity to summarize.'}
        </div>
      </div>
    </div>
  );
};

const V2PodChat: React.FC<V2PodChatProps> = ({ detail }) => {
  const { pod, members, messages, agents, sendMessage, loading, error } = detail;
  const navigate = useNavigate();
  const api = useV2Api();
  const { socket, connected } = useSocket();
  const { isPinned, toggle: togglePin } = useV2Pinned();
  const [tab, setTab] = useState<Tab>('Chat');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [mode, setMode] = useState<PodMode>(pod ? readMode(pod._id) : 'plan');
  const [taskCount, setTaskCount] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionDropdownRef = useRef<HTMLDivElement | null>(null);

  // Agent typing indicator state. Backend already emits agent_typing_start/
  // agent_typing_stop via agentTypingService — this just listens and renders.
  // Keyed by `${agentName}:${instanceId || ''}` to handle multi-instance.
  const [typingAgents, setTypingAgents] = useState<TypingAgentEntry[]>([]);
  const typingAgentTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // @-mention dropdown state. mentionStart is the index of the `@` in the
  // textarea so we know the slice to replace on select.
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionIndex, setMentionIndex] = useState(0);

  useEffect(() => {
    if (pod) setMode(readMode(pod._id));
  }, [pod?._id]);

  // Lightweight count fetch so the Tasks tab can show an honest badge.
  // Falls back silently if the API is unavailable.
  useEffect(() => {
    const podId = pod?._id;
    if (!podId) {
      setTaskCount(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<{ tasks?: V2Task[] }>(`/api/v1/tasks/${podId}?status=pending,claimed`);
        if (!cancelled) setTaskCount(Array.isArray(data.tasks) ? data.tasks.length : 0);
      } catch {
        if (!cancelled) setTaskCount(null);
      }
    })();
    return () => { cancelled = true; };
  }, [pod?._id, api, tab]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, tab]);

  // Removed: Lead-pill computation. The "Lead" label was just `idx === 0`,
  // which made whichever agent installed first (usually auto-installed
  // commonly-bot) appear as Lead — pure positional, no actual semantic.
  // If we re-introduce a lead concept, it needs real data on the
  // AgentInstallation row, not a frontend heuristic.

  // Map of agent-user username → per-installation displayName. Mirrors
  // backend AgentIdentityService.buildAgentUsername: '<agentName>' when
  // instanceId is 'default' or matches the agentName, else
  // '<agentName>-<instanceId>'. Lets V2MessageBubble render "Engineer (Nova)"
  // instead of the raw User row username "openclaw-nova".
  //
  // Note: the backend payload key is `name` (per buildAgentInstallationPayload
  // in registry helpers), but V2Agent's TypeScript shape declares `agentName`
  // — the type doesn't match the wire. Read both to survive either source.
  const agentDisplayNames = React.useMemo(() => {
    const map = new Map<string, string>();
    if (!agents) return map;
    for (const agent of agents) {
      const rawName = (agent as { name?: string; agentName?: string }).name
        || agent.agentName || '';
      const name = rawName.toLowerCase();
      const instance = (agent.instanceId || '').toLowerCase();
      const username = !instance || instance === 'default' || instance === name
        ? name
        : `${name}-${instance}`;
      const display = agent.displayName || agent.profile?.displayName || rawName;
      if (username && display) map.set(username, display);
    }
    return map;
  }, [agents]);

  // Build the @-mention list: pod members (humans) + installed agents. Same
  // shape and dedup rules as v1 ChatRoom — agent identity is keyed on the
  // computed username so we don't list the same agent twice when it appears
  // both as a member and as an installation.
  const mentionableItems: MentionItem[] = useMemo(() => {
    const items: MentionItem[] = [];
    const seen = new Set<string>();

    (members || []).forEach((m: V2PodMember) => {
      const username = m.username || '';
      if (!username) return;
      const key = username.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const overridden = agentDisplayNames.get(key);
      const isAgent = Boolean(overridden);
      items.push({
        id: m._id || username,
        label: overridden || username,
        labelLower: `${overridden || ''} ${username}`.toLowerCase(),
        subtitle: isAgent ? 'Agent' : 'Member',
        avatar: m.profilePicture || null,
        isAgent,
        value: isAgent ? username : username,
      });
    });

    (agents || []).forEach((a: V2Agent) => {
      const rawName = (a as { name?: string; agentName?: string }).name || a.agentName || '';
      if (!rawName) return;
      const username = buildAgentUsername(rawName, a.instanceId);
      const key = username.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const display = a.displayName || a.profile?.displayName || rawName;
      const instance = (a.instanceId || 'default').toLowerCase();
      // Prefer instanceId for the mention value when it's distinct — disambiguates
      // multi-instance agents (e.g. @nova vs the base @openclaw).
      const mentionValue = instance && instance !== 'default' && instance !== rawName.toLowerCase()
        ? instance
        : rawName.toLowerCase();
      const avatar = a.profile?.avatarUrl || a.profile?.iconUrl || a.iconUrl || null;
      items.push({
        id: username,
        label: display,
        labelLower: `${display} ${rawName} ${username} ${mentionValue}`.toLowerCase(),
        subtitle: `Agent · @${mentionValue}`,
        avatar,
        isAgent: true,
        value: mentionValue,
      });
    });

    return items;
  }, [members, agents, agentDisplayNames]);

  const filteredMentions: MentionItem[] = useMemo(() => {
    if (!mentionOpen) return [];
    const q = mentionQuery.trim().toLowerCase();
    return mentionableItems.filter((item) => item.labelLower.includes(q)).slice(0, 8);
  }, [mentionOpen, mentionQuery, mentionableItems]);

  const updateMentionState = useCallback((nextValue: string, cursorPosition: number | null) => {
    const ctx = getMentionContext(nextValue, cursorPosition);
    if (!ctx) {
      setMentionOpen(false);
      setMentionQuery('');
      setMentionStart(-1);
      return;
    }
    setMentionOpen(true);
    setMentionQuery(ctx.query);
    setMentionStart(ctx.start);
    setMentionIndex(0);
  }, []);

  const handleMentionSelect = useCallback((item: MentionItem) => {
    const input = composerInputRef.current;
    if (!input) return;
    const cursor = input.selectionStart ?? draft.length;
    const start = mentionStart >= 0 ? mentionStart : draft.lastIndexOf('@', cursor);
    if (start < 0) return;
    const insert = `@${item.value || item.label}`;
    const next = `${draft.slice(0, start)}${insert} ${draft.slice(cursor)}`;
    setDraft(next);
    setMentionOpen(false);
    setMentionQuery('');
    setMentionStart(-1);
    requestAnimationFrame(() => {
      const nextCursor = start + insert.length + 1;
      input.focus();
      input.setSelectionRange(nextCursor, nextCursor);
    });
  }, [draft, mentionStart]);

  // Clear typing indicators on pod change so we never carry indicators from
  // another room into the current view.
  useEffect(() => {
    setTypingAgents([]);
    Object.values(typingAgentTimersRef.current).forEach(clearTimeout);
    typingAgentTimersRef.current = {};
  }, [pod?._id]);

  // Subscribe to agent typing events. Backend emits via agentTypingService;
  // safety timeout drops stale entries if a stop event is missed.
  useEffect(() => {
    const podId = pod?._id;
    if (!podId || !socket || !connected) return undefined;

    const keyFor = (p: { agentName?: string; instanceId?: string }) =>
      `${p?.agentName || ''}:${p?.instanceId || ''}`;
    const scheduleAutoStop = (key: string) => {
      if (typingAgentTimersRef.current[key]) clearTimeout(typingAgentTimersRef.current[key]);
      typingAgentTimersRef.current[key] = setTimeout(() => {
        setTypingAgents((prev) => prev.filter((a) => a.key !== key));
        delete typingAgentTimersRef.current[key];
      }, 30000);
    };

    interface TypingPayload {
      podId?: string;
      agentName?: string;
      username?: string;
      instanceId?: string;
      displayName?: string;
      avatar?: string;
      iconUrl?: string;
    }
    const handleStart = (payload: TypingPayload) => {
      if (!payload || (payload.podId && payload.podId !== podId)) return;
      const agentName = payload.agentName || payload.username;
      if (!agentName) return;
      const key = keyFor({ agentName, instanceId: payload.instanceId });
      scheduleAutoStop(key);
      setTypingAgents((prev) => {
        const next: TypingAgentEntry = {
          key,
          agentName,
          instanceId: payload.instanceId,
          displayName: payload.displayName || payload.instanceId || agentName,
          avatar: payload.avatar || payload.iconUrl,
        };
        const exists = prev.find((a) => a.key === key);
        return exists ? prev.map((a) => (a.key === key ? next : a)) : [...prev, next];
      });
    };
    const handleStop = (payload: TypingPayload) => {
      const agentName = payload?.agentName || payload?.username;
      if (!agentName) return;
      const key = keyFor({ agentName, instanceId: payload.instanceId });
      if (typingAgentTimersRef.current[key]) {
        clearTimeout(typingAgentTimersRef.current[key]);
        delete typingAgentTimersRef.current[key];
      }
      setTypingAgents((prev) => prev.filter((a) => a.key !== key));
    };

    socket.on('agent_typing_start', handleStart);
    socket.on('agent_typing_stop', handleStop);
    return () => {
      socket.off('agent_typing_start', handleStart);
      socket.off('agent_typing_stop', handleStop);
      Object.values(typingAgentTimersRef.current).forEach(clearTimeout);
      typingAgentTimersRef.current = {};
    };
  }, [pod?._id, socket, connected]);

  // Click outside the mention dropdown closes it.
  useEffect(() => {
    if (!mentionOpen) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (mentionDropdownRef.current && target && mentionDropdownRef.current.contains(target)) return;
      if (composerInputRef.current && target && composerInputRef.current.contains(target)) return;
      setMentionOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [mentionOpen]);

  if (!pod) {
    return (
      <main className="v2-pane v2-pane--main">
        <div className="v2-empty">
          <div className="v2-empty__title">No pod selected</div>
          <div className="v2-empty__text">Pick a pod from the sidebar, or create a new one to get started.</div>
        </div>
      </main>
    );
  }

  const handleSend = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    setComposerError(null);
    try {
      const created = await sendMessage(draft);
      if (created) setDraft('');
    } finally {
      setSending(false);
    }
  };

  const handleAttachImage = async (file: File | null) => {
    if (!file || uploading) return;
    if (!file.type.startsWith('image/')) {
      setComposerError('Only image files are supported here.');
      return;
    }
    setUploading(true);
    setComposerError(null);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const uploaded = await api.post<{ url?: string }>('/api/uploads', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (uploaded.url) {
        await sendMessage(uploaded.url, 'image');
      }
    } catch {
      setComposerError('Failed to upload image. Please try again.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSetMode = (next: PodMode) => {
    setMode(next);
    writeMode(pod._id, next);
  };

  const togglePodPin = () => togglePin(pod._id);

  const visibleMembers = members.slice(0, 3);
  const memberCountExtra = Math.max(0, members.length - visibleMembers.length);
  const onlineAgentCount = agents.filter((agent) => (
    !!agent.lastHeartbeatAt && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 10 * 60 * 1000
  )).length;
  const liveState = onlineAgentCount > 0
    ? `${onlineAgentCount} recent heartbeat${onlineAgentCount === 1 ? '' : 's'}`
    : 'No recent heartbeats';

  return (
    <main className="v2-pane v2-pane--main">
      <div className="v2-chat">
        <header className="v2-chat__header">
          <div className="v2-chat__header-row">
            <div className="v2-chat__title">
              <span className="v2-chat__title-mark">{podMarkFor(pod.name, pod.type)}</span>
              <span className="v2-chat__title-text">{pod.name}</span>
              <button
                type="button"
                className="v2-chat__star"
                onClick={togglePodPin}
                title={isPinned(pod._id) ? 'Unpin' : 'Pin'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill={isPinned(pod._id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
                </svg>
              </button>
            </div>

            <div className="v2-chat__avatars">
              {visibleMembers.map((m) => (
                <V2Avatar key={m._id || m.username} name={m.username} src={m.profilePicture || undefined} size="md" />
              ))}
              {memberCountExtra > 0 && (
                <span className="v2-chat__avatars-more">+{memberCountExtra}</span>
              )}
            </div>

            <div className={`v2-chat__mode-toggle v2-chat__mode-toggle--header v2-chat__mode-toggle--${mode}`} role="group" aria-label="Pod mode preference">
              <button
                type="button"
                className={`v2-chat__mode-option${mode === 'plan' ? ' v2-chat__mode-option--active' : ''}`}
                onClick={() => handleSetMode('plan')}
                aria-pressed={mode === 'plan'}
                title={modeCopy('plan')}
              >
                <Icon d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                Plan
              </button>
              <button
                type="button"
                className={`v2-chat__mode-option${mode === 'execute' ? ' v2-chat__mode-option--active' : ''}`}
                onClick={() => handleSetMode('execute')}
                aria-pressed={mode === 'execute'}
                title={modeCopy('execute')}
              >
                <Icon d="M5 3l14 9-14 9V3z" />
                Execute
              </button>
            </div>

            <button
              type="button"
              className="v2-chat__btn"
              onClick={() => navigate(`/v2/pods/${pod.type || 'chat'}/${pod._id}`)}
              title="Open full pod member tools"
            >
              <Icon d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM20 8v6M17 11h6" />
              Invite
            </button>

          </div>

          {pod.description && (
            <div className="v2-chat__goal">
              <span className="v2-chat__goal-label">Goal: </span>
              {pod.description}
              <span className="v2-chat__goal-meta"> · {liveState}</span>
            </div>
          )}
        </header>

        <div className="v2-chat__tabs">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`v2-chat__tab${tab === item.key ? ' v2-chat__tab--active' : ''}${item.disabled ? ' v2-chat__tab--disabled' : ''}`}
              onClick={() => {
                if (!item.disabled) setTab(item.key);
              }}
              disabled={item.disabled}
              title={item.disabled ? `${item.label} needs backend support` : item.label}
            >
              {item.label}
              {item.key === 'Chat' && messages.length > 0 && (
                <span className="v2-chat__tab-badge">{messages.length}</span>
              )}
              {item.key === 'Tasks' && taskCount !== null && taskCount > 0 && (
                <span className="v2-chat__tab-badge">{taskCount}</span>
              )}
            </button>
          ))}
        </div>

        {tab === 'Chat' && (
          <>
            <div className="v2-chat__messages">
              {error && (
                <div className="v2-chat__error">
                  {error}
                </div>
              )}
              {loading && messages.length === 0 && (
                <div className="v2-empty"><span className="v2-spinner" /></div>
              )}
              {!loading && messages.length === 0 && (
                <div className="v2-empty">
                  <div className="v2-empty__title">Talk to your team</div>
                  <div className="v2-empty__text">Type a message, or @-mention an agent to direct your first task.</div>
                </div>
              )}
              {messages.map((m) => (
                <V2MessageBubble key={m.id} message={m} agentDisplayNames={agentDisplayNames} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            <TypingIndicator agents={typingAgents} />

            <div className="v2-chat__composer">
              <div className="v2-chat__composer-kicker">
                <span className={`v2-chat__composer-mode v2-chat__composer-mode--${mode}`}>
                  {mode === 'plan' ? 'Plan mode' : 'Execute mode'}
                </span>
                <span>Send to pod</span>
                <span className="v2-chat__composer-hint">Enter sends, Shift+Enter adds a line</span>
              </div>
              <div className="v2-chat__composer-input-wrap">
                <textarea
                  ref={composerInputRef}
                  className="v2-chat__composer-input"
                  placeholder={mode === 'plan' ? `Message ${pod.name} in plan preference...` : `Message ${pod.name} in execute preference...`}
                  value={draft}
                  onChange={(e) => {
                    const next = e.target.value;
                    setDraft(next);
                    updateMentionState(next, e.target.selectionStart);
                  }}
                  onClick={(e) => updateMentionState(
                    (e.target as HTMLTextAreaElement).value,
                    (e.target as HTMLTextAreaElement).selectionStart,
                  )}
                  onKeyUp={(e) => updateMentionState(
                    (e.target as HTMLTextAreaElement).value,
                    (e.target as HTMLTextAreaElement).selectionStart,
                  )}
                  onKeyDown={(e) => {
                    if (mentionOpen && filteredMentions.length > 0) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setMentionIndex((p) => (p + 1) % filteredMentions.length);
                        return;
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setMentionIndex((p) => (p - 1 + filteredMentions.length) % filteredMentions.length);
                        return;
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setMentionOpen(false);
                        return;
                      }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        const sel = filteredMentions[mentionIndex];
                        if (sel) handleMentionSelect(sel);
                        return;
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  rows={2}
                />
                {mentionOpen && filteredMentions.length > 0 && (
                  <div className="v2-mention-dropdown" ref={mentionDropdownRef} role="listbox">
                    {filteredMentions.map((item, idx) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`v2-mention-item${idx === mentionIndex ? ' v2-mention-item--active' : ''}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleMentionSelect(item)}
                        role="option"
                        aria-selected={idx === mentionIndex}
                      >
                        <V2Avatar name={item.label} src={item.avatar || undefined} size="sm" />
                        <span className="v2-mention-item__text">
                          <span className="v2-mention-item__label">@{item.value || item.label}</span>
                          <span className="v2-mention-item__sub">{item.subtitle}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="v2-chat__composer-actions">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => handleAttachImage(e.target.files?.[0] || null)}
                  />
                  <button
                    type="button"
                    className="v2-chat__composer-icon-btn"
                    title={uploading ? 'Uploading...' : 'Attach image'}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    <Icon d="M21 11l-9 9a5 5 0 01-7-7l9-9a3 3 0 014 4l-9 9a1 1 0 01-2-2l8-8" />
                  </button>
                </div>
                <button
                  type="button"
                  className={`v2-chat__send v2-chat__send--${mode}`}
                  onClick={handleSend}
                  disabled={sending || !draft.trim()}
                  title={sending ? 'Sending...' : 'Send message'}
                >
                  <Icon d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                  <span>Send</span>
                </button>
              </div>
              <div className="v2-chat__composer-footer">
                {composerError ? (
                  <span className="v2-chat__composer-error">{composerError}</span>
                ) : (
                  <span>Attach files with the paperclip. @-mention an agent to direct your message.</span>
                )}
              </div>
            </div>
          </>
        )}

        {tab === 'Tasks' && <V2TasksView podId={pod._id} />}
        {tab === 'Summary' && <V2SummaryView podId={pod._id} description={pod.description} />}
      </div>
    </main>
  );
};

export default V2PodChat;
