import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UseV2PodsResult, V2Pod, useV2Pods } from '../hooks/useV2Pods';
import { groupPods, formatRelativeTime } from '../utils/grouping';
import { initialsFor } from '../utils/avatars';
import { useV2Pinned } from '../hooks/useV2Pinned';
import { useV2Unread } from '../hooks/useV2Unread';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';

type Filter = 'all' | 'team' | 'private';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'team', label: 'Team' },
  { key: 'private', label: 'Private' },
];

const isDmPod = (pod: V2Pod): boolean => pod.type === 'agent-room';
const podKind = (pod: V2Pod): 'team' | 'private' => (isDmPod(pod) ? 'private' : 'team');

const podMarkFor = (pod: V2Pod): string => (
  podKind(pod) === 'private' ? 'DM' : initialsFor(pod.name).slice(0, 2)
);

const podMarkClass = (pod: V2Pod): string => (
  `v2-pods__item-icon v2-pods__item-icon--${podKind(pod)}`
);

const agentCountFor = (pod: V2Pod): number => (
  (pod.members || []).filter((member) => typeof member === 'object' && !!member?.isBot).length
);

// Slack/iMessage pattern: line 2 of each row is the most recent message
// preview, with the author prefix when it's not the current user. Falls back
// to description/meta when the pod has no messages yet (newly-created pods).
const podSnippetFor = (pod: V2Pod, meta: string): string => {
  const last = pod.lastMessage;
  if (last && last.content) {
    const author = last.username ? `${last.username}: ` : '';
    const content = last.content.replace(/\s+/g, ' ').trim();
    return `${author}${content}`;
  }
  return pod.description?.trim() || meta;
};

const matchesFilter = (pod: V2Pod, filter: Filter): boolean => {
  switch (filter) {
    // "Team" is the strictest pod-type filter — only pods explicitly typed
    // as team (multi-human collaborative). "Private" is 1:1 DMs.
    // "All" covers everything (the redundant "Pod" filter was removed).
    case 'team': return pod.type === 'team';
    case 'private': return podKind(pod) === 'private';
    case 'all':
    default:
      return true;
  }
};

interface V2PodsSidebarProps {
  selectedPodId: string | null;
  podsState?: UseV2PodsResult;
}

