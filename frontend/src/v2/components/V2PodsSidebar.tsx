import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import V2Avatar from './V2Avatar';
import { UseV2PodsResult, V2Pod, V2PodMember, useV2Pods } from '../hooks/useV2Pods';
import { useV2Pinned } from '../hooks/useV2Pinned';
import { V2AttentionItem } from '../hooks/useV2PodAttention';
import { useAuth } from '../../context/AuthContext';
import {
  RECENT_LIMIT, podInitials, readPodVisits, relativeTime,
} from '../lib/podRecency';

interface V2PodsSidebarProps {
  selectedPodId: string | null;
  podsState?: UseV2PodsResult;
  attentionItems?: V2AttentionItem[];
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

// Kinds only appear inside the Everything fold (walk-1 miss 3). Order is the
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

const SECTION_PINNED = 'pinned';
const SECTION_RECENT = 'recent';
const SECTION_EVERYTHING = 'everything';
const EVERYTHING_OPEN_KEY = 'v2:pods.everythingOpen';
const KIND_OPEN_KEY = 'v2:pods.kindsOpen';

const readSessionFlag = (key: string): boolean => {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

const writeSessionFlag = (key: string, value: boolean) => {
  try {
    sessionStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Session storage unavailable: the fold simply starts closed next time.
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
  const value = pod.lastMessage?.createdAt || pod.updatedAt || pod.createdAt;
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

// Everything: every pod the person is in, grouped by kind, each group sorted by
// last touched. Pinned pods appear here too; the fold is the full inventory.
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
  [...pods].sort((left, right) => podMessageTime(right) - podMessageTime(left))
);

// Recent = the pods I opened last (visit log), falling back to last-message
// time for pods never opened on this device. Pinned pods are excluded because
// they already sit above Recent.
export const recentPods = (
  pods: V2Pod[],
  pinnedPodIds: Set<string>,
  visits: Record<string, number>,
  limit: number = RECENT_LIMIT,
): V2Pod[] => {
  const touched = (pod: V2Pod) => visits[pod._id] || podMessageTime(pod);
  return pods
    .filter((pod) => !pinnedPodIds.has(pod._id))
    .sort((left, right) => touched(right) - touched(left))
    .slice(0, limit);
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
  selectedPodId, podsState, attentionItems = [], variant = 'column',
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const { pinned } = useV2Pinned();
  const ownPodsState = useV2Pods();
  const {
    pods, loading, error, createPod,
  } = podsState || ownPodsState;
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [visits, setVisits] = useState<Record<string, number>>(() => readPodVisits());
  const [everythingOpen, setEverythingOpen] = useState<boolean>(() => readSessionFlag(EVERYTHING_OPEN_KEY));
  const [openKinds, setOpenKinds] = useState<Set<PodKind>>(() => readOpenKinds());
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newPodName, setNewPodName] = useState('');
  const [newPodGoal, setNewPodGoal] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The visit log is written by the layout when a pod opens; re-read it here so
  // Recent reorders without a reload. Times refresh once a minute.
  useEffect(() => {
    setVisits(readPodVisits());
  }, [selectedPodId]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

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

  const attentionCountByPod = useMemo(() => attentionItems.reduce<Record<string, number>>((counts, item) => {
    if (!item.podId) return counts;
    counts[item.podId] = (counts[item.podId] || 0) + 1;
    return counts;
  }, {}), [attentionItems]);

  const listablePods = useMemo(() => pods.filter((pod) => podKind(pod) !== null), [pods]);
  const pinnedPods = useMemo(
    () => sortByMessageTime(listablePods.filter((pod) => pinned.has(pod._id))),
    [listablePods, pinned],
  );
  const recent = useMemo(() => recentPods(listablePods, pinned, visits), [listablePods, pinned, visits]);
  const everything = useMemo(() => groupPodsByKind(listablePods), [listablePods]);
  const searching = query.trim().length > 0;
  const matches = useMemo(() => {
    if (!searching) return [];
    const touched = (pod: V2Pod) => visits[pod._id] || podMessageTime(pod);
    return listablePods
      .filter((pod) => matchesQuery(pod, query))
      .sort((left, right) => touched(right) - touched(left));
  }, [listablePods, query, searching, visits]);

  const selectPod = useCallback((podId: string) => {
    navigate(`/v2/pods/${podId}`);
  }, [navigate]);

  const toggleEverything = () => {
    setEverythingOpen((open) => {
      writeSessionFlag(EVERYTHING_OPEN_KEY, !open);
      return !open;
    });
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
      const pod = await createPod(name, newPodGoal.trim() || undefined, 'team', 'open');
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
      setShowCreate(false);
      selectPod(pod._id);
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
    return (
      <button
        key={pod._id}
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
          />
        ) : (
          <span className="v2-pods__row-mark" aria-hidden="true">{podInitials(pod.name)}</span>
        )}
        <span className="v2-pods__row-name">{pod.name}</span>
        <span className="v2-pods__row-meta">
          {count > 0 && (
            <span className="v2-pods__row-pill" aria-label={t('podsSidebar.workspace.needsYouCount', { count })}>
              {count}
            </span>
          )}
          {time && <span className="v2-pods__row-time" aria-hidden="true">{time}</span>}
        </span>
      </button>
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

  return (
    <aside className={`v2-pane v2-pods-aside${isPage ? ' v2-pods-aside--page' : ''}`}>
      <div className="v2-pods">
        {isPage && <h1 className="v2-pods__page-title">{t('podsSidebar.workspace.listTitle')}</h1>}
        <div className="v2-pods__tools">
          <label className="v2-pods__search">
            <input
              ref={searchRef}
              className="v2-pods__search-input"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }}
              placeholder={t('podsSidebar.workspace.search')}
              aria-label={t('podsSidebar.workspace.search')}
            />
            <kbd className="v2-pods__search-kbd" aria-hidden="true" />
          </label>
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
            +
          </button>
        </div>
        {createForm}
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
                {pinnedPods.length > 0 && renderSection(SECTION_PINNED, t('podsSidebar.workspace.pinnedTitle'), pinnedPods.map((pod) => renderRow(pod)))}
                {recent.length > 0 && renderSection(SECTION_RECENT, t('podsSidebar.workspace.recent'), recent.map((pod) => renderRow(pod)))}
                {listablePods.length > 0 && renderSection(
                  SECTION_EVERYTHING,
                  t('podsSidebar.workspace.everything'),
                  everything.map((group) => renderSection(
                    group.kind,
                    t(`podsSidebar.workspace.${group.kind}`),
                    group.pods.map((pod) => renderRow(pod, true)),
                    {
                      count: group.pods.length,
                      open: openKinds.has(group.kind),
                      onToggle: () => toggleKind(group.kind),
                      nested: true,
                    },
                  )),
                  { count: listablePods.length, open: everythingOpen, onToggle: toggleEverything },
                )}
                {listablePods.length === 0 && (
                  <div className="v2-pods__empty">{t('podsSidebar.empty.noPods')}</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};

export default V2PodsSidebar;
