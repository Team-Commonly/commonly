import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UseV2PodsResult, V2Pod, useV2Pods } from '../hooks/useV2Pods';
import { groupPods, formatRelativeTime } from '../utils/grouping';
import { initialsFor } from '../utils/avatars';
import { useV2Pinned } from '../hooks/useV2Pinned';

type Filter = 'all' | 'team' | 'private' | 'pod';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'team', label: 'Team' },
  { key: 'private', label: 'Private' },
  { key: 'pod', label: 'Pod' },
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

const podStatusFor = (pod: V2Pod): { label: string; tone: 'agents' | 'empty' | 'direct' } => {
  if (podKind(pod) === 'private') return { label: 'Direct', tone: 'direct' };
  const agentCount = agentCountFor(pod);
  if (agentCount > 0) return { label: `${agentCount} agent${agentCount === 1 ? '' : 's'}`, tone: 'agents' };
  return { label: 'No agents', tone: 'empty' };
};

const podSnippetFor = (pod: V2Pod, meta: string): string => (
  pod.description?.trim() || meta
);

const matchesFilter = (pod: V2Pod, filter: Filter): boolean => {
  switch (filter) {
    // "Team" is the strictest pod-type filter — only pods explicitly typed
    // as team (multi-human collaborative). "Pod" is the broader product
    // bucket — every collaborative pod, i.e. anything that is not a 1:1
    // private DM. With more pod types added later (chat, study, games),
    // Team and Pod will naturally diverge.
    case 'team': return pod.type === 'team';
    case 'private': return podKind(pod) === 'private';
    case 'pod': return !isDmPod(pod);
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
  const { pods, loading, error, createPod } = podsState || ownPodsState;
  const { pinned, toggle: togglePin, isPinned } = useV2Pinned();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newPodName, setNewPodName] = useState('');
  const [newPodGoal, setNewPodGoal] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

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
    }, { all: 0, team: 0, private: 0, pod: 0 })
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
                const time = formatRelativeTime(pod.updatedAt || pod.createdAt);
                const active = pod._id === selectedPodId;
                const meta = podKind(pod) === 'private'
                  ? 'Direct message'
                  : (agentCount > 0
                    ? `${agentCount} agent${agentCount === 1 ? '' : 's'}`
                    : `${memberCount} member${memberCount === 1 ? '' : 's'}`);
                const status = podStatusFor(pod);
                const snippet = podSnippetFor(pod, meta);
                const pinnedNow = isPinned(pod._id);
                return (
                  <div
                    key={pod._id}
                    className={`v2-pods__row${pinnedNow ? ' v2-pods__row--pinned' : ''}`}
                  >
                    <button
                      type="button"
                      className={`v2-pods__item${active ? ' v2-pods__item--active' : ''}`}
                      onClick={() => navigate(`/v2/pods/${pod._id}`)}
                    >
                      <span className={podMarkClass(pod)}>
                        {podMarkFor(pod)}
                      </span>
                      <span className="v2-pods__item-body">
                        <span className="v2-pods__item-title-row">
                          <span className="v2-pods__item-title">{pod.name}</span>
                          <span className={`v2-pods__status v2-pods__status--${status.tone}`}>
                            {status.label}
                          </span>
                        </span>
                        <span className="v2-pods__item-snippet">
                          {snippet}
                        </span>
                      </span>
                      <span className="v2-pods__item-time">{time}</span>
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
