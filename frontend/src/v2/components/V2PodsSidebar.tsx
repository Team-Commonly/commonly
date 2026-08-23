import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { UseV2PodsResult, V2Pod, useV2Pods } from '../hooks/useV2Pods';
import { groupPods, formatRelativeTime } from '../utils/grouping';
import { initialsFor } from '../utils/avatars';
import { useV2Pinned } from '../hooks/useV2Pinned';
import { useV2Unread } from '../hooks/useV2Unread';
import { useV2Api } from '../hooks/useV2Api';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';

type Filter = 'all' | 'team' | 'private' | 'community';
type CommunityView = 'joined' | 'discover';

const FILTERS: Array<{ key: Filter; labelKey: string }> = [
  { key: 'all', labelKey: 'filters.all' },
  { key: 'team', labelKey: 'filters.team' },
  { key: 'private', labelKey: 'filters.private' },
  { key: 'community', labelKey: 'filters.community' },
];
const COMMUNITY_VIEWS: CommunityView[] = ['joined', 'discover'];

// Both agent-room (user↔agent) and agent-dm (any 2-member combo) show
// up under the DMs filter. agent-dm with two bot members gets a
// distinct icon ("AA" — agent ↔ agent) so users can tell at a glance
// that no human is in the conversation.
const isDmPod = (pod: V2Pod): boolean => pod.type === 'agent-room' || pod.type === 'agent-dm';
const podKind = (pod: V2Pod): 'team' | 'private' => (isDmPod(pod) ? 'private' : 'team');
const isPersonalPod = (pod: V2Pod): boolean => isDmPod(pod) || pod.type === 'agent-admin';

const isAgentToAgent = (pod: V2Pod): boolean => {
  if (pod.type !== 'agent-dm') return false;
  const members = pod.members || [];
  if (members.length < 2) return false;
  return members.every((m) => typeof m === 'object' && !!m?.isBot);
};

const podMarkFor = (pod: V2Pod): string => {
  if (isAgentToAgent(pod)) return 'AA';
  return podKind(pod) === 'private' ? 'DM' : initialsFor(pod.name).slice(0, 2);
};

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
    // Render an attached-file directive as a paperclip + filename instead of
    // leaking the raw [[upload:fileName|originalName|size|kind]] token into the
    // preview (matches how V2MessageBubble turns it into a pill in the thread).
    const content = last.content
      .replace(/\[\[upload:[^\]|]+\|([^\]|]+)\|[^\]]+\]\]/g, '📎 $1')
      .replace(/\s+/g, ' ')
      .trim();
    return `${author}${content}`;
  }
  return pod.description?.trim() || meta;
};

const matchesPersonalFilter = (pod: V2Pod, filter: Filter): boolean => {
  switch (filter) {
    // "Team" is the strictest pod-type filter — only pods explicitly typed
    // as team (multi-human collaborative). "DMs" is 1:1 conversations.
    // "All" covers everything (the redundant "Pod" filter was removed).
    case 'team': return pod.type === 'team';
    case 'private': return podKind(pod) === 'private';
    case 'community': return false;
    case 'all':
    default:
      return true;
  }
};

