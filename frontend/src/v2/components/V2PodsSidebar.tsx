import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import V2Avatar from './V2Avatar';
import V2Segmented from './V2Segmented';
import { ShellGlyph } from '../icons/glyphs';
import { UseV2PodsResult, V2Pod, V2PodMember, useV2Pods } from '../hooks/useV2Pods';
import { useV2Pinned } from '../hooks/useV2Pinned';
import { useAuth } from '../../context/AuthContext';
import {
  RECENT_LIMIT, podInitials, relativeTime,
} from '../lib/podRecency';

interface V2PodsSidebarProps {
  selectedPodId: string | null;
  podsState?: UseV2PodsResult;
  attentionCountByPod?: Record<string, number>;
  // 'column' is the desktop grid column; 'page' is the phone's full-screen
  // pods list (direction C: the list is a page, the drawer is gone).
  variant?: 'column' | 'page';
}

const DM_POD_TYPES = new Set(['agent-room', 'agent-dm']);
// A new stored type must be deliberately placed in the workspace grammar.
// Do not turn this into "not direct": that would silently surface any future
// type as a pod before product has decided how it belongs in the sidebar.
const ROOM_POD_TYPES = new Set([
  'chat',
  'study',
  'games',
  'agent-ensemble',
  'agent-admin',
  'team',
]);

export type PodKind = 'community' | 'team' | 'chat' | 'study' | 'games' | 'ensemble' | 'admin' | 'direct';

// Kinds only appear inside the All view (walk-1 miss 3). Order is the
// order a person scans them: work first, direct last.
export const POD_KIND_ORDER: PodKind[] = [
  'team', 'community', 'chat', 'study', 'games', 'ensemble', 'admin', 'direct',
];

// Every non-DM Pod.type has a deliberate, human-readable kind. The community
// kind is not a type: it is an admin-curated placement that wins over type.
export const ROOM_POD_TYPE_LABELS: Record<string, Exclude<PodKind, 'community' | 'direct'>> = {
  team: 'team',
  chat: 'chat',
  study: 'study',
  games: 'games',
  'agent-ensemble': 'ensemble',
  'agent-admin': 'admin',
};

// D215 (TASK-691): one segmented switch picks the list. It replaced the
// Pinned / Recent headings and the "Everything 64 ▸" fold, whose tiny caret
// did not read as a switch.
export type PodListView = 'recent' | 'all' | 'pinned';
const POD_LIST_VIEWS: PodListView[] = ['recent', 'all', 'pinned'];
export const POD_LIST_VIEW_KEY = 'v2:pods.view';
const KIND_OPEN_KEY = 'v2:pods.kindsOpen';
const NO_PINS = new Set<string>();

export const searchShortcutHint = (platform: string): string => (
  /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘K' : 'Ctrl K'
);

const browserPlatform = (): string => {
  if (typeof navigator === 'undefined') return '';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || nav.userAgent || '';
};

const readListView = (): PodListView => {
  try {
    const raw = sessionStorage.getItem(POD_LIST_VIEW_KEY) as PodListView | null;
    return raw && POD_LIST_VIEWS.includes(raw) ? raw : 'recent';
  } catch {
    return 'recent';
  }
};

const writeListView = (view: PodListView) => {
  try {
    sessionStorage.setItem(POD_LIST_VIEW_KEY, view);
  } catch {
    // Session storage unavailable: the list simply opens on Recent next time.
  }
};

const readOpenKinds = (): Set<PodKind> => {
  try {
    const raw = sessionStorage.getItem(KIND_OPEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as PodKind[]) : []);
  } catch {
    return new Set();
  }
};

const writeOpenKinds = (kinds: Set<PodKind>) => {
  try {
    sessionStorage.setItem(KIND_OPEN_KEY, JSON.stringify([...kinds]));
  } catch {
    // Same fallback as above.
  }
};

