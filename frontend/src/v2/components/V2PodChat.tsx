import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import V2Avatar from './V2Avatar';
import V2MessageBubble from './V2MessageBubble';
import {
  UseV2PodDetailResult,
} from '../hooks/useV2PodDetail';
import { useV2Pinned } from '../hooks/useV2Pinned';
import { useV2Api } from '../hooks/useV2Api';
import { UseV2PodsResult } from '../hooks/useV2Pods';
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

  const leadAgentUsername = useMemo(() => {
    if (!agents || agents.length === 0) return null;
    return (agents[0].displayName || agents[0].agentName || '').toLowerCase();
  }, [agents]);

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
                  <div className="v2-empty__title">No messages yet</div>
                  <div className="v2-empty__text">Be the first to start the conversation in this pod.</div>
                </div>
              )}
              {messages.map((m) => {
                const author = (m.user?.username || '').toLowerCase();
                const isLead = !!leadAgentUsername && author === leadAgentUsername;
                return (
                  <V2MessageBubble key={m.id} message={m} isLead={isLead} />
                );
              })}
              <div ref={messagesEndRef} />
            </div>

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
                  className="v2-chat__composer-input"
                  placeholder={mode === 'plan' ? `Message ${pod.name} in plan preference...` : `Message ${pod.name} in execute preference...`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  rows={2}
                />
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