interface V2PodsSidebarProps {
  selectedPodId: string | null;
  podsState?: UseV2PodsResult;
  // Mobile (<=760px) slide-over drawer state. On phones the sidebar is a
  // fixed overlay rather than a grid column; `mobileOpen` drives the
  // open/closed transform and `onMobileClose` dismisses it (selecting a pod,
  // creating one). Both no-ops on desktop where the sidebar is always visible.
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

const V2PodsSidebar: React.FC<V2PodsSidebarProps> = ({
  selectedPodId, podsState, mobileOpen = false, onMobileClose,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const api = useV2Api();
  const ownPodsState = useV2Pods();
  const {
    pods, loading, error, refresh, createPod, patchLastMessage,
  } = podsState || ownPodsState;
  const { pinned, toggle: togglePin, isPinned } = useV2Pinned();
  const { socket, connected, joinPod } = useSocket();
  const { currentUser } = useAuth();
  const { isUnread, bumpLatest, seedFromExisting } = useV2Unread(selectedPodId);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [communityPods, setCommunityPods] = useState<V2Pod[]>([]);
  const [communityLoading, setCommunityLoading] = useState(true);
  const [communityView, setCommunityView] = useState<CommunityView>('joined');
  const [discoverPods, setDiscoverPods] = useState<V2Pod[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [joinedDiscoverPods, setJoinedDiscoverPods] = useState<V2Pod[]>([]);
  const [joiningPodId, setJoiningPodId] = useState<string | null>(null);
  const [joinNotice, setJoinNotice] = useState<string | null>(null);

  // Discovery is intentionally fetched into separate state. Merging these
  // rows into `pods` would make non-member public pods leak into All/Team,
  // undoing the membership-only sidebar invariant from #375.
  useEffect(() => {
    let active = true;
    setCommunityLoading(true);
    api.get<V2Pod[]>('/api/pods?scope=community')
      .then((data) => {
        if (active) setCommunityPods(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (active) setCommunityPods([]);
      })
      .finally(() => {
        if (active) setCommunityLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  // Discover stays separate from the membership-backed pod list: this endpoint
  // deliberately returns pods the caller has NOT joined. Fetch it only while
  // the Discover view is active so the default personal sidebar does not pay
  // for discovery data it never renders.
  useEffect(() => {
    if (filter !== 'community' || communityView !== 'discover') return undefined;
    let active = true;
    setDiscoverLoading(true);
    setDiscoverError(null);
    api.get<V2Pod[]>('/api/pods?scope=discover')
      .then((data) => {
        if (!active) return;
        setDiscoverPods((Array.isArray(data) ? data : []).filter((pod) => !isPersonalPod(pod)));
      })
      .catch(() => {
        if (!active) return;
        setDiscoverPods([]);
        setDiscoverError(t('podsSidebar.discover.loadFailed'));
      })
      .finally(() => {
        if (active) setDiscoverLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, communityView, filter, t]);

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
  const communityPodId = process.env.REACT_APP_COMMUNITY_POD_ID || '';
  const showCommunityOffer = Boolean(communityPodId) && Boolean(currentUser?._id)
    && !loading && !error
    && !memberPodIds.includes(communityPodId);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newPodName, setNewPodName] = useState('');
  const [newPodGoal, setNewPodGoal] = useState('');
  // Every pod is born private and unlisted (ADR-016). `joinPolicy: 'open'`
  // below the community tier is a DORMANT declaration — "open once listed" —
  // not an audience the creator is choosing here. Creation asks for name and
  // purpose only; visibility is set later, on a pod that has something in it.
  const newPodJoinPolicy = 'open' as const;
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

  const communityPodIds = useMemo(
    () => new Set(communityPods.map((pod) => pod._id)),
    [communityPods],
  );
  const communityCandidates = useMemo(() => {
    const byId = new Map<string, V2Pod>();
    communityPods.forEach((pod) => byId.set(pod._id, pod));
    joinedDiscoverPods.forEach((pod) => byId.set(pod._id, pod));
    // Prefer the membership-list row when both endpoints return a pod; it is
    // the row socket/unread state already knows about.
    pods.forEach((pod) => byId.set(pod._id, pod));
    const effectiveMemberIds = new Set([
      ...memberPodIds,
      ...joinedDiscoverPods.map((pod) => pod._id),
    ]);
    return Array.from(byId.values()).filter((pod) => {
      if (isPersonalPod(pod)) return false;
      if (!effectiveMemberIds.has(pod._id)) return false;
      // Community membership is opt-in `communityListed` (the scope=community
      // result set + Discover-joined + HQ) — NOT `publicRead`. publicRead is
      // anonymous/showcase read only (#722); showcase pods like the milestone
      // and engineering rooms are publicRead but must NOT appear in Community.
      return communityPodIds.has(pod._id)
        || joinedDiscoverPods.some((joined) => joined._id === pod._id)
        || (Boolean(communityPodId) && pod._id === communityPodId);
    });
  }, [
    communityPods,
    communityPodIds,
    joinedDiscoverPods,
    pods,
    memberPodIds,
    communityPodId,
  ]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const candidates = filter === 'community'
      ? (communityView === 'discover' ? discoverPods : communityCandidates)
      : pods;
    return candidates
      .filter((pod) => filter === 'community' || matchesPersonalFilter(pod, filter))
      .filter((pod) => !term
        || (pod.name || '').toLowerCase().includes(term)
        || (pod.description || '').toLowerCase().includes(term));
  }, [communityCandidates, communityView, discoverPods, pods, filter, search]);

  const visibleLoading = loading || (
    filter === 'community'
    && (communityView === 'discover' ? discoverLoading : communityLoading)
  );
  const visibleError = filter === 'community' && communityView === 'discover'
    ? discoverError
    : error;

  // Default grouping is chronological (Pinned / Today / Yesterday / This week
  // / Earlier). When the user filters down to DMs, recency buckets stop
  // adding signal — DMs are already a tight list — and the meaningful split
  // is human↔agent vs agent↔agent. Bot-bot rooms are observer-only (§3.7),
  // so a section header makes the relationship explicit at a glance and
  // doubles as a count of how many a2a conversations are happening.
  const grouped = useMemo(() => {
    if (filter === 'community' && communityView === 'discover') return [];
    if (filter !== 'private') {
      // groupPods returns stable PodGroup KEYS ('Today', 'This week', …);
      // rendering them raw shipped English headers into zh-CN (Sam's
      // "cn version is messed up" report, 2026-08-23). Translate at this
      // boundary, exactly like the DM buckets below already do.
      const chronoKeys: Record<string, string> = {
        Pinned: 'podsSidebar.groups.pinned',
        Today: 'podsSidebar.groups.today',
        Yesterday: 'podsSidebar.groups.yesterday',
        'This week': 'podsSidebar.groups.thisWeek',
        Earlier: 'podsSidebar.groups.earlier',
      };
      return groupPods(filtered, pinned).map((g) => ({
        ...g,
        label: chronoKeys[g.label] ? t(chronoKeys[g.label]) : g.label,
      }));
    }
    const sortByRecency = <T extends { lastMessage?: { createdAt?: string | Date | null } | null; updatedAt?: string | Date; createdAt?: string | Date }>(items: T[]): T[] => {
      const ts = (it: T) => {
        const raw = it.lastMessage?.createdAt || it.updatedAt || it.createdAt;
        const n = raw ? new Date(raw).getTime() : 0;
        return Number.isNaN(n) ? 0 : n;
      };
      return [...items].sort((a, b) => ts(b) - ts(a));
    };
    const pinnedItems = filtered.filter((p) => pinned.has(p._id));
    const rest = filtered.filter((p) => !pinned.has(p._id));
    const a2a = rest.filter((p) => isAgentToAgent(p));
    const dms = rest.filter((p) => !isAgentToAgent(p));
    const buckets: Array<{ label: string; items: typeof filtered }> = [];
    if (pinnedItems.length) buckets.push({ label: t('podsSidebar.groups.pinned'), items: sortByRecency(pinnedItems) });
    if (dms.length) buckets.push({ label: t('podsSidebar.groups.directMessages'), items: sortByRecency(dms) });
    if (a2a.length) buckets.push({ label: t('podsSidebar.groups.betweenAgents', { count: a2a.length }), items: sortByRecency(a2a) });
    return buckets;
  }, [communityView, filter, filtered, pinned, t]);

  // Navigate to a pod and, on mobile, dismiss the slide-over drawer so the
  // user lands directly in the chat instead of behind the overlay.
  const selectPod = (podId: string) => {
    navigate(`/v2/pods/${podId}`);
    onMobileClose?.();
  };

  const handleJoinDiscoverPod = async (pod: V2Pod) => {
    setJoiningPodId(pod._id);
    setJoinNotice(null);
    try {
      const joined = await api.post<V2Pod>(`/api/pods/${pod._id}/join`);
      const joinedPod = joined?._id ? joined : pod;
      setDiscoverPods((current) => current.filter((item) => item._id !== pod._id));
      setJoinedDiscoverPods((current) => [
        joinedPod,
        ...current.filter((item) => item._id !== joinedPod._id),
      ]);
      setCommunityView('joined');
      void refresh?.();
      selectPod(joinedPod._id);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 403) {
        setJoinNotice(t('podsSidebar.discover.inviteRequired'));
      } else if (status === 429) {
        setJoinNotice(t('podsSidebar.discover.rateLimited'));
      } else {
        setJoinNotice(t('podsSidebar.discover.joinFailed'));
      }
    } finally {
      setJoiningPodId(null);
    }
  };

  const handleCreatePod = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newPodName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const pod = await createPod(
        name,
        newPodGoal.trim() || undefined,
        'team',
        newPodJoinPolicy,
      );
      if (pod?._id) {
        try {
          sessionStorage.setItem(`v2.justCreated.${pod._id}`, '1');
        } catch {
          // The pod still opens normally when sessionStorage is unavailable;
          // only the one-session starter panel is skipped.
        }
        setNewPodName('');
        setNewPodGoal('');
        setShowCreate(false);
        selectPod(pod._id);
      } else {
        setCreateError(t('podsSidebar.errors.createFailed'));
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <aside className={`v2-pane v2-pods-aside${mobileOpen ? ' v2-pods-aside--open' : ''}`}>
      <div className="v2-pods">
        <div className="v2-pods__header">
          <div className="v2-pods__title">
            {t('podsSidebar.title')}
            <button
              type="button"
              className="v2-pods__mobile-close"
              onClick={() => onMobileClose?.()}
              title={t('podsSidebar.closeTitle')}
              aria-label={t('podsSidebar.closeAriaLabel')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
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
            {t('podsSidebar.newPod')}
          </button>
          {showCreate && (
            <form className="v2-pods__create" onSubmit={handleCreatePod}>
              <input
                className="v2-pods__create-input"
                type="text"
                value={newPodName}
                onChange={(e) => setNewPodName(e.target.value)}
                placeholder={t('podsSidebar.create.namePlaceholder')}
                autoFocus
              />
              <input
                className="v2-pods__create-input"
                type="text"
                value={newPodGoal}
                onChange={(e) => setNewPodGoal(e.target.value)}
                placeholder={t('podsSidebar.create.goalPlaceholder')}
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
                  {t('podsSidebar.create.cancel')}
                </button>
                <button
                  type="submit"
                  className="v2-pods__create-submit"
                  disabled={creating || !newPodName.trim()}
                >
                  {creating ? t('podsSidebar.create.creating') : t('podsSidebar.create.submit')}
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
              placeholder={t('podsSidebar.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="v2-pods__filters v2-filter-segment" aria-label={t('podsSidebar.filtersAriaLabel')}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`v2-pods__filter v2-filter-segment__item${filter === f.key ? ' v2-pods__filter--active v2-filter-segment__item--active' : ''}`}
              onClick={() => {
                setFilter(f.key);
                setJoinNotice(null);
              }}
              aria-pressed={filter === f.key}
            >
              {t(`podsSidebar.${f.labelKey}`)}
            </button>
          ))}
        </div>

        {filter === 'community' && (
          <div
            className="v2-pods__community-tabs v2-filter-segment"
            aria-label={t('podsSidebar.communityViews.ariaLabel')}
          >
            {COMMUNITY_VIEWS.map((view) => (
              <button
                key={view}
                type="button"
                className={`v2-pods__community-tab v2-filter-segment__item${communityView === view ? ' v2-pods__community-tab--active v2-filter-segment__item--active' : ''}`}
                onClick={() => {
                  setCommunityView(view);
                  setJoinNotice(null);
                }}
                aria-pressed={communityView === view}
              >
                {t(`podsSidebar.communityViews.${view}`)}
              </button>
            ))}
          </div>
        )}

        <div className="v2-pods__list">
          {visibleLoading && <div className="v2-pods__empty"><span className="v2-spinner" /></div>}
          {!visibleLoading && visibleError && <div className="v2-pods__empty">{visibleError}</div>}
          {!visibleLoading
            && !visibleError
            && filter === 'community'
            && communityView === 'discover'
            && joinNotice && (
            <div className="v2-pods__join-notice" role="alert">{joinNotice}</div>
          )}
          {!visibleLoading && !visibleError && filtered.length === 0 && (
            <div className="v2-pods__empty">
              {search
                ? t('podsSidebar.empty.noMatch')
                : (filter === 'community'
                  ? t(
                    communityView === 'discover'
                      ? 'podsSidebar.discover.empty'
                      : 'podsSidebar.discover.joinedEmpty',
                  )
                  : t('podsSidebar.empty.noPods'))}
            </div>
          )}

          {!visibleLoading
            && !visibleError
            && filter === 'community'
            && communityView === 'discover'
            && filtered.map((pod) => (
              <article key={pod._id} className="v2-pods__discover-row">
                <span className={podMarkClass(pod)}>{podMarkFor(pod)}</span>
                <span className="v2-pods__discover-body">
                  <span className="v2-pods__discover-title">{pod.name}</span>
                  {pod.description && (
                    <span className="v2-pods__discover-description">{pod.description}</span>
                  )}
                  <span className="v2-pods__discover-meta">
                    {t('podsSidebar.meta.memberCount', { count: pod.members?.length || 0 })}
                  </span>
                </span>
                <button
                  type="button"
                  className="v2-pods__discover-join"
                  disabled={joiningPodId === pod._id}
                  onClick={() => void handleJoinDiscoverPod(pod)}
                >
                  {joiningPodId === pod._id
                    ? t('podsSidebar.discover.joining')
                    : t('podsSidebar.discover.join')}
                </button>
              </article>
            ))}

          {!visibleLoading && grouped.map((group) => (
            <div key={group.label}>
              <div className="v2-pods__group-label">{group.label}</div>
              {group.items.map((pod) => {
                const memberCount = pod.members?.length || 0;
                const agentCount = agentCountFor(pod);
                const time = formatRelativeTime(pod.lastMessage?.createdAt || pod.updatedAt || pod.createdAt);
                const active = pod._id === selectedPodId;
                const meta = podKind(pod) === 'private'
                  ? t('podsSidebar.meta.directMessage')
                  : (agentCount > 0
                    ? t('podsSidebar.meta.agentCount', { count: agentCount })
                    : t('podsSidebar.meta.memberCount', { count: memberCount }));
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
                      onClick={() => selectPod(pod._id)}
                    >
                      <span className={podMarkClass(pod)}>
                        {podMarkFor(pod)}
                      </span>
                      <span className="v2-pods__item-body">
                        <span className="v2-pods__item-title-row">
                          <span className="v2-pods__item-title">{pod.name}</span>
                          {unread && <span className="v2-pods__item-dot" aria-label={t('podsSidebar.unreadAriaLabel')} />}
                        </span>
                        <span className="v2-pods__item-snippet-row">
                          <span className={`v2-pods__item-snippet${typing ? ' v2-pods__item-snippet--typing' : ''}`}>
                            {typing ? t('podsSidebar.typing') : snippet}
                          </span>
                          <span className="v2-pods__item-time">{time}</span>
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`v2-pods__pin${pinnedNow ? ' v2-pods__pin--active' : ''}`}
                      onClick={() => togglePin(pod._id)}
                      title={pinnedNow ? t('podsSidebar.unpinTitle') : t('podsSidebar.pinTitle')}
                      aria-label={pinnedNow ? t('podsSidebar.unpinAriaLabel') : t('podsSidebar.pinAriaLabel')}
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

        {showCommunityOffer && (
          <section className="v2-pods__community" aria-labelledby="v2-community-offer-title">
            <div id="v2-community-offer-title" className="v2-pods__community-title">
              {t('podsSidebar.community.title')}
            </div>
            <div className="v2-pods__community-copy">
              {t('podsSidebar.community.copy')}
            </div>
            <button
              type="button"
              className="v2-pods__community-button"
              onClick={() => {
                navigate('/v2/community');
                onMobileClose?.();
              }}
            >
              {t('podsSidebar.community.button')}
            </button>
          </section>
        )}
      </div>
    </aside>
  );
};

export default V2PodsSidebar;