export const podMessageTime = (pod: V2Pod): number => {
  const value = pod.lastMessage?.createdAt || pod.createdAt;
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const isHumanPair = (pod: V2Pod): boolean => {
  const members = pod.members || [];
  return pod.type === 'chat'
    && members.length === 2
    && members.every((member) => typeof member === 'object' && !member.isBot);
};

// The stored types stay unchanged. Agent DMs and human two-person chat are
// "direct" pods: ordinary rows carrying the peer's avatar instead of initials.
export const isDirectPod = (pod: V2Pod): boolean => (
  DM_POD_TYPES.has(String(pod.type || '')) || isHumanPair(pod)
);

export const isRoomPod = (pod: V2Pod): boolean => (
  ROOM_POD_TYPES.has(String(pod.type || '')) && !isHumanPair(pod)
);

export const podKind = (pod: V2Pod): PodKind | null => {
  if (isDirectPod(pod)) return 'direct';
  if (!isRoomPod(pod)) return null;
  if (pod.communityListed === true) return 'community';
  return ROOM_POD_TYPE_LABELS[String(pod.type || '')] || null;
};

// All: every pod the person is in, grouped by kind, each group sorted by
// last message (or creation for an empty pod). Pinned pods appear here too.
export const groupPodsByKind = (pods: V2Pod[]): Array<{ kind: PodKind; pods: V2Pod[] }> => {
  const groups = new Map<PodKind, V2Pod[]>();
  POD_KIND_ORDER.forEach((kind) => groups.set(kind, []));
  pods.forEach((pod) => {
    const kind = podKind(pod);
    if (kind) groups.get(kind)?.push(pod);
  });
  return POD_KIND_ORDER
    .map((kind) => ({ kind, pods: sortByMessageTime(groups.get(kind) || []) }))
    .filter((group) => group.pods.length > 0);
};

export const sortByMessageTime = (pods: V2Pod[]): V2Pod[] => (
  [...pods].sort((left, right) => (
    podMessageTime(right) - podMessageTime(left) || left._id.localeCompare(right._id)
  ))
);

// Recent uses the same message order on every device. The sidebar passes no
// pins since D215: with no Pinned heading above it, Recent is the whole recent
// list, pinned pods included. Callers may still exclude a set.
export const recentPods = (
  pods: V2Pod[],
  pinnedPodIds: Set<string>,
  limit: number = RECENT_LIMIT,
): V2Pod[] => {
  return sortByMessageTime(pods.filter((pod) => !pinnedPodIds.has(pod._id))).slice(0, limit);
};

const directMemberFor = (pod: V2Pod, currentUserId?: string): V2PodMember | undefined => (
  (pod.members || []).find((member): member is V2PodMember => (
    typeof member === 'object' && member._id !== currentUserId
  )) || (pod.members || []).find((member): member is V2PodMember => typeof member === 'object')
);

const matchesQuery = (pod: V2Pod, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (pod.name || '').toLowerCase().includes(needle)
    || (pod.description || '').toLowerCase().includes(needle);
};

const V2PodsSidebar: React.FC<V2PodsSidebarProps> = ({
  selectedPodId, podsState, attentionCountByPod = {}, variant = 'column',
}) => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const { pinned, toggle: togglePin } = useV2Pinned();
  const ownPodsState = useV2Pods(!podsState);
  const {
    pods, loading, error, createPod, refresh: refreshPods,
  } = podsState || ownPodsState;
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  // The phone page folds search behind an icon in its title bar (D223).
  const [searchOpen, setSearchOpen] = useState(false);
  const [listView, setListView] = useState<PodListView>(() => readListView());
  const [openKinds, setOpenKinds] = useState<Set<PodKind>>(() => readOpenKinds());
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newPodName, setNewPodName] = useState('');
  const [newPodGoal, setNewPodGoal] = useState('');
  const [newPodJoinPolicy, setNewPodJoinPolicy] = useState<'open' | 'invite-only'>('open');
  const [createError, setCreateError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const createReturnToConnectors = location.pathname === '/v2'
    && new URLSearchParams(location.search).get('newPod') === '1';

  useEffect(() => {
    if (createReturnToConnectors) setShowCreate(true);
  }, [createReturnToConnectors]);

  // Every row's time is a DATUM from the last /api/pods; the minute tick only
  // recomputes the label, so a tab left open keeps ageing a frozen timestamp and
  // reads further from the truth the longer it stays open (TASK-184). So the tick
  // also re-reads the datum, and so does becoming visible — the moment a row is
  // actually read. Silent, so a poll never blinks the list into its spinner; and
  // foreground-only, so a background tab costs nothing.
  const refreshPodsRef = useRef(refreshPods);
  useEffect(() => {
    refreshPodsRef.current = refreshPods;
  }, [refreshPods]);
  const tick = useCallback(() => {
    setNow(Date.now());
    if (document.visibilityState === 'visible') void refreshPodsRef.current?.({ silent: true });
  }, []);
  useEffect(() => {
    const timer = window.setInterval(tick, 60 * 1000);
    // visibilitychange fires in both directions; `tick` decides what to do.
    const onVisibility = () => tick();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tick]);

  // ⌘K / Ctrl+K focuses the search box from anywhere in the shell.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const listablePods = useMemo(() => pods.filter((pod) => podKind(pod) !== null), [pods]);
  const pinnedPods = useMemo(
    () => sortByMessageTime(listablePods.filter((pod) => pinned.has(pod._id))),
    [listablePods, pinned],
  );
  const recent = useMemo(() => recentPods(listablePods, NO_PINS), [listablePods]);
  const everything = useMemo(() => groupPodsByKind(listablePods), [listablePods]);
  const searching = query.trim().length > 0;
  const matches = useMemo(() => {
    if (!searching) return [];
    return sortByMessageTime(listablePods.filter((pod) => matchesQuery(pod, query)));
  }, [listablePods, query, searching]);

  const selectPod = useCallback((podId: string) => {
    navigate(`/v2/pods/${podId}`);
  }, [navigate]);

  const chooseListView = (view: PodListView) => {
    setListView(view);
    writeListView(view);
  };

  const toggleKind = (kind: PodKind) => {
    setOpenKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      writeOpenKinds(next);
      return next;
    });
  };

  const handleCreatePod = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newPodName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const pod = await createPod(name, newPodGoal.trim() || undefined, 'team', newPodJoinPolicy);
      if (!pod?._id) {
        setCreateError(t('podsSidebar.errors.createFailed'));
        return;
      }
      try {
        sessionStorage.setItem(`v2.justCreated.${pod._id}`, '1');
      } catch {
        // The pod still opens normally when sessionStorage is unavailable.
      }
      setNewPodName('');
      setNewPodGoal('');
      setNewPodJoinPolicy('open');
      setShowCreate(false);
      if (createReturnToConnectors) navigate('/v2/connectors', { replace: true });
      else selectPod(pod._id);
    } finally {
      setCreating(false);
    }
  };

  const renderRow = (pod: V2Pod, inFold = false) => {
    const selected = pod._id === selectedPodId;
    const count = attentionCountByPod[pod._id] || 0;
    const direct = isDirectPod(pod);
    const peer = direct ? directMemberFor(pod, currentUser?._id) : undefined;
    const time = relativeTime(podMessageTime(pod) || null, now);
    const isPinned = pinned.has(pod._id);
    return (
      <div key={pod._id} className={`v2-pods__rowwrap${isPinned ? ' v2-pods__rowwrap--pinned' : ''}`}>
      <button
        type="button"
        className={[
          'v2-pods__row',
          selected ? 'v2-pods__row--selected' : '',
          count > 0 ? 'v2-pods__row--unread' : '',
          inFold ? 'v2-pods__row--in-fold' : '',
        ].filter(Boolean).join(' ')}
        onClick={() => selectPod(pod._id)}
        aria-current={selected ? 'page' : undefined}
      >
        {peer ? (
          <V2Avatar
            className="v2-pods__row-mark v2-pods__row-mark--avatar"
            name={peer.username || pod.name}
            src={peer.profilePicture || undefined}
            size="sm"
            kind={peer.isBot ? 'agent' : 'human'}
            seed={peer._id}
          />
        ) : (
          <span className="v2-pods__row-mark" aria-hidden="true">{podInitials(pod.name)}</span>
        )}
        <span className="v2-pods__row-name">
          {pod.name === 'My Workspace' && pod.createdBy?._id && String(pod.createdBy._id) !== String(currentUser?._id)
            ? t('podNames.otherWorkspace', { name: pod.name, owner: pod.createdBy.username || t('podNames.shared') })
            : pod.name}
        </span>
        <span className="v2-pods__row-meta">
          {count > 0 && (
            <span className="v2-pods__row-pill" aria-label={t('podsSidebar.workspace.needsYouCount', { count })}>
              {count}
            </span>
          )}
          {time && <span className="v2-pods__row-time" aria-hidden="true">{time}</span>}
        </span>
      </button>
      {/* D215: the pin is an icon on row hover that takes the time's slot. */}
      <button
        type="button"
        className={`v2-pods__pin${isPinned ? ' v2-pods__pin--active' : ''}`}
        onClick={(event) => { event.stopPropagation(); togglePin(pod._id); }}
        aria-label={isPinned ? t('podsSidebar.unpinAriaLabel') : t('podsSidebar.pinAriaLabel')}
        title={isPinned ? t('podsSidebar.unpinTitle') : t('podsSidebar.pinTitle')}
        aria-pressed={isPinned}
      >
        <ShellGlyph name="pin" size={15} />
      </button>
      </div>
    );
  };

  const renderSection = (
    key: string,
    label: string,
    rows: React.ReactNode,
    options: { count?: number; open?: boolean; onToggle?: () => void; nested?: boolean } = {},
  ) => {
    const {
      count, open = true, onToggle, nested = false,
    } = options;
    const headingId = `v2-pods-section-${key}`;
    const header = (
      <>
        <span className="v2-pods__section-label">{label}</span>
        {typeof count === 'number' && (
          <>
            {' '}
            <span className="v2-pods__section-count">{count}</span>
          </>
        )}
        {onToggle && <span className="v2-pods__section-chevron" aria-hidden="true" />}
      </>
    );
    return (
      <section
        key={key}
        className={`v2-pods__section${nested ? ' v2-pods__section--kind' : ''}`}
        aria-labelledby={headingId}
      >
        {onToggle ? (
          <button
            type="button"
            id={headingId}
            className="v2-pods__section-head"
            onClick={onToggle}
            aria-expanded={open}
          >
            {header}
          </button>
        ) : (
          <h2 id={headingId} className="v2-pods__section-head">{header}</h2>
        )}
        {open && <div className="v2-pods__rows">{rows}</div>}
      </section>
    );
  };

  const createForm = showCreate && (
    <form className="v2-pods__create" onSubmit={handleCreatePod}>
      <input
        className="v2-pods__create-input"
        type="text"
        value={newPodName}
        onChange={(event) => setNewPodName(event.target.value)}
        placeholder={t('podsSidebar.create.namePlaceholder')}
        autoFocus
      />
      <input
        className="v2-pods__create-input"
        type="text"
        value={newPodGoal}
        onChange={(event) => setNewPodGoal(event.target.value)}
        placeholder={t('podsSidebar.create.goalPlaceholder')}
      />
      <fieldset className="v2-pods__join-policy">
        <legend>{t('podsSidebar.create.whoCanJoin')}</legend>
        <label>
          <input type="radio" name="new-pod-join-policy" value="open" checked={newPodJoinPolicy === 'open'} onChange={() => setNewPodJoinPolicy('open')} />
          <span>{t('podsSidebar.create.teamOption')}</span>
        </label>
        <label>
          <input type="radio" name="new-pod-join-policy" value="invite-only" checked={newPodJoinPolicy === 'invite-only'} onChange={() => setNewPodJoinPolicy('invite-only')} />
          <span>{t('podsSidebar.create.privateOption')}</span>
        </label>
      </fieldset>
      {newPodJoinPolicy === 'open' && <p className="v2-pods__join-policy-hint">{t('podsSidebar.create.teamDescription')}</p>}
      {createError && <div className="v2-pods__create-error">{createError}</div>}
      <div className="v2-pods__create-actions">
        <button type="button" className="v2-pods__create-cancel" onClick={() => setShowCreate(false)}>
          {t('podsSidebar.create.cancel')}
        </button>
        <button type="submit" className="v2-pods__create-submit" disabled={creating || !newPodName.trim()}>
          {creating ? t('podsSidebar.create.creating') : t('podsSidebar.create.submit')}
        </button>
      </div>
    </form>
  );

  const isPage = variant === 'page';
  const showSearch = !isPage || searchOpen || query !== '';

  const newPodButton = (
    <button
      type="button"
      className="v2-pods__new"
      onClick={() => {
        setShowCreate((open) => !open);
        setCreateError(null);
      }}
      disabled={creating}
      aria-label={t('podsSidebar.newPod')}
      title={t('podsSidebar.newPod')}
      aria-expanded={showCreate}
    >
      <ShellGlyph name="plus" size={17} />
    </button>
  );

  return (
    <aside className={`v2-pane v2-pods-aside${isPage ? ' v2-pods-aside--page' : ''}`}>
      <div className="v2-pods">
        {/* D223 (TASK-735): the phone page leads with the artboard's title bar,
            search as an icon beside the new-pod key. */}
        {isPage && (
          <div className="v2-pods__bar">
            <h1 className="v2-pods__page-title">{t('podsSidebar.workspace.listTitle')}</h1>
            <button
              type="button"
              className="v2-icon-button v2-pods__search-open"
              onClick={() => {
                setSearchOpen((open) => !open);
                if (searchOpen) setQuery('');
              }}
              aria-label={t('podsSidebar.workspace.search')}
              title={t('podsSidebar.workspace.search')}
              aria-expanded={showSearch}
            >
              <ShellGlyph name="search" size={17} />
            </button>
            {newPodButton}
          </div>
        )}
        <div className="v2-pods__body">
          {showSearch && (
            <div className="v2-pods__tools">
              <label className="v2-pods__search">
                <ShellGlyph name="search" size={15} />
                <input
                  ref={searchRef}
                  className="v2-pods__search-input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }}
                  placeholder={t('podsSidebar.workspace.search')}
                  aria-label={t('podsSidebar.workspace.search')}
                  autoFocus={isPage && searchOpen}
                />
                <kbd className="v2-pods__search-kbd" aria-hidden="true">{searchShortcutHint(browserPlatform())}</kbd>
              </label>
              {!isPage && newPodButton}
            </div>
          )}
          {createForm}
          {!loading && !error && listablePods.length > 0 && (
            <div className="v2-pods__view">
              <V2Segmented
                size={isPage ? 'md' : 'sm'}
                ariaLabel={t('podsSidebar.workspace.viewLabel')}
                value={listView}
                onChange={chooseListView}
                options={[
                  { value: 'recent', label: t('podsSidebar.workspace.recent') },
                  { value: 'all', label: t('podsSidebar.workspace.all'), count: listablePods.length },
                  { value: 'pinned', label: t('podsSidebar.workspace.pinnedTitle') },
                ]}
              />
            </div>
          )}
          {loading && <div className="v2-pods__empty"><span className="v2-spinner" /></div>}
          {!loading && error && <div className="v2-pods__empty">{error}</div>}
          {!loading && !error && (
            <div className="v2-pods__list">
              {searching ? (
                matches.length > 0
                  ? <div className="v2-pods__rows">{matches.map((pod) => renderRow(pod))}</div>
                  : <div className="v2-pods__empty v2-pods__empty--mono">{t('podsSidebar.workspace.noMatch')}</div>
              ) : (
                <>
                  {listablePods.length > 0 && listView === 'recent' && (
                    <div className="v2-pods__rows">{recent.map((pod) => renderRow(pod))}</div>
                  )}
                  {listablePods.length > 0 && listView === 'all' && everything.map((group) => renderSection(
                    group.kind,
                    t(`podsSidebar.workspace.${group.kind}`),
                    group.pods.map((pod) => renderRow(pod, true)),
                    {
                      count: group.pods.length,
                      open: openKinds.has(group.kind),
                      onToggle: () => toggleKind(group.kind),
                      nested: true,
                    },
                  ))}
                  {listablePods.length > 0 && listView === 'pinned' && (
                    pinnedPods.length > 0
                      ? <div className="v2-pods__rows">{pinnedPods.map((pod) => renderRow(pod))}</div>
                      : <div className="v2-pods__empty">{t('podsSidebar.workspace.noPinned')}</div>
                  )}
                  {listablePods.length === 0 && (
                    <div className="v2-pods__empty">{t('podsSidebar.empty.noPods')}</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};

export default V2PodsSidebar;
