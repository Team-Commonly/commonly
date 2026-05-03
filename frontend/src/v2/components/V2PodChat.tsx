import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import V2Avatar from './V2Avatar';
import V2MessageBubble from './V2MessageBubble';
import {
  UseV2PodDetailResult,
  V2Agent,
} from '../hooks/useV2PodDetail';
import { useV2Api } from '../hooks/useV2Api';
import { UseV2PodsResult, V2PodMember } from '../hooks/useV2Pods';
import { useSocket } from '../../context/SocketContext';
import { initialsFor } from '../utils/avatars';

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
  // Inspector wiring — when present, the avatar group becomes the "show team"
  // entry. Inspector itself is rendered by V2Layout so this is just the
  // hand-off point.
  inspectorCollapsed?: boolean;
  onToggleInspector?: () => void;
  onOpenMember?: (agentKey: string) => void;
}

const Icon = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const V2PodChat: React.FC<V2PodChatProps> = ({ detail, inspectorCollapsed, onToggleInspector, onOpenMember }) => {
  const { pod, members, messages, agents, sendMessage, loading, error } = detail;
  const navigate = useNavigate();
  const api = useV2Api();
  const { socket, connected } = useSocket();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [mode, setMode] = useState<PodMode>(pod ? readMode(pod._id) : 'plan');
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

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

  // username/displayName → agent key (instanceId or agentName) so a click on
  // a chat author byline can drive the inspector to the right member sub-page.
  // Backend `message.user.username` may carry either the raw User row username
  // ("openclaw-aria") or the substituted displayName ("Strategist (Aria)") —
  // index by both so resolution survives either shape.
  const agentKeyByAuthorString = React.useMemo(() => {
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
      const key = agent.instanceId || agent.agentName;
      if (!key) continue;
      if (username) map.set(username, key);
      const display = agent.displayName || agent.profile?.displayName;
      if (display) map.set(display.toLowerCase(), key);
    }
    return map;
  }, [agents]);

  const handleAuthorClick = useCallback((author: string) => {
    if (!onOpenMember) return;
    const key = agentKeyByAuthorString.get(author.toLowerCase());
    if (key) onOpenMember(key);
  }, [agentKeyByAuthorString, onOpenMember]);

  const agentAuthorKeys = React.useMemo(
    () => new Set(agentKeyByAuthorString.keys()),
    [agentKeyByAuthorString],
  );

  // Build the @-mention list. members[] is User rows (humans + agent users);
  // agents[] is AgentInstallation rows that carry the instanceId. We want
  // @nova in the dropdown, not @openclaw-nova — so for any member that has
  // a matching installation, promote it to the agent shape (instance handle,
  // role subtitle). Agents that aren't (yet) members are appended at the end.
  const mentionableItems: MentionItem[] = useMemo(() => {
    const items: MentionItem[] = [];
    const seen = new Set<string>();

    const agentByUsername = new Map<string, V2Agent>();
    (agents || []).forEach((a) => {
      const rawName = (a as { name?: string; agentName?: string }).name || a.agentName || '';
      if (!rawName) return;
      agentByUsername.set(buildAgentUsername(rawName, a.instanceId), a);
    });

    const itemFromAgent = (a: V2Agent, fallbackAvatar: string | null = null): MentionItem | null => {
      const rawName = (a as { name?: string; agentName?: string }).name || a.agentName || '';
      if (!rawName) return null;
      const username = buildAgentUsername(rawName, a.instanceId);
      const display = a.displayName || a.profile?.displayName || rawName;
      const instance = (a.instanceId || 'default').toLowerCase();
      const mentionValue = instance && instance !== 'default' && instance !== rawName.toLowerCase()
        ? instance
        : rawName.toLowerCase();
      const avatar = a.profile?.avatarUrl || a.profile?.iconUrl || a.iconUrl || fallbackAvatar;
      return {
        id: username,
        label: display,
        labelLower: `${display} ${rawName} ${username} ${mentionValue}`.toLowerCase(),
        subtitle: `Agent · @${mentionValue}`,
        avatar,
        isAgent: true,
        value: mentionValue,
      };
    };

    (members || []).forEach((m: V2PodMember) => {
      const username = m.username || '';
      if (!username) return;
      const key = username.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const agentMatch = agentByUsername.get(key);
      if (agentMatch) {
        const item = itemFromAgent(agentMatch, m.profilePicture || null);
        if (item) items.push(item);
        return;
      }
      items.push({
        id: m._id || username,
        label: username,
        labelLower: username.toLowerCase(),
        subtitle: 'Member',
        avatar: m.profilePicture || null,
        isAgent: false,
        value: username,
      });
    });

    (agents || []).forEach((a: V2Agent) => {
      const rawName = (a as { name?: string; agentName?: string }).name || a.agentName || '';
      if (!rawName) return;
      const username = buildAgentUsername(rawName, a.instanceId);
      const key = username.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const item = itemFromAgent(a);
      if (item) items.push(item);
    });

    return items;
  }, [members, agents]);

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

  // Composer attach: pick a file → upload → send a message containing just
  // the [[upload:fileName|originalName|size|kind]] directive (or the raw
  // image URL for image kinds, which the bubble renders inline). Drafts the
  // user is composing are preserved untouched — they can keep typing and
  // hit Send when ready, and the file lands as its own message.
  //
  // Drag-and-drop in chat clients (Slack, Discord, Linear) all match this
  // shape: pick → goes-now. Inserting a directive token into the textarea
  // showed raw `[[upload:…]]` text as the user typed and felt off.
  const handleAttachFile = async (file: File | null) => {
    if (!file || uploading) return;
    setUploading(true);
    setComposerError(null);
    try {
      const formData = new FormData();
      formData.append('image', file); // legacy multer field name; route accepts non-images
      formData.append('podId', pod._id);
      const uploaded = await api.post<{
        url?: string;
        fileName?: string;
        originalName?: string;
        size?: number;
        kind?: string;
      }>('/api/uploads', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (uploaded.kind === 'image' && uploaded.url) {
        await sendMessage(uploaded.url, 'image');
        return;
      }
      if (uploaded.fileName) {
        const directive = `[[upload:${uploaded.fileName}|${uploaded.originalName || file.name}|${uploaded.size || file.size}|${uploaded.kind || 'file'}]]`;
        await sendMessage(directive);
      }
    } catch (err) {
      const e = err as { response?: { data?: { msg?: string } } };
      setComposerError(e.response?.data?.msg || 'Failed to upload file. Please try again.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSetMode = (next: PodMode) => {
    setMode(next);
    writeMode(pod._id, next);
  };

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
            </div>

            {onToggleInspector ? (
              <button
                type="button"
                className={`v2-chat__avatars v2-chat__avatars--button${inspectorCollapsed ? '' : ' v2-chat__avatars--active'}`}
                onClick={onToggleInspector}
                title={inspectorCollapsed ? 'View pod team' : 'Hide pod team'}
                aria-label={inspectorCollapsed ? 'View pod team' : 'Hide pod team'}
                aria-pressed={!inspectorCollapsed}
              >
                {visibleMembers.map((m) => (
                  <V2Avatar key={m._id || m.username} name={m.username} src={m.profilePicture || undefined} size="md" />
                ))}
                {memberCountExtra > 0 && (
                  <span className="v2-chat__avatars-more">+{memberCountExtra}</span>
                )}
              </button>
            ) : (
              <div className="v2-chat__avatars">
                {visibleMembers.map((m) => (
                  <V2Avatar key={m._id || m.username} name={m.username} src={m.profilePicture || undefined} size="md" />
                ))}
                {memberCountExtra > 0 && (
                  <span className="v2-chat__avatars-more">+{memberCountExtra}</span>
                )}
              </div>
            )}

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
              className="v2-chat__icon-btn"
              onClick={() => navigate(`/v2/pods/${pod.type || 'chat'}/${pod._id}`)}
              title="Invite people"
              aria-label="Invite people"
            >
              <Icon d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM20 8v6M17 11h6" />
            </button>

          </div>

          {pod.description && (
            <div className="v2-chat__goal">
              {pod.description}
              <span className="v2-chat__goal-meta"> · {liveState}</span>
            </div>
          )}
        </header>

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
                <V2MessageBubble
                  key={m.id}
                  message={m}
                  agentDisplayNames={agentDisplayNames}
                  agentAuthorKeys={agentAuthorKeys}
                  onAuthorClick={onOpenMember ? handleAuthorClick : undefined}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>

            <TypingIndicator agents={typingAgents} />

            <div className="v2-chat__composer">
              <div className="v2-chat__composer-input-wrap">
                <textarea
                  ref={composerInputRef}
                  className="v2-chat__composer-input"
                  placeholder={`Message ${pod.name}…`}
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
                    accept="image/*,.pdf,.md,.txt,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.zip"
                    style={{ display: 'none' }}
                    onChange={(e) => handleAttachFile(e.target.files?.[0] || null)}
                  />
                  <button
                    type="button"
                    className="v2-chat__composer-icon-btn"
                    title={uploading ? 'Uploading…' : 'Attach file'}
                    aria-label="Attach file"
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
                  title={sending ? 'Sending…' : 'Send message'}
                  aria-label={sending ? 'Sending…' : 'Send message'}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M2.5 11.4 21.2 3.1c.6-.3 1.2.3.9.9L13.8 22.7c-.3.6-1.2.6-1.4-.1l-2.7-7.4-7.4-2.7c-.7-.2-.7-1.1.2-1.1z" />
                  </svg>
                </button>
              </div>
              {composerError && (
                <div className="v2-chat__composer-footer">
                  <span className="v2-chat__composer-error">{composerError}</span>
                </div>
              )}
              <div className="v2-chat__composer-hint">
                <span><kbd>@</kbd> mention an agent</span>
                <span><kbd>⌘</kbd><kbd>↵</kbd> to send</span>
              </div>
            </div>
      </div>
    </main>
  );
};

export default V2PodChat;
