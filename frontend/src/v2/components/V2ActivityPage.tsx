import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { requestFirstRunGuide } from '../firstRunGuide';
import { ATTENTION_CHANGED, notifyAttentionChanged } from '../hooks/useV2PodAttention';

type ActivityWindow = 'today' | '7d';

interface ActivityUpdate {
  id: string;
  podId: string | null;
  podName: string;
  content: string;
  timestamp: string | null;
}

interface AgentRecap {
  id: string;
  name: string;
  profilePicture?: string;
  lastActiveAt: string | null;
  messageCount: number;
  recap: string;
  updates: ActivityUpdate[];
}

interface NeedsYouItem {
  id: string;
  attentionItemId?: string;
  actorName?: string;
  kind: 'mention' | 'approval' | 'decision';
  title: string;
  detail: string;
  podId: string | null;
  podName: string;
  options?: Array<{ label: string; description?: string; recommended?: boolean }>;
  timestamp: string | null;
  // Mention rows carry where they live so a reply can land IN the thread.
  messageId?: number | string;
  threadRootId?: number | string;
}

interface BoardItem {
  id: string;
  taskId: string;
  title: string;
  status: 'pending' | 'claimed' | 'blocked' | 'done';
  podId: string;
  podName: string;
  updatedAt: string | null;
  lastUpdate: { text: string; author: string; createdAt: string | null } | null;
}

interface ActivityRecap {
  pods: Array<{ id: string; name: string }>;
  needsYou: NeedsYouItem[];
  agents: AgentRecap[];
  board: BoardItem[];
}

interface QueueResponse {
  items: Array<NeedsYouItem & { createdAt?: string | null }>;
  composePodId?: string | null;
  count: number;
  countsByPod: Record<string, number>;
  offset?: number;
  limit?: number;
  remaining?: number;
  hasMore?: boolean;
}

interface MovedLine {
  id: string;
  author: string;
  text: string;
  timestamp: string | null;
}

interface MovedGroup {
  id: string;
  name: string;
  lines: MovedLine[];
}

interface ActivitySnapshot {
  window?: ActivityWindow;
  podId?: string;
  recap?: ActivityRecap | null;
  queue?: NeedsYouItem[];
  queueCount?: number | null;
  queueRemaining?: number;
  queueCountsByPod?: Record<string, number>;
  replyDrafts?: Record<string, string>;
  focusedItemId?: string | null;
  scrollY?: number;
  savedAt?: number;
}

const ACTIVITY_SNAPSHOT_KEY = 'v2:activity:snapshot';