const V2PodsSidebar: React.FC<V2PodsSidebarProps> = ({ selectedPodId, podsState }) => {
  const navigate = useNavigate();
  const ownPodsState = useV2Pods();
  const { pods, loading, error, createPod, patchLastMessage } = podsState || ownPodsState;
  const { pinned, toggle: togglePin, isPinned } = useV2Pinned();
  const { socket, connected, joinPod } = useSocket();
  const { currentUser } = useAuth();
  const { isUnread, bumpLatest, seedFromExisting } = useV2Unread(selectedPodId);

  // Seed lastSeen for any pod we've never observed before, using its current
  // newest-message timestamp. Without this, the very first load badges every
  // pod the user is a member of as unread — they aren't. Re-runs whenever a
  // new pod shows up; existing entries are never overwritten.
  useEffect(() => {
    if (!pods || pods.length === 0) return;
    seedFromExisting(pods.map((p) => ({
      podId: p._id,
      lastMessageAt: p.lastMessage?.createdAt || p.updatedAt || p.createdAt,
    })));
  }, [pods, seedFromExisting]);

  // Server-side socket auth (`authorizeSocketPodAccess`) requires the user to
  // be in `pod.members` — `/api/pods` returns discoverable pods including
  // ones the user can browse but isn't a member of, so we have to gate the
  // joinPod calls. Otherwise we eat a flood of `Not authorized to join` errors.
  const memberPodIds = useMemo(() => {
    const me = currentUser?._id;
    if (!me) return [] as string[];
    return pods
      .filter((pod) => Array.isArray(pod.members) && pod.members.some((m) => {
        if (!m) return false;
        if (typeof m === 'string') return m === me;
        return m._id === me;
      }))
      .map((pod) => pod._id);
  }, [pods, currentUser?._id]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newPodName, setNewPodName] = useState('');
  const [newPodGoal, setNewPodGoal] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  // Pod IDs an agent is currently typing into. Set, not bool, because
  // multiple agents could type at once. Cleared after 30s safety in case the
  // stop event is missed.
  const [typingPods, setTypingPods] = useState<Set<string>>(() => new Set());
  const typingTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Join every member-pod's socket room so we hear newMessage / typing events
  // even while another pod is selected. The chat room hook (`useV2PodDetail`)
  // calls leavePod when its podId changes — without re-joining here, sidebar
  // would silently miss updates for the just-left pod. We re-fire on
  // selectedPodId change to recover those joins (joinPod is idempotent on
  // the server). No leavePod in cleanup: the server-side
  // `socket.on('disconnect')` handler clears all pod memberships when the
  // tab closes, so we don't leak rooms.
  useEffect(() => {
    if (!socket || !connected || memberPodIds.length === 0) return;
    memberPodIds.forEach((id) => joinPod(id));
  }, [socket, connected, memberPodIds, selectedPodId, joinPod]);

  // Cross-pod newMessage subscription: bump lastMessage and unread badge.
  useEffect(() => {
    if (!socket || !connected) return undefined;
    interface IncomingMessage {
      pod_id?: string;
      podId?: string;
      content?: string;
      created_at?: string;
      createdAt?: string;
      user?: { username?: string; profile_picture?: string | null };
      username?: string;
    }
    const handleNewMessage = (msg: IncomingMessage) => {
      const podId = msg?.pod_id || msg?.podId;
      if (!podId) return;
      const createdAt = msg.created_at || msg.createdAt || new Date().toISOString();
      patchLastMessage(podId, {
        content: msg.content || '',
        createdAt,
        username: msg.user?.username || msg.username || null,
      });
      if (podId !== selectedPodId) bumpLatest(podId, createdAt);
    };
    socket.on('newMessage', handleNewMessage);
    return () => {
      socket.off('newMessage', handleNewMessage);
    };
  }, [socket, connected, selectedPodId, patchLastMessage, bumpLatest]);

  // Cross-pod typing indicator. A row in the sidebar shows "typing…" if any
  // agent is mid-flight in that pod, regardless of which pod is open.
  useEffect(() => {
    if (!socket || !connected) return undefined;
    interface TypingPayload { podId?: string }
    const scheduleClear = (podId: string) => {
      if (typingTimersRef.current[podId]) clearTimeout(typingTimersRef.current[podId]);
      typingTimersRef.current[podId] = setTimeout(() => {
        setTypingPods((prev) => {
          if (!prev.has(podId)) return prev;
          const next = new Set(prev);
          next.delete(podId);
          return next;
        });
        delete typingTimersRef.current[podId];
      }, 30000);
    };
    const handleStart = (payload: TypingPayload) => {
      if (!payload?.podId) return;
      setTypingPods((prev) => {
        if (prev.has(payload.podId!)) return prev;
        const next = new Set(prev);
        next.add(payload.podId!);
        return next;
      });
      scheduleClear(payload.podId);
    };
    const handleStop = (payload: TypingPayload) => {
      if (!payload?.podId) return;
      const podId = payload.podId;
      if (typingTimersRef.current[podId]) {
        clearTimeout(typingTimersRef.current[podId]);
        delete typingTimersRef.current[podId];
      }
      setTypingPods((prev) => {
        if (!prev.has(podId)) return prev;
        const next = new Set(prev);
        next.delete(podId);
        return next;
      });
    };
    socket.on('agent_typing_start', handleStart);
    socket.on('agent_typing_stop', handleStop);
    return () => {
      socket.off('agent_typing_start', handleStart);
      socket.off('agent_typing_stop', handleStop);
      Object.values(typingTimersRef.current).forEach(clearTimeout);
      typingTimersRef.current = {};
    };
  }, [socket, connected]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return pods
      .filter((pod) => matchesFilter(pod, filter))
      .filter((pod) => !term
        || (pod.name || '').toLowerCase().includes(term)
        || (pod.description || '').toLowerCase().includes(term));
  }, [pods, filter, search]);

  const filterCounts = useMemo(() => (
    FILTERS.reduce<Record<Filter, number>>((counts, item) => {
      counts[item.key] = pods.filter((pod) => matchesFilter(pod, item.key)).length;
      return counts;
    }, { all: 0, team: 0, private: 0 })
  ), [pods]);

  const grouped = useMemo(() => groupPods(filtered, pinned), [filtered, pinned]);

  const handleCreatePod = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newPodName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const pod = await createPod(name, newPodGoal.trim() || undefined, 'team');
      if (pod?._id) {
        setNewPodName('');
        setNewPodGoal('');
        setShowCreate(false);
        navigate(`/v2/pods/${pod._id}`);
      } else {
        setCreateError('Unable to create pod. Check that you are signed in and try again.');
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <aside className="v2-pane">
      <div className="v2-pods">
        <div className="v2-pods__header">
          <div className="v2-pods__title">Pods</div>
          <button
            type="button"
            className="v2-pods__new-btn"
            onClick={() => {
              setShowCreate((next) => !next);
              setCreateError(null);
            }}
            disabled={creating}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New Pod
          </button>
          {showCreate && (
            <form className="v2-pods__create" onSubmit={handleCreatePod}>
              <div className="v2-pods__create-options">
                <button type="button" className="v2-pods__create-option v2-pods__create-option--active">
                  Create Team Pod
                </button>
                <button
                  type="button"
                  className="v2-pods__create-option"
                  onClick={() => setCreateError('Start a Private pod from an agent row or existing private conversation.')}
                >
                  Start Private Pod
                </button>
              </div>
              <input
                className="v2-pods__create-input"
                type="text"
                value={newPodName}
                onChange={(e) => setNewPodName(e.target.value)}
                placeholder="Pod name"
                autoFocus
              />
              <input
                className="v2-pods__create-input"
                type="text"
                value={newPodGoal}
                onChange={(e) => setNewPodGoal(e.target.value)}
                placeholder="Goal or description"
              />
              {createError && <div className="v2-pods__create-error">{createError}</div>}
              <div className="v2-pods__create-actions">
                <button
                  type="button"
                  className="v2-pods__create-cancel"
                  onClick={() => {
                    setShowCreate(false);
                    setCreateError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="v2-pods__create-submit"
                  disabled={creating || !newPodName.trim()}
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          )}
          <div className="v2-pods__search">
            <span className="v2-pods__search-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            </span>
            <input
              type="text"
              className="v2-pods__search-input"
              placeholder="Search pods..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="v2-pods__filters v2-filter-segment" aria-label="Pod filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`v2-pods__filter v2-filter-segment__item${filter === f.key ? ' v2-pods__filter--active v2-filter-segment__item--active' : ''}`}
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
            >
              {f.label}
              <span className="v2-filter-count">{filterCounts[f.key]}</span>
            </button>
          ))}
        </div>

        <div className="v2-pods__list">
          {loading && <div className="v2-pods__empty"><span className="v2-spinner" /></div>}
          {!loading && error && <div className="v2-pods__empty">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="v2-pods__empty">
              {search ? 'No pods match your search.' : 'No pods yet. Create one to get started.'}
            </div>
          )}

          {!loading && grouped.map((group) => (
            <div key={group.label}>
              <div className="v2-pods__group-label">{group.label}</div>
              {group.items.map((pod) => {
                const memberCount = pod.members?.length || 0;
                const agentCount = agentCountFor(pod);
                const time = formatRelativeTime(pod.lastMessage?.createdAt || pod.updatedAt || pod.createdAt);
                const active = pod._id === selectedPodId;
                const meta = podKind(pod) === 'private'
                  ? 'Direct message'
                  : (agentCount > 0
                    ? `${agentCount} agent${agentCount === 1 ? '' : 's'}`
                    : `${memberCount} member${memberCount === 1 ? '' : 's'}`);
                const snippet = podSnippetFor(pod, meta);
                const pinnedNow = isPinned(pod._id);
                const typing = typingPods.has(pod._id);
                const unread = isUnread(pod._id, pod.lastMessage?.createdAt);
                return (
                  <div
                    key={pod._id}
                    className={`v2-pods__row${pinnedNow ? ' v2-pods__row--pinned' : ''}`}
                  >
                    <button
                      type="button"
                      className={`v2-pods__item${active ? ' v2-pods__item--active' : ''}${unread ? ' v2-pods__item--unread' : ''}`}
                      onClick={() => navigate(`/v2/pods/${pod._id}`)}
                    >
                      <span className={podMarkClass(pod)}>
                        {podMarkFor(pod)}
                      </span>
                      <span className="v2-pods__item-body">
                        <span className="v2-pods__item-title-row">
                          <span className="v2-pods__item-title">{pod.name}</span>
                          {unread && <span className="v2-pods__item-dot" aria-label="Unread messages" />}
                          <span className="v2-pods__item-time">{time}</span>
                        </span>
                        <span className={`v2-pods__item-snippet${typing ? ' v2-pods__item-snippet--typing' : ''}`}>
                          {typing ? 'typing…' : snippet}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`v2-pods__pin${pinnedNow ? ' v2-pods__pin--active' : ''}`}
                      onClick={() => togglePin(pod._id)}
                      title={pinnedNow ? 'Unpin' : 'Pin'}
                      aria-label={pinnedNow ? 'Unpin pod' : 'Pin pod'}
                      aria-pressed={pinnedNow}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill={pinnedNow ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 17v5M9 10.76V6h6v4.76l3 3.24v2H6v-2z" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
};

export default V2PodsSidebar;
