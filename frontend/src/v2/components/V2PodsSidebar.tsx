import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import V2Avatar from './V2Avatar';
import { UseV2PodsResult, V2Pod, V2PodMember, useV2Pods } from '../hooks/useV2Pods';
import { useV2Api } from '../hooks/useV2Api';
import { useAuth } from '../../context/AuthContext';

interface Connector {
  _id: string;
  type: string;
  status: string;
  podId?: { _id: string; name?: string } | string | null;
}

interface AttentionItem {
  id: string;
  podId: string | null;
}

interface V2PodsSidebarProps {
  selectedPodId: string | null;
  podsState?: UseV2PodsResult;
  // The drawer only exists below 760px. Desktop always shows this column.
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

const DM_POD_TYPES = new Set(['agent-room', 'agent-dm']);

const connectorLabel = (type: string): string => ({
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  groupme: 'GroupMe',
  x: 'X',
  instagram: 'Instagram',
}[type] || type);

const podTimestamp = (pod: V2Pod): number => {
  const value = pod.lastMessage?.createdAt || pod.updatedAt || pod.createdAt;
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const sortPods = (pods: V2Pod[]): V2Pod[] => (
  [...pods].sort((left, right) => podTimestamp(right) - podTimestamp(left))
);

const isHumanPair = (pod: V2Pod): boolean => {
  const members = pod.members || [];
  return pod.type === 'chat'
    && members.length === 2
    && members.every((member) => typeof member === 'object' && !member.isBot);
};

// The stored types stay unchanged. The workspace grammar puts agent DMs and
// human two-person chat under direct; every other member pod remains a room.
// Keeping this predicate named makes a new Pod type an explicit review point.
export const isDirectPod = (pod: V2Pod): boolean => (
  DM_POD_TYPES.has(String(pod.type || '')) || isHumanPair(pod)
);

const directMemberFor = (pod: V2Pod, currentUserId?: string): V2PodMember | undefined => (
  (pod.members || []).find((member): member is V2PodMember => (
    typeof member === 'object' && member._id !== currentUserId
  )) || (pod.members || []).find((member): member is V2PodMember => typeof member === 'object')
);

const V2PodsSidebar: React.FC<V2PodsSidebarProps> = ({
  selectedPodId, podsState, mobileOpen = false, onMobileClose,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const api = useV2Api();
  const { currentUser } = useAuth();
  const ownPodsState = useV2Pods();
  const {
    pods, loading, error, createPod,
  } = podsState || ownPodsState;
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [attentionItems, setAttentionItems] = useState<AttentionItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newPodName, setNewPodName] = useState('');
  const [newPodGoal, setNewPodGoal] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  // Channels are the caller's existing bindings, never a discovery surface.
  useEffect(() => {
    let active = true;
    api.get<Connector[]>('/api/integrations/user/all')
      .then((data) => {
        if (active) setConnectors(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (active) setConnectors([]);
      });
    return () => { active = false; };
  }, [api]);

  // TASK-129 deliberately has one attention source. PR 2 receives this same
  // collection for the inspector's rows; the sidebar only derives its count.
  useEffect(() => {
    let active = true;
    api.get<{ items?: AttentionItem[] }>('/api/activity/decision-queue')
      .then((data) => {
        if (active) setAttentionItems(Array.isArray(data?.items) ? data.items : []);
      })
      .catch(() => {
        if (active) setAttentionItems([]);
      });
    return () => { active = false; };
  }, [api]);

  const { rooms, direct } = useMemo(() => {
    const roomPods = pods.filter((pod) => !isDirectPod(pod));
    const directPods = pods.filter(isDirectPod);
    return { rooms: sortPods(roomPods), direct: sortPods(directPods) };
  }, [pods]);

  const attentionCountByPod = useMemo(() => attentionItems.reduce<Record<string, number>>((counts, item) => {
    if (!item.podId) return counts;
    counts[item.podId] = (counts[item.podId] || 0) + 1;
    return counts;
  }, {}), [attentionItems]);

  const channels = useMemo(() => connectors.map((connector) => {
    const podId = typeof connector.podId === 'object' ? connector.podId?._id : connector.podId;
    const boundPod = pods.find((pod) => pod._id === podId);
    const name = typeof connector.podId === 'object'
      ? (connector.podId?.name || boundPod?.name || t('podsSidebar.workspace.untitled'))
      : (boundPod?.name || t('podsSidebar.workspace.untitled'));
    return {
      ...connector,
      podId: podId || null,
      label: `${connectorLabel(connector.type)} · ${name}`,
    };
  }), [connectors, pods, t]);

  const nextPlatform = connectors.some((connector) => connector.type === 'slack') ? 'Telegram' : 'Slack';

  const selectPod = (podId: string) => {
    navigate(`/v2/pods/${podId}`);
    onMobileClose?.();
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

  const renderPodRow = (pod: V2Pod, kind: 'room' | 'direct') => {
    const selected = pod._id === selectedPodId;
    const attentionCount = attentionCountByPod[pod._id] || 0;
    const directMember = kind === 'direct' ? directMemberFor(pod, currentUser?._id) : undefined;
    return (
      <button
        key={pod._id}
        type="button"
        className={`v2-pods__row v2-pods__row--${kind}${selected ? ' v2-pods__row--selected' : ''}`}
        onClick={() => selectPod(pod._id)}
      >
        {directMember && (
          <span aria-hidden="true">
            <V2Avatar
              className="v2-pods__direct-avatar"
              name={directMember.username || pod.name}
              src={directMember.profilePicture || undefined}
              size="sm"
            />
          </span>
        )}
        <span className="v2-pods__row-name">{pod.name}</span>
        {selected && attentionCount > 0 && (
          <span className="v2-pods__attention-count" aria-label={t('podsSidebar.workspace.needsYouCount', { count: attentionCount })}>
            {attentionCount}
          </span>
        )}
      </button>
    );
  };

  return (
    <aside className={`v2-pane v2-pods-aside${mobileOpen ? ' v2-pods-aside--open' : ''}`}>
      <div className="v2-pods">
        <button
          type="button"
          className="v2-pods__mobile-close"
          onClick={() => onMobileClose?.()}
          title={t('podsSidebar.closeTitle')}
          aria-label={t('podsSidebar.closeAriaLabel')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        {loading && <div className="v2-pods__empty"><span className="v2-spinner" /></div>}
        {!loading && error && <div className="v2-pods__empty">{error}</div>}
        {!loading && !error && (
          <div className="v2-pods__list">
            <section className="v2-pods__group" aria-labelledby="v2-pods-rooms">
              <h2 id="v2-pods-rooms" className="v2-pods__group-label">{t('podsSidebar.workspace.rooms')}</h2>
              <div className="v2-pods__rows">{rooms.map((pod) => renderPodRow(pod, 'room'))}</div>
              <button
                type="button"
                className="v2-pods__new-line"
                onClick={() => {
                  setShowCreate((open) => !open);
                  setCreateError(null);
                }}
                disabled={creating}
              >
                + {t('podsSidebar.workspace.new')}
              </button>
              {showCreate && (
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
              )}
            </section>

            <section className="v2-pods__group" aria-labelledby="v2-pods-channels">
              <h2 id="v2-pods-channels" className="v2-pods__group-label">{t('podsSidebar.workspace.channels')}</h2>
              <div className="v2-pods__rows">
                {channels.map((connector) => (
                  <button
                    key={connector._id}
                    type="button"
                    className="v2-pods__channel"
                    onClick={() => connector.podId && selectPod(connector.podId)}
                    disabled={!connector.podId}
                  >
                    <span className={`v2-pods__channel-dot${connector.status === 'connected' ? ' v2-pods__channel-dot--live' : ''}`} aria-hidden="true" />
                    <span>{connector.label}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="v2-pods__connect-line" onClick={() => navigate('/v2/connectors')}>
                + {t('podsSidebar.workspace.connect', { platform: nextPlatform })}
              </button>
            </section>

            <section className="v2-pods__group" aria-labelledby="v2-pods-direct">
              <h2 id="v2-pods-direct" className="v2-pods__group-label">{t('podsSidebar.workspace.direct')}</h2>
              <div className="v2-pods__rows">{direct.map((pod) => renderPodRow(pod, 'direct'))}</div>
            </section>
          </div>
        )}
      </div>
    </aside>
  );
};

export default V2PodsSidebar;