const readActivitySnapshot = (): ActivitySnapshot | null => {
  try {
    const raw = sessionStorage.getItem(ACTIVITY_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActivitySnapshot;
    if (!parsed.savedAt || Date.now() - parsed.savedAt > 10 * 60_000) {
      sessionStorage.removeItem(ACTIVITY_SNAPSHOT_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const relativeTime = (value: string | null | undefined): string => {
  if (!value) return '';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const V2ActivityPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const restoredSnapshotRef = useRef<ActivitySnapshot | null>(readActivitySnapshot());
  const restoredSnapshot = restoredSnapshotRef.current;
  const [window, setWindow] = useState<ActivityWindow>(restoredSnapshot?.window || 'today');
  const [podId, setPodId] = useState(restoredSnapshot?.podId || 'all');
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [recap, setRecap] = useState<ActivityRecap | null>(restoredSnapshot?.recap || null);
  const [loading, setLoading] = useState(!restoredSnapshot?.recap);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [actingApprovalId, setActingApprovalId] = useState<string | null>(null);
  const [acknowledgingMentionId, setAcknowledgingMentionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rulingId, setRulingId] = useState<string | null>(null);
  const [otherDecisionId, setOtherDecisionId] = useState<string | null>(null);
  const [otherDecisionValue, setOtherDecisionValue] = useState('');
  const [ruledDecisions, setRuledDecisions] = useState<Record<string, { value: string; by: string }>>({});
  const [queue, setQueue] = useState<NeedsYouItem[]>(restoredSnapshot?.queue || []);
  const [queueCount, setQueueCount] = useState<number | null>(restoredSnapshot?.queueCount ?? null);
  const [queueCountsByPod, setQueueCountsByPod] = useState<Record<string, number>>(restoredSnapshot?.queueCountsByPod || {});
  const [queueRemaining, setQueueRemaining] = useState(restoredSnapshot?.queueRemaining || 0);
  const [queueLoadingMore, setQueueLoadingMore] = useState(false);
  const [queueMoreError, setQueueMoreError] = useState(false);
  const [queueFailed, setQueueFailed] = useState(false);
  const queueScopeRef = useRef('all');
  const queueGenerationRef = useRef(0);
  const queueMoreButtonRef = useRef<HTMLButtonElement | null>(null);
  const [replyOpenIds, setReplyOpenIds] = useState<Set<string>>(new Set());
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>(restoredSnapshot?.replyDrafts || {});
  const [expandedMovedIds, setExpandedMovedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const refresh = () => setReloadKey((value) => value + 1);
    globalThis.window.addEventListener(ATTENTION_CHANGED, refresh);
    globalThis.window.addEventListener('focus', refresh);
    return () => {
      globalThis.window.removeEventListener(ATTENTION_CHANGED, refresh);
      globalThis.window.removeEventListener('focus', refresh);
    };
  }, []);

  useEffect(() => {
    const snapshot = restoredSnapshotRef.current;
    if (!snapshot) return;
    const restore = () => {
      if (snapshot.scrollY && snapshot.scrollY > 0) globalThis.window.scrollTo(0, snapshot.scrollY);
      if (snapshot.focusedItemId) {
        const row = document.querySelector<HTMLElement>(`[data-activity-item-id="${CSS.escape(snapshot.focusedItemId)}"]`);
        row?.focus();
      }
      sessionStorage.removeItem(ACTIVITY_SNAPSHOT_KEY);
      restoredSnapshotRef.current = null;
    };
    const frame = globalThis.window.requestAnimationFrame(restore);
    return () => globalThis.window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let active = true;
    const generation = queueGenerationRef.current + 1;
    queueGenerationRef.current = generation;
    queueScopeRef.current = podId;
    setLoading((current) => (recap ? current : true));
    setError(null);
    setQueueMoreError(false);
    setQueueLoadingMore(false);
    const token = localStorage.getItem('token');
    const headers = { 'x-auth-token': token ?? '' };
    // Recap and attention are independent facts. A failed queue read must
    // never substitute recap mentions or pretend the queue is empty.
    Promise.all([
      axios.get<ActivityRecap>('/api/activity/recap', {
        headers,
        params: { window, ...(podId !== 'all' ? { podId } : {}) },
      }),
      axios.get<QueueResponse>(
        '/api/activity/decision-queue',
        { headers, params: { limit: 50, offset: 0, ...(podId !== 'all' ? { podId } : {}) } },
      ).catch(() => null),
    ])
      .then(([recapResponse, queueResponse]) => {
        if (!active) return;
        setRecap(recapResponse.data);
        const rawItems = queueResponse?.data?.items;
        if (!Array.isArray(rawItems) || typeof queueResponse?.data?.count !== 'number'
          || (podId !== 'all' && !queueResponse?.data?.countsByPod)) {
          setQueueFailed(queue.length === 0);
          setQueueMoreError(queue.length > 0);
          return;
        }
        setQueueFailed(false);
        setQueueCount(queueResponse!.data.count);
        setQueueCountsByPod(queueResponse!.data.countsByPod || {});
        const queueItems = rawItems.map((item) => ({
          ...item,
          detail: item.detail || '',
          podName: item.podName || '',
          timestamp: item.timestamp ?? item.createdAt ?? null,
        }));
        setQueue(queueItems);
        setQueueRemaining(typeof queueResponse!.data.remaining === 'number'
          ? queueResponse!.data.remaining
          : Math.max(queueResponse!.data.count - queueItems.length, 0));
      })
      .catch(() => {
        if (active) {
          if (recap && queue.length > 0) {
            setQueueMoreError(true);
          } else {
            setError(t('activity.loadFailed'));
          }
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [podId, reloadKey, t, window]);

  const loadMoreQueue = async () => {
    if (queueMoreError) {
      setReloadKey((value) => value + 1);
      return;
    }
    if (queueLoadingMore || queueRemaining <= 0 || queueFailed) return;
    const requestedScope = podId;
    const requestedGeneration = queueGenerationRef.current;
    const offset = queue.length;
    setQueueLoadingMore(true);
    setQueueMoreError(false);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get<QueueResponse>('/api/activity/decision-queue', {
        headers: { 'x-auth-token': token ?? '' },
        params: { limit: 50, offset, ...(requestedScope !== 'all' ? { podId: requestedScope } : {}) },
      });
      if (queueScopeRef.current !== requestedScope || queueGenerationRef.current !== requestedGeneration) return;
      const nextItems = (response.data?.items || []).map((item) => ({
        ...item,
        detail: item.detail || '',
        podName: item.podName || '',
        timestamp: item.timestamp ?? item.createdAt ?? null,
      }));
      setQueue((current) => {
        const existing = new Set(current.map((item) => `${item.kind}:${item.id}`));
        return [...current, ...nextItems.filter((item) => !existing.has(`${item.kind}:${item.id}`))];
      });
      const loaded = offset + nextItems.length;
      setQueueRemaining(typeof response.data?.remaining === 'number'
        ? response.data.remaining
        : Math.max((response.data?.count || queueCount || 0) - loaded, 0));
      globalThis.window.requestAnimationFrame(() => {
        if (queueMoreButtonRef.current) {
          queueMoreButtonRef.current.focus();
          return;
        }
        const firstAdded = nextItems[0]?.id;
        if (firstAdded) document.querySelector<HTMLElement>(`[data-activity-item-id="${CSS.escape(String(firstAdded))}"]`)?.focus();
      });
    } catch {
      if (queueScopeRef.current === requestedScope && queueGenerationRef.current === requestedGeneration) setQueueMoreError(true);
    } finally {
      if (queueGenerationRef.current === requestedGeneration) setQueueLoadingMore(false);
    }
  };

  const movedGroups = useMemo<MovedGroup[]>(() => {
    if (!recap) return [];
    const groups = new Map<string, MovedGroup>();
    const add = (podId: string | null | undefined, podName: string | undefined, line: MovedLine) => {
      const id = podId || `name:${podName || 'unknown'}`;
      const group = groups.get(id) || { id, name: podName || t('activity.movedForward.unknownPod'), lines: [] };
      group.lines.push(line);
      groups.set(id, group);
    };
    recap.agents.forEach((agent) => agent.updates.forEach((update) => add(update.podId, update.podName, {
      id: `agent:${agent.id}:${update.id}`,
      author: agent.name,
      text: update.content,
      timestamp: update.timestamp,
    })));
    recap.board.forEach((item) => {
      if (!item.lastUpdate) return;
      add(item.podId, item.podName, {
        id: `board:${item.id}`,
        author: item.lastUpdate.author,
        text: `${item.title} — ${item.lastUpdate.text}`,
        timestamp: item.lastUpdate.createdAt || item.updatedAt,
      });
    });
    return [...groups.values()]
      .map((group) => ({
        ...group,
        lines: [...group.lines].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime()),
      }))
      .sort((a, b) => new Date(b.lines[0]?.timestamp || 0).getTime() - new Date(a.lines[0]?.timestamp || 0).getTime());
  }, [recap, t]);

  const scopedPods = useMemo(() => {
    return recap?.pods || [];
  }, [recap]);

  const openPod = (targetPodId: string | null, messageId?: number | string) => {
    if (!targetPodId) return;
    try {
      const active = document.activeElement?.closest<HTMLElement>('[data-activity-item-id]');
      sessionStorage.setItem(ACTIVITY_SNAPSHOT_KEY, JSON.stringify({
        window,
        podId,
        recap,
        queue,
        queueCount,
        queueRemaining,
        queueCountsByPod,
        replyDrafts,
        focusedItemId: active?.dataset.activityItemId || null,
        scrollY: globalThis.window.scrollY,
        savedAt: Date.now(),
      } satisfies ActivitySnapshot));
    } catch {
      // Navigation should still work if storage is unavailable or full.
    }
    const target = messageId === undefined || messageId === null || messageId === ''
      ? ''
      : `#message-${String(messageId)}`;
    navigate(`/v2/pods/${targetPodId}${target}`);
  };

  const openFirstBoard = () => {
    const firstPod = recap?.pods[0];
    if (firstPod) {
      navigate(`/v2/pods/${firstPod.id}/board?createTask=1`);
      return;
    }
    navigate('/v2');
  };

  const actOnApproval = async (item: NeedsYouItem, action: 'approve' | 'reject') => {
    if (actingApprovalId) return;
    setActingApprovalId(item.id);
    setActionError(null);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.post<{ success?: boolean }>(
        `/api/activity/${encodeURIComponent(item.id)}/${action}`,
        { notes: `${action === 'approve' ? 'Approved' : 'Rejected'} via Activity` },
        { headers: { 'x-auth-token': token ?? '' } },
      );
      if (!response.data?.success) throw new Error('Approval action failed');
      notifyAttentionChanged();
      setReloadKey((value) => value + 1);
    } catch {
      setActionError(t('activity.approval.actionFailed'));
    } finally {
      setActingApprovalId(null);
    }
  };

  const ruleDecision = async (item: NeedsYouItem, value: string) => {
    if (rulingId || !value.trim()) return;
    setRulingId(item.id);
    setActionError(null);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.post<{ ok?: boolean }>(
        `/api/activity/decisions/${encodeURIComponent(item.id)}/choose`,
        { value },
        { headers: { 'x-auth-token': token ?? '' } },
      );
      if (!response.data?.ok) throw new Error('Decision ruling failed');
      notifyAttentionChanged();
      setOtherDecisionId(null);
      setOtherDecisionValue('');
      setReloadKey((value) => value + 1);
    } catch (error) {
      const standing = axios.isAxiosError(error) ? error.response?.data?.decision?.ruling : null;
      if (standing?.value && standing?.by) {
        setRuledDecisions((current) => ({
          ...current,
          [item.id]: { value: standing.value, by: standing.by },
        }));
      } else {
        setActionError(t('activity.decision.actionFailed'));
      }
    } finally {
      setRulingId(null);
    }
  };

  // Reply-in-place (Sam, 2026-09-01: "a way to really work with these agents
  // more easily… and tell them what is on my mind"). The reply posts into
  // the SAME thread the mention came from, addressed to the message, through
  // the ordinary messages route — so the agent gets the normal implicit-reply
  // wake — and then the mention is acknowledged.
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [repliedIds, setRepliedIds] = useState<Set<string>>(new Set());
  const sendReply = async (item: NeedsYouItem) => {
    const content = (replyDrafts[item.id] || '').trim();
    if (!content || replyingId || !item.podId) return;
    setReplyingId(item.id);
    setActionError(null);
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        `/api/messages/${item.podId}`,
        { content, threadRootId: item.threadRootId, replyToMessageId: item.messageId },
        { headers: { 'x-auth-token': token ?? '' } },
      );
      setRepliedIds((prev) => new Set(prev).add(item.id));
      setReplyDrafts((prev) => ({ ...prev, [item.id]: '' }));
      if (item.attentionItemId) await axios.post(`/api/activity/${item.attentionItemId}/acknowledge`, {}, { headers: { 'x-auth-token': token ?? '' } }).catch(() => null);
      notifyAttentionChanged();
      setReloadKey((value) => value + 1);
    } catch {
      setActionError(t('activity.mention.actionFailed'));
    } finally {
      setReplyingId(null);
    }
  };

  const markHandled = async (item: NeedsYouItem) => {
    if (acknowledgingMentionId) return;
    setAcknowledgingMentionId(item.id);
    setActionError(null);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.post<{ success?: boolean }>(
        `/api/activity/${item.attentionItemId || item.id}/handled`,
        {},
        { headers: { 'x-auth-token': token ?? '' } },
      );
      if (!response.data?.success) throw new Error('Activity handling failed');
      notifyAttentionChanged();
      setReloadKey((value) => value + 1);
    } catch {
      setActionError(t('activity.mention.actionFailed'));
    } finally {
      setAcknowledgingMentionId(null);
    }
  };

  const isDayZero = podId === 'all'
    && queueCount === 0
    && recap?.agents.length === 0
    && recap.board.length === 0;

  return (
    <div className="v2-activity" aria-busy={loading}>
      <header className="v2-activity__header">
        <div className="v2-activity__bar-title">
          <h1 className="v2-activity__title">{t('activity.title')}</h1>
          <span className="v2-activity__subtitle">{t('activity.subtitle')}</span>
        </div>
        <div className="v2-activity__controls" aria-label={t('activity.controlsAriaLabel')}>
          <div className="v2-activity__window" role="group" aria-label={t('activity.windowAriaLabel')}>
            {(['today', '7d'] as ActivityWindow[]).map((value) => (
              <button key={value} type="button" className={`v2-activity__window-button${window === value ? ' v2-activity__window-button--active' : ''}`} onClick={() => setWindow(value)} aria-pressed={window === value}>
                {t(`activity.windows.${value}`)}
              </button>
            ))}
          </div>
          <div className="v2-activity__scope" role="group" aria-label={t('activity.podScopeLabel')}>
            <button type="button" className={`v2-activity__scope-button${podId === 'all' ? ' v2-activity__scope-button--active' : ''}`} onClick={() => { setPodId('all'); setScopeMenuOpen(false); }} aria-pressed={podId === 'all'}>{t('activity.allPods')}</button>
            {scopedPods.slice(0, 2).map((pod) => (
              <button key={pod.id} type="button" className={`v2-activity__scope-button${podId === pod.id ? ' v2-activity__scope-button--active' : ''}`} onClick={() => { setPodId(pod.id); setScopeMenuOpen(false); }} aria-pressed={podId === pod.id}>{pod.name}</button>
            ))}
            {scopedPods.length > 2 && <button type="button" className="v2-activity__scope-button" onClick={() => setScopeMenuOpen((open) => !open)} aria-expanded={scopeMenuOpen}>{t('activity.morePods')}</button>}
            {scopeMenuOpen && scopedPods.slice(2).map((pod) => (
              <button key={pod.id} type="button" className={`v2-activity__scope-button v2-activity__scope-button--menu${podId === pod.id ? ' v2-activity__scope-button--active' : ''}`} onClick={() => { setPodId(pod.id); setScopeMenuOpen(false); }} aria-pressed={podId === pod.id}>{pod.name}</button>
            ))}
          </div>
        </div>
      </header>

      {loading && <div className="v2-activity__loading"><span className="v2-spinner" /></div>}
      {!loading && error && <div className="v2-activity__error" role="alert">{error}</div>}
      {!loading && !error && recap && (
        <>
          <div className="v2-activity__sections">
          <section className="v2-activity__section" aria-labelledby="activity-needs-you">
            <div className="v2-activity__section-heading">
              <h2 id="activity-needs-you">{t('activity.needsYou.title')}</h2>
              {!isDayZero && queueCount !== null && queueCount > 0 && <span className="v2-activity__count" aria-label={t('activity.needsYou.countLabel', { count: queueCount })}>{queueCount}</span>}
              <p>{t('activity.needsYou.countDescription', { count: queueCount || 0 })}</p>
            </div>
            {queueFailed ? <p role="status">{t('activity.loadFailed')}</p> : isDayZero ? (
              <div className="v2-activity__queue">
                <article className="v2-activity__queue-row v2-activity__queue-row--onboarding">
                  <span className="v2-activity__queue-mark" aria-hidden="true">1</span>
                  <div className="v2-activity__queue-copy">
                    <div className="v2-activity__queue-kind">{t('activity.dayZero.kind')}</div>
                    <strong>{t('activity.dayZero.guide.title')}</strong>
                    <p>{t('activity.dayZero.guide.description')}</p>
                    <span>{t('activity.dayZero.guide.leaves')}</span>
                  </div>
                  <div className="v2-activity__queue-actions">
                    <button type="button" onClick={requestFirstRunGuide}>{t('activity.dayZero.guide.cta')}</button>
                  </div>
                </article>
                <article className="v2-activity__queue-row v2-activity__queue-row--onboarding">
                  <span className="v2-activity__queue-mark" aria-hidden="true">2</span>
                  <div className="v2-activity__queue-copy">
                    <div className="v2-activity__queue-kind">{t('activity.dayZero.kind')}</div>
                    <strong>{t('activity.dayZero.agent.title')}</strong>
                    <p>{t('activity.dayZero.agent.description')}</p>
                    <span>{t('activity.dayZero.agent.leaves')}</span>
                  </div>
                  <div className="v2-activity__queue-actions">
                    <button type="button" onClick={() => navigate('/v2/agents')}>{t('activity.dayZero.agent.cta')}</button>
                    <button type="button" className="v2-activity__queue-action--secondary" onClick={() => navigate('/v2/agents/byo')}>{t('activity.dayZero.agent.secondary')}</button>
                  </div>
                </article>
                <article className="v2-activity__queue-row v2-activity__queue-row--onboarding">
                  <span className="v2-activity__queue-mark" aria-hidden="true">3</span>
                  <div className="v2-activity__queue-copy">
                    <div className="v2-activity__queue-kind">{t('activity.dayZero.kind')}</div>
                    <strong>{t('activity.dayZero.task.title')}</strong>
                    <p>{t('activity.dayZero.task.description')}</p>
                    <span>{t('activity.dayZero.task.leaves')}</span>
                  </div>
                  <div className="v2-activity__queue-actions">
                    <button type="button" onClick={openFirstBoard}>{t('activity.dayZero.task.cta')}</button>
                  </div>
                </article>
              </div>
            ) : queue.length === 0 ? (
              <div className="v2-activity__empty">
                {queueCount === 0 ? <>
                  <strong>{t('activity.needsYou.emptyTitle')}</strong>
                  <span>{t('activity.needsYou.emptyDescription')}</span>
                </> : <strong>{t('activity.needsYou.countLabel', { count: queueCount })}</strong>}
              </div>
            ) : (
              <div className="v2-activity__queue">
                {queue.map((item) => (
                  <article key={item.id} data-activity-item-id={item.id} tabIndex={-1} className={`v2-activity__queue-row v2-activity__queue-row--${item.kind}${item.kind === 'decision' && ruledDecisions[item.id] ? ' v2-activity__queue-row--settled' : ''}`}>
                    <span className="v2-activity__queue-mark" aria-hidden="true">
                      {item.kind === 'mention' ? '@' : item.kind === 'approval' ? '!' : '?'}
                    </span>
                    <div className="v2-activity__queue-copy">
                      <div className="v2-activity__queue-kind">{t(`activity.needsYou.kinds.${item.kind}`)} · {item.podName}{item.timestamp ? ` · ${relativeTime(item.timestamp)}` : ''}</div>
                      <div className="v2-activity__queue-topline">
                        <strong>{item.kind === 'mention' && item.actorName ? item.actorName : item.title}</strong>
                      </div>
                      {item.detail && <p>{item.detail}</p>}
                    </div>
                    <div className="v2-activity__queue-actions">
                      {item.kind === 'approval' && (
                        <>
                          <button type="button" onClick={() => actOnApproval(item, 'approve')} disabled={actingApprovalId === item.id}>
                            {actingApprovalId === item.id ? t('activity.approval.working') : t('activity.approval.approve')}
                          </button>
                          <button type="button" className="v2-activity__queue-action--secondary" onClick={() => actOnApproval(item, 'reject')} disabled={actingApprovalId === item.id}>
                            {t('activity.approval.deny')}
                          </button>
                        </>
                      )}
                      {item.kind === 'mention' && (
                        <>
                          {!replyOpenIds.has(item.id) ? <button type="button" onClick={() => setReplyOpenIds((current) => new Set(current).add(item.id))}>{t('activity.reply.open')}</button> : <div className="v2-activity__reply" data-testid="queue-reply">
                            <textarea aria-label={t('activity.reply.placeholder')} className="v2-activity__reply-input" rows={2} placeholder={t('activity.reply.placeholder')} value={replyDrafts[item.id] || ''} onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendReply(item); }} disabled={replyingId === item.id} />
                            <button type="button" onClick={() => sendReply(item)} disabled={replyingId === item.id || !(replyDrafts[item.id] || '').trim()}>{replyingId === item.id ? t('activity.reply.working') : repliedIds.has(item.id) ? t('activity.reply.sent') : t('activity.reply.send')}</button>
                          </div>}
                          <button type="button" className="v2-activity__queue-action--thread" onClick={() => markHandled(item)} disabled={acknowledgingMentionId === item.id}>
                            {acknowledgingMentionId === item.id ? t('activity.mention.working') : t('activity.mention.markHandled')}
                          </button>
                        </>
                      )}
                      {item.kind === 'decision' && (item.options || []).length > 0 && (
                        <>
                          {ruledDecisions[item.id] ? (
                            <span className="v2-activity__decision-ruled" role="status">
                              {t('activity.decision.ruled', ruledDecisions[item.id])}
                            </span>
                          ) : (
                            <>
                              {[...(item.options || [])]
                                .sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)))
                                .map((option) => (
                                  <div className="v2-activity__option-choice" key={option.label}>
                                    <button
                                      type="button"
                                      className={`v2-activity__option${option.recommended ? ' v2-activity__option--recommended' : ''}`}
                                      onClick={() => ruleDecision(item, option.label)}
                                      disabled={rulingId === item.id}
                                      aria-label={t('activity.decision.ruleOption', { option: option.label })}
                                    >
                                      {rulingId === item.id ? t('activity.decision.working') : option.label}
                                    </button>
                                    {option.description && (
                                      <span className="v2-activity__option-description">{option.description}</span>
                                    )}
                                  </div>
                                ))}
                              <button
                                type="button"
                                className="v2-activity__queue-action--secondary v2-activity__option"
                                onClick={() => setOtherDecisionId((current) => current === item.id ? null : item.id)}
                                disabled={rulingId === item.id}
                              >
                                {t('activity.decision.other')}
                              </button>
                              {otherDecisionId === item.id && (
                                <div className="v2-activity__decision-other" data-testid="decision-other">
                                  <textarea
                                    aria-label={t('activity.decision.otherPlaceholder')}
                                    rows={2}
                                    value={otherDecisionValue}
                                    onChange={(event) => setOtherDecisionValue(event.target.value)}
                                    disabled={rulingId === item.id}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => ruleDecision(item, otherDecisionValue)}
                                    disabled={rulingId === item.id || !otherDecisionValue.trim()}
                                  >
                                    {rulingId === item.id ? t('activity.decision.working') : t('activity.decision.sendOther')}
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                        </>
                      )}
                      {item.kind === 'decision' && (item.options || []).length === 0 && (
                        <button type="button" className="v2-activity__queue-action--thread" onClick={() => markHandled(item)} disabled={acknowledgingMentionId === item.id}>
                          {acknowledgingMentionId === item.id ? t('activity.mention.working') : t('activity.mention.markHandled')}
                        </button>
                      )}
                      <button type="button" className="v2-activity__queue-action--thread" onClick={() => openPod(item.podId, item.messageId)} disabled={!item.podId}>
                        {item.messageId === undefined || item.messageId === null || item.messageId === '' ? t('activity.openPod') : t('activity.open')}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {queue.length > 0 && (queueRemaining > 0 || queueMoreError) && (
              <button
                type="button"
                ref={queueMoreButtonRef}
                className="v2-activity__queue-more"
                onClick={loadMoreQueue}
                disabled={queueLoadingMore}
              >
                {queueLoadingMore
                  ? t('activity.needsYou.loadingMore', { defaultValue: 'Loading…' })
                  : queueMoreError
                    ? t('activity.needsYou.retry', { defaultValue: 'Retry' })
                    : t('activity.needsYou.showMore', { count: queueRemaining, defaultValue: `Show more · ${queueRemaining} remaining` })}
              </button>
            )}
            {actionError && <div className="v2-activity__action-error" role="alert">{actionError}</div>}
          </section>

          <section className="v2-activity__section v2-activity__moved" aria-labelledby="activity-moved-forward">
            <div className="v2-activity__section-heading">
              <h2 id="activity-moved-forward">{t('activity.movedForward.title')}</h2>
              <span className="v2-activity__count">{movedGroups.reduce((total, group) => total + group.lines.length, 0)}</span>
              <p>{t('activity.movedForward.description')}</p>
            </div>
            {movedGroups.length === 0 ? <div className="v2-activity__empty v2-activity__empty--plain"><strong>{t('activity.movedForward.empty')}</strong></div> : <div className="v2-activity__moved-list">
              {movedGroups.map((group) => {
                const expanded = expandedMovedIds.has(group.id);
                const cappedLines = group.lines.slice(0, 20);
                const visible = expanded ? cappedLines : cappedLines.slice(0, 3);
                return <article key={group.id} className="v2-activity__moved-group">
                  <div className="v2-activity__moved-head"><span>{group.name}</span><span>{group.lines.length}</span></div>
                  <div className="v2-activity__moved-lines">
                    {visible.map((line) => <div key={line.id} className="v2-activity__moved-line"><strong>{line.author}</strong><span>{line.text}</span><time>{relativeTime(line.timestamp)}</time></div>)}
                  </div>
                  {cappedLines.length > 3 && <button type="button" className="v2-activity__moved-more" onClick={() => setExpandedMovedIds((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })}>{expanded ? t('activity.movedForward.showLess') : t('activity.movedForward.more', { count: cappedLines.length - 3 })}</button>}
                </article>;
              })}
            </div>}
          </section>
          </div>
        </>
      )}
      <footer className="v2-activity__footer">{t('activity.footer')}</footer>
    </div>
  );
};

export default V2ActivityPage;
