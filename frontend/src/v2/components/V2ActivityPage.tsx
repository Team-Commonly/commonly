import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../context/AuthContext';
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

// Pods carry a long descriptive title; the inbox names them by the short
// leading name the inspector uses ("sharpen"), lowercase in mono.
const shortPodName = (name: string): string => (
  (name || '').trim().split(/\s*[·—–:|]\s*/)[0].trim() || (name || '').trim()
).toLowerCase();

const actorMark = (name: string): string => {
  const parts = name.trim().split(/[\s·-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.length === 1 ? parts[0].slice(0, 2).toUpperCase() : (parts[0][0] + parts[1][0]).toUpperCase();
};

interface NeedsYouItem {
  id: string;
  attentionItemId?: string;
  actorName?: string;
  actorUserId?: string;
  // Which store the row came from — an agent's action proposal ('approval_action')
  // resolves through /api/approvals, a scope approval through /api/activity (#1650).
  sourceType?: string;
  // A settled decision keeps its ruling (from durable history) so the 0-state
  // can say when the last ask was answered.
  ruling?: { value?: string; by?: string; at?: string | null } | null;
  kind: 'mention' | 'approval' | 'decision' | 'handoff';
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
  // Account-level durable fact: once any attention item has existed, the
  // first-ask onboarding card should not return after the queue is resolved.
  hasEverHadAttention?: boolean | null;
  needsYou: NeedsYouItem[];
  agents: AgentRecap[];
  board: BoardItem[];
}

interface QueueResponse {
  items: Array<NeedsYouItem & { createdAt?: string | null }>;
  composePodId?: string | null;
  count: number;
  countsByPod: Record<string, number>;
  countsByKind?: Record<string, number>;
  offset?: number;
  limit?: number;
  remaining?: number;
  hasMore?: boolean;
}

interface DecisionHistoryResponse {
  items?: Array<NeedsYouItem & {
    status?: 'pending' | 'ruled';
    ruling?: { value?: string; by?: string; at?: string | null } | null;
    createdAt?: string | null;
  }>;
  count?: number;
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
  composePodId?: string;
  composeDraft?: string;
  replyDrafts?: Record<string, string>;
  focusedItemId?: string | null;
  scrollY?: number;
  savedAt?: number;
}

const ACTIVITY_SNAPSHOT_KEY = 'v2:activity:snapshot';

const snapshotKey = (accountId: string): string => `${ACTIVITY_SNAPSHOT_KEY}:${accountId}`;

const readActivitySnapshot = (accountId: string): ActivitySnapshot | null => {
  try {
    const raw = sessionStorage.getItem(snapshotKey(accountId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActivitySnapshot;
    if (!parsed.savedAt || Date.now() - parsed.savedAt > 10 * 60_000) {
      sessionStorage.removeItem(snapshotKey(accountId));
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
  const auth = useContext(AuthContext);
  const currentUser = auth?.currentUser || null;
  const authLoading = auth?.loading || false;
  const accountId = currentUser?._id ? String(currentUser._id) : null;
  const restoredSnapshotRef = useRef<ActivitySnapshot | null>(null);
  const snapshotAccountRef = useRef<string | null | undefined>(undefined);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [window, setWindow] = useState<ActivityWindow>('today');
  const [podId, setPodId] = useState('all');
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [recap, setRecap] = useState<ActivityRecap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [actingApprovalId, setActingApprovalId] = useState<string | null>(null);
  const [acknowledgingAttentionId, setAcknowledgingAttentionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionErrorItemId, setActionErrorItemId] = useState<string | null>(null);
  const [rulingId, setRulingId] = useState<string | null>(null);
  const [otherDecisionId, setOtherDecisionId] = useState<string | null>(null);
  const [otherDecisionValue, setOtherDecisionValue] = useState('');
  const [ruledDecisions, setRuledDecisions] = useState<Record<string, { value: string; by?: string }>>({});
  const [settledQueueDecisions, setSettledQueueDecisions] = useState<Record<string, NeedsYouItem>>({});
  const [queue, setQueue] = useState<NeedsYouItem[]>([]);
  const queueRef = useRef<NeedsYouItem[]>([]);
  const [queueCount, setQueueCount] = useState<number | null>(null);
  const [queueCountsByPod, setQueueCountsByPod] = useState<Record<string, number>>({});
  const [queueRemaining, setQueueRemaining] = useState(0);
  // True while another page is expected to load itself. The way-back control
  // renders only when pages remain and nothing is expected to fetch them —
  // a stall, which the auto-load effect makes unreachable in practice
  // (sprint-review 66408: deterministic under the fold, never Loading).
  const [queueAutoPending, setQueueAutoPending] = useState(false);
  // Day zero (ux-lead 66658/66666): Get started is its own card above Needs you and a step is
  // not an ask — no actor, no ring, no count, no badge; a step leaves when the account does
  // something. hire ← an agent exists; speak ← you said something in a pod that has a seat;
  // connect ← a connector row.
  const [connectorCount, setConnectorCount] = useState<number | null>(null);
  // "Hired" and "spoke" are facts about the account's seats, not about the last 24h
  // (sprint-review 66671: recap.agents only carries agents that acted inside the recap window).
  // The registry's per-pod agent list is what Your Team reads. Step 2 closes on the caller's own
  // act (#1648, ux-lead 67071): `callerSpoke` is the account's own message in that pod, reply or
  // not. A seat's `lastMessage` cannot carry it — an install intro sets it before anyone spoke —
  // and `lastActiveAt` is only proof of life (provisioning sets it, sprint-review 66678).
  const [seatPods, setSeatPods] = useState<Array<{ podId: string; callerSpoke: boolean; agents: Array<{ name: string; internal?: boolean }> }> | null>(null);
  const [queueLoadingMore, setQueueLoadingMore] = useState(false);
  const [queueMoreError, setQueueMoreError] = useState(false);
  const [historyRemaining, setHistoryRemaining] = useState(0);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyMoreError, setHistoryMoreError] = useState(false);
  const [queueFailed, setQueueFailed] = useState(false);
  const [queueHydrated, setQueueHydrated] = useState(false);
  const actionFocusGenerationRef = useRef(0);
  const queueScopeRef = useRef('all');
  const queueGenerationRef = useRef(0);
  const revalidationExtentRef = useRef(0);
  const revalidationScopeRef = useRef<string | null>(null);
  const queueMoreButtonRef = useRef<HTMLButtonElement | null>(null);
  const queueMoreFailureOffsetRef = useRef<number | null>(null);
  const historyMoreButtonRef = useRef<HTMLButtonElement | null>(null);
  const historyOffsetRef = useRef(0);
  const pendingRefreshFocusRef = useRef<string | null>(null);
  const [replyOpenIds, setReplyOpenIds] = useState<Set<string>>(new Set());
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [composePodId, setComposePodId] = useState('');
  const [composeDraft, setComposeDraft] = useState('');
  const [composeMenuOpen, setComposeMenuOpen] = useState(false);
  const composePickerRef = useRef<HTMLDivElement | null>(null);
  const composePickerButtonRef = useRef<HTMLButtonElement | null>(null);
  const composePickerOptionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const scopeMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [composing, setComposing] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [movedVisibleCounts, setMovedVisibleCounts] = useState<Record<string, number>>({});

  // A Back snapshot is account-scoped and is only read after AuthContext has
  // established the identity. This prevents one signed-in account from
  // hydrating another account's queue, recap, or reply drafts from a shared
  // browser session.
  useEffect(() => {
    if (authLoading || snapshotAccountRef.current === accountId) return;
    snapshotAccountRef.current = accountId;
    const snapshot = accountId ? readActivitySnapshot(accountId) : null;
    restoredSnapshotRef.current = snapshot;
    setRuledDecisions({});
    setSettledQueueDecisions({});
    setHistoryRemaining(0);
    setHistoryMoreError(false);
    setHistoryLoadingMore(false);
    historyOffsetRef.current = 0;
    if (snapshot) {
      setWindow(snapshot.window || 'today');
      setPodId(snapshot.podId || 'all');
      setRecap(snapshot.recap || null);
      queueScopeRef.current = snapshot.podId || 'all';
      queueRef.current = snapshot.queue || [];
      setQueue(queueRef.current);
      setQueueCount(snapshot.queueCount ?? null);
      setQueueCountsByPod(snapshot.queueCountsByPod || {});
      setQueueRemaining(snapshot.queueRemaining || 0);
      setReplyDrafts(snapshot.replyDrafts || {});
      setComposePodId(snapshot.composePodId || '');
      setComposeDraft(snapshot.composeDraft || '');
      setComposeMenuOpen(false);
      revalidationExtentRef.current = snapshot.queue?.length || 0;
      revalidationScopeRef.current = snapshot.podId || 'all';
      setLoading(!snapshot.recap);
    } else {
      setWindow('today');
      setPodId('all');
      setRecap(null);
      queueScopeRef.current = 'all';
      queueRef.current = [];
      setQueue(queueRef.current);
      setQueueCount(null);
      setQueueCountsByPod({});
      setQueueRemaining(0);
      setReplyDrafts({});
      setComposePodId('');
      setComposeDraft('');
      setComposeMenuOpen(false);
      revalidationExtentRef.current = 0;
      revalidationScopeRef.current = null;
      setLoading(true);
    }
    setQueueHydrated(false);
    setSnapshotReady(true);
  }, [accountId, authLoading]);

  useEffect(() => {
    const refresh = () => {
      const activeRow = document.activeElement?.closest<HTMLElement>('[data-activity-item-id]');
      pendingRefreshFocusRef.current = activeRow?.dataset.activityItemId || null;
      setReloadKey((value) => value + 1);
    };
    globalThis.window.addEventListener(ATTENTION_CHANGED, refresh);
    globalThis.window.addEventListener('focus', refresh);
    return () => {
      globalThis.window.removeEventListener(ATTENTION_CHANGED, refresh);
      globalThis.window.removeEventListener('focus', refresh);
    };
  }, []);

  useEffect(() => {
    if (!composeMenuOpen) return undefined;
    const closeOnOutsidePress = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (target instanceof Node && composePickerRef.current && !composePickerRef.current.contains(target)) {
        setComposeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', closeOnOutsidePress);
    document.addEventListener('touchstart', closeOnOutsidePress);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress);
      document.removeEventListener('touchstart', closeOnOutsidePress);
    };
  }, [composeMenuOpen]);

  useEffect(() => {
    const snapshot = restoredSnapshotRef.current;
    if (!snapshotReady || !snapshot || !queueHydrated) return;
    const restore = () => {
      if (snapshot.scrollY && snapshot.scrollY > 0) globalThis.window.scrollTo(0, snapshot.scrollY);
      if (snapshot.focusedItemId) {
        const row = document.querySelector<HTMLElement>(`[data-activity-item-id="${CSS.escape(snapshot.focusedItemId)}"]`);
        row?.focus();
      }
      if (accountId) sessionStorage.removeItem(snapshotKey(accountId));
      restoredSnapshotRef.current = null;
    };
    const frame = globalThis.window.requestAnimationFrame(restore);
    return () => globalThis.window.cancelAnimationFrame(frame);
  }, [accountId, queueHydrated, snapshotReady]);

  useEffect(() => {
    if (!snapshotReady) return undefined;
    let active = true;
    const generation = queueGenerationRef.current + 1;
    queueGenerationRef.current = generation;
    const previousScope = queueScopeRef.current;
    queueScopeRef.current = podId;
    const sameScope = previousScope === podId;
    const previousQueue = sameScope ? queueRef.current : [];
    const previousHistoryExtent = sameScope ? historyOffsetRef.current : 0;
    if (!sameScope) {
      // Retained rows are evidence for their own scope only. If the new
      // request fails, showing them under the newly selected pod is false.
      queueRef.current = [];
      setQueue([]);
      setQueueCount(null);
      setQueueRemaining(0);
      setHistoryRemaining(0);
      setHistoryMoreError(false);
      setHistoryLoadingMore(false);
      historyOffsetRef.current = 0;
      setQueueFailed(false);
      revalidationExtentRef.current = 0;
      revalidationScopeRef.current = null;
    }
    // Refreshes in the same scope must revalidate every loaded page before
    // replacing the visible queue. Otherwise a 56-row queue briefly regresses
    // to the first 50 rows while the refresh response is settling.
    if (sameScope && previousQueue.length > 0) {
      revalidationScopeRef.current = podId;
      revalidationExtentRef.current = Math.max(revalidationExtentRef.current, previousQueue.length);
    }
    queueMoreFailureOffsetRef.current = null;
    setQueueHydrated(false);
    setLoading((current) => (sameScope && recap ? current : true));
    setError(null);
    setQueueMoreError(false);
    setQueueLoadingMore(false);
    setHistoryLoadingMore(false);
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
      axios.get<DecisionHistoryResponse>('/api/activity/decision-history', {
        headers,
        params: { limit: 50, offset: 0, ...(podId !== 'all' ? { podId } : {}) },
      }).catch(() => null),
    ])
      .then(async ([recapResponse, queueResponse, historyResponse]) => {
        if (!active) return;
        setRecap(recapResponse.data);
        // Decision history is a durable pod projection. Hydrate it on every
        // Activity read so a settled card survives a hard reload and the
        // Activity → pod → Activity Back path, even when the open queue has
        // already dropped the recipient-owned row.
        const historyItems = Array.isArray(historyResponse?.data?.items)
          ? historyResponse.data.items
          : [];
        const settledHistory = historyItems.filter((item) => (
          item.kind === 'decision' && item.id && item.ruling?.value
        ));
        if (historyResponse) {
          const historyCount = typeof historyResponse.data?.count === 'number'
            ? historyResponse.data.count
            : historyItems.length;
          // A refresh revalidates the first page but must not collapse an
          // explicitly loaded history extent back to its first-page boundary.
          // Keep the prior extent as the cursor; older rows remain durable in
          // settledQueueDecisions and can be fetched only when the reader asks
          // for another page.
          const loadedExtent = Math.max(historyItems.length, previousHistoryExtent);
          historyOffsetRef.current = loadedExtent;
          if (sameScope && previousHistoryExtent > 0) {
            // A new ruling can arrive ahead of an already-loaded older page.
            // Count the union of durable cards we already rendered and this
            // refreshed first page; using only the previous offset would
            // report the new row as an unseen older row.
            const existingIds = new Set(Object.values(settledQueueDecisions)
              .filter((item) => podId === 'all' || item.podId === podId)
              .map((item) => String(item.id)));
            settledHistory.forEach((item) => existingIds.add(String(item.id)));
            setHistoryRemaining(Math.max(historyCount - existingIds.size, 0));
          } else {
            setHistoryRemaining(typeof historyResponse.data?.remaining === 'number'
              ? historyResponse.data.remaining
              : Math.max(historyCount - historyItems.length, 0));
          }
          setHistoryMoreError(false);
        }
        if (settledHistory.length > 0) {
          setRuledDecisions((current) => {
            const next = { ...current };
            settledHistory.forEach((item) => {
              next[String(item.id)] = {
                value: String(item.ruling?.value),
                ...(item.ruling?.by ? { by: item.ruling.by } : {}),
              };
            });
            return next;
          });
          setSettledQueueDecisions((current) => {
            const next = { ...current };
            settledHistory.forEach((item) => {
              next[String(item.id)] = {
                ...item,
                detail: item.detail || '',
                podName: item.podName || '',
                timestamp: item.timestamp ?? item.createdAt ?? null,
              };
            });
            return next;
          });
        }
        const rawItems = queueResponse?.data?.items;
        const availablePods = recapResponse.data.pods || [];
        const setComposeDefault = (candidate = '') => {
          const fallback = candidate || availablePods[0]?.id || '';
          setComposePodId((current) => (
            current && availablePods.some((pod) => pod.id === current) ? current : fallback
          ));
        };
        if (!Array.isArray(rawItems) || typeof queueResponse?.data?.count !== 'number'
          || (podId !== 'all' && !queueResponse?.data?.countsByPod)) {
          setQueueFailed(previousQueue.length === 0 && settledHistory.length === 0);
          setQueueMoreError(true);
          setComposeDefault();
          return;
        }
        setQueueFailed(false);
        setQueueCount(queueResponse!.data.count);
        setQueueCountsByPod(queueResponse!.data.countsByPod || {});
        const mapQueueItems = (items: QueueResponse['items']) => items.map((item) => ({
          ...item,
          detail: item.detail || '',
          podName: item.podName || '',
          timestamp: item.timestamp ?? item.createdAt ?? null,
        }));
        let queueItems = mapQueueItems(rawItems);
        // A Back snapshot can contain more than one server page. Revalidate
        // the loaded extent before replacing it, otherwise a 56-row snapshot
        // briefly regresses to the first 50 and loses its final six rows.
        const revalidateTo = revalidationScopeRef.current === podId ? revalidationExtentRef.current : 0;
        let nextOffset = queueItems.length;
        let nextRemaining = typeof queueResponse!.data.remaining === 'number'
          ? queueResponse!.data.remaining
          : Math.max(queueResponse!.data.count - nextOffset, 0);
        while (nextOffset < revalidateTo && nextRemaining > 0) {
          const nextResponse = await axios.get<QueueResponse>('/api/activity/decision-queue', {
            headers,
            params: { limit: 50, offset: nextOffset, ...(podId !== 'all' ? { podId } : {}) },
          });
          const nextPage = mapQueueItems(nextResponse.data?.items || []);
          if (!nextPage.length) break;
          const existing = new Set(queueItems.map((item) => `${item.kind}:${item.id}`));
          queueItems = [...queueItems, ...nextPage.filter((item) => !existing.has(`${item.kind}:${item.id}`))];
          nextOffset += nextPage.length;
          nextRemaining = typeof nextResponse.data?.remaining === 'number'
            ? nextResponse.data.remaining
            : Math.max((nextResponse.data?.count || 0) - nextOffset, 0);
        }
        revalidationExtentRef.current = 0;
        revalidationScopeRef.current = null;
        queueRef.current = queueItems;
        setQueue(queueItems);
        setQueueRemaining(Math.max(queueResponse!.data.count - queueItems.length, 0));
        setQueueAutoPending(Math.max(queueResponse!.data.count - queueItems.length, 0) > 0);
        // The initial destination is an account-level global fact computed by
        // the service before scope/page slicing. Preserve an intentional
        // target across refreshes and fall back to the first available pod.
        setComposeDefault(queueResponse?.data?.composePodId || '');
        const pendingFocus = pendingRefreshFocusRef.current;
        pendingRefreshFocusRef.current = null;
        if (pendingFocus) {
          globalThis.window.requestAnimationFrame(() => {
            document.querySelector<HTMLElement>(`[data-activity-item-id="${CSS.escape(pendingFocus)}"]`)?.focus();
          });
        }
      })
      .catch(() => {
        if (active) {
          if (recap || previousQueue.length > 0) {
            setQueueFailed(false);
            setQueueMoreError(true);
          } else {
            setError(t('activity.loadFailed'));
            setQueueFailed(true);
          }
        }
      })
      .finally(() => {
        if (active) {
          setQueueHydrated(true);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [accountId, podId, reloadKey, snapshotReady, t, window]);

  useEffect(() => {
    if (!snapshotReady) return undefined;
    let active = true;
    const token = localStorage.getItem('token');
    axios.get<Array<{ status?: string }>>('/api/integrations/user/all', { headers: { 'x-auth-token': token ?? '' } })
      .then((res) => { if (active) setConnectorCount(Array.isArray(res.data) ? res.data.filter((row) => row.status !== 'error').length : 0); })
      .catch(() => { if (active) setConnectorCount(0); });
    return () => { active = false; };
  }, [snapshotReady, reloadKey]);
  useEffect(() => {
    if (!recap || podId !== 'all') return undefined;
    let active = true;
    const token = localStorage.getItem('token');
    const headers = { 'x-auth-token': token ?? '' };
    Promise.all(recap.pods.slice(0, 20).map((pod) => axios
      .get<{ agents?: Array<{ name: string; internal?: boolean }>; callerSpoke?: boolean }>(`/api/registry/pods/${pod.id}/agents`, { headers })
      .then((res) => ({
        podId: pod.id,
        callerSpoke: res.data?.callerSpoke === true,
        agents: (Array.isArray(res.data?.agents) ? res.data.agents : []).filter((agent) => !agent.internal),
      }))
      .catch(() => ({ podId: pod.id, callerSpoke: false, agents: [] }))))
      .then((pods) => { if (active) setSeatPods(pods); });
    return () => { active = false; };
  }, [recap, podId]);
  // The pods that hold a seat the account can speak to; step 2 lands the person in the first one.
  const seatedPods = useMemo(() => (seatPods ?? []).filter((pod) => pod.agents.length > 0), [seatPods]);
  const startSteps = useMemo(() => {
    if (!recap || podId !== 'all' || seatPods === null) return [] as Array<'hire' | 'speak' | 'connect'>;
    const open: Array<'hire' | 'speak' | 'connect'> = [];
    if (seatedPods.length === 0) open.push('hire');
    if (!seatedPods.some((pod) => pod.callerSpoke)) open.push('speak');
    if (connectorCount !== null && connectorCount === 0) open.push('connect');
    return open;
  }, [recap, podId, seatPods, seatedPods, connectorCount]);
  const startStepTarget = (step: 'hire' | 'speak' | 'connect') => {
    if (step === 'hire') return '/v2/agents';
    if (step === 'speak') {
      const target = seatedPods[0]?.podId ?? recap?.pods[0]?.id;
      return target ? `/v2/pods/${target}` : '/v2';
    }
    return '/v2/connectors';
  };

  const loadMoreQueue = async (auto = false) => {
    if (queueMoreError && queueMoreFailureOffsetRef.current === null) {
      setReloadKey((value) => value + 1);
      return;
    }
    if (queueLoadingMore || queueRemaining <= 0 || queueFailed) return;
    const requestedScope = podId;
    const requestedGeneration = queueGenerationRef.current;
    const offset = queueMoreFailureOffsetRef.current ?? queue.length;
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
        const nextQueue = [...current, ...nextItems.filter((item) => !existing.has(`${item.kind}:${item.id}`))];
        queueRef.current = nextQueue;
        return nextQueue;
      });
      const loaded = offset + nextItems.length;
      queueMoreFailureOffsetRef.current = null;
      const nextRemaining = typeof response.data?.remaining === 'number'
        ? response.data.remaining
        : Math.max((response.data?.count || queueCount || 0) - loaded, 0);
      setQueueRemaining(nextRemaining);
      setQueueAutoPending(nextRemaining > 0);
      if (auto) return;
      globalThis.window.requestAnimationFrame(() => {
        if (queueMoreButtonRef.current) {
          queueMoreButtonRef.current.focus();
          return;
        }
        const firstAdded = nextItems[0]?.id;
        if (firstAdded) document.querySelector<HTMLElement>(`[data-activity-item-id="${CSS.escape(String(firstAdded))}"]`)?.focus();
      });
    } catch {
      if (queueScopeRef.current === requestedScope && queueGenerationRef.current === requestedGeneration) {
        queueMoreFailureOffsetRef.current = offset;
        setQueueMoreError(true);
        setQueueAutoPending(false);
      }
    } finally {
      if (queueGenerationRef.current === requestedGeneration) setQueueLoadingMore(false);
    }
  };

  // Needs you never folds (66311): every open ask renders, so the pages after
  // the first load themselves. A failed page stops here and offers Retry;
  // the count stays the ledger's while the rows catch up.
  // Not while a refresh is in flight: the retained rows still say "1 remaining"
  // until the new first page lands, and a page fetched in that window would
  // carry the new generation and append a row the refresh just discarded.
  useEffect(() => {
    if (!queueHydrated || queue.length === 0 || queueRemaining <= 0 || queueLoadingMore || queueMoreError || queueFailed) return;
    void loadMoreQueue(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueHydrated, queue.length, queueRemaining, queueLoadingMore, queueMoreError, queueFailed]);

  // Stall detector (sprint-review 66417): a next page is expected, nothing is
  // fetching it, and no error cleared the expectation. Normal paging starts
  // the fetch in the same commit and cancels this timer; if 1.5s pass with
  // pages remaining and nothing in flight, the expectation is wrong and the
  // way back renders.
  useEffect(() => {
    if (!queueAutoPending || queueLoadingMore || queueRemaining <= 0 || queueMoreError) return undefined;
    const timer = globalThis.window.setTimeout(() => setQueueAutoPending(false), 1500);
    return () => globalThis.window.clearTimeout(timer);
  }, [queueAutoPending, queueLoadingMore, queueRemaining, queueMoreError]);

  const loadMoreHistory = async () => {
    if (historyLoadingMore || historyRemaining <= 0) return;
    const requestedScope = podId;
    const requestedGeneration = queueGenerationRef.current;
    const offset = historyOffsetRef.current;
    const trigger = historyMoreButtonRef.current;
    const shouldRestoreFocus = () => {
      const active = document.activeElement;
      return active === document.body || active === trigger || active === historyMoreButtonRef.current;
    };
    setHistoryLoadingMore(true);
    setHistoryMoreError(false);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get<DecisionHistoryResponse>('/api/activity/decision-history', {
        headers: { 'x-auth-token': token ?? '' },
        params: { limit: 50, offset, ...(requestedScope !== 'all' ? { podId: requestedScope } : {}) },
      });
      if (queueScopeRef.current !== requestedScope || queueGenerationRef.current !== requestedGeneration) return;
      const items = Array.isArray(response.data?.items) ? response.data.items : [];
      const settled = items.filter((item) => item.kind === 'decision' && item.id && item.ruling?.value);
      const existingSettledIds = new Set(Object.keys(settledQueueDecisions));
      const existingQueueIds = new Set(queue.map((item) => `${item.kind}:${item.id}`));
      const firstAddedId = settled.find((item) => (
        !existingSettledIds.has(String(item.id)) && !existingQueueIds.has(`${item.kind}:${item.id}`)
      ))?.id;
      if (settled.length > 0) {
        setRuledDecisions((current) => {
          const next = { ...current };
          settled.forEach((item) => {
            next[String(item.id)] = {
              value: String(item.ruling?.value),
              ...(item.ruling?.by ? { by: item.ruling.by } : {}),
            };
          });
          return next;
        });
        setSettledQueueDecisions((current) => {
          const next = { ...current };
          settled.forEach((item) => {
            next[String(item.id)] = {
              ...item,
              detail: item.detail || '',
              podName: item.podName || '',
              timestamp: item.timestamp ?? item.createdAt ?? null,
            };
          });
          return next;
        });
      }
      historyOffsetRef.current = offset + items.length;
      const remaining = typeof response.data?.remaining === 'number'
        ? response.data.remaining
        : items.length > 0 && typeof response.data?.count === 'number'
          ? Math.max(response.data.count - historyOffsetRef.current, 0)
          : 0;
      setHistoryRemaining(remaining);
      setHistoryMoreError(false);
      globalThis.window.requestAnimationFrame(() => {
        if (!shouldRestoreFocus()) return;
        if (historyMoreButtonRef.current) {
          historyMoreButtonRef.current.focus();
          return;
        }
        if (firstAddedId) {
          document.querySelector<HTMLElement>(`[data-activity-item-id="${CSS.escape(String(firstAddedId))}"]`)?.focus();
        }
      });
    } catch {
      if (queueScopeRef.current === requestedScope && queueGenerationRef.current === requestedGeneration) {
        setHistoryMoreError(true);
        globalThis.window.requestAnimationFrame(() => {
          if (shouldRestoreFocus()) historyMoreButtonRef.current?.focus();
        });
      }
    } finally {
      if (queueGenerationRef.current === requestedGeneration) setHistoryLoadingMore(false);
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
  const composePodName = scopedPods.find((pod) => pod.id === composePodId)?.name || t('activity.allPods');
  const selectComposePod = (nextPodId: string) => {
    setComposePodId(nextPodId);
    setComposeMenuOpen(false);
    globalThis.window.requestAnimationFrame(() => composePickerButtonRef.current?.focus());
  };
  const focusComposePickerOption = (index: number) => {
    if (scopedPods.length === 0) return;
    const boundedIndex = (index + scopedPods.length) % scopedPods.length;
    const option = scopedPods[boundedIndex];
    if (!option) return;
    setComposeMenuOpen(true);
    globalThis.window.requestAnimationFrame(() => composePickerOptionRefs.current[option.id]?.focus());
  };
  // One seat has one mark everywhere (66390): an agent actor takes the chat's
  // cobalt mark, a human the tint mark. The kind glyph stays for asks with no actor.
  // Rows written before the actor id was stamped still carry the name, so the
  // name is the second door.
  const agentUserIds = useMemo(() => new Set((recap?.agents || []).map((agent) => String(agent.id))), [recap]);
  const agentNames = useMemo(() => new Set((recap?.agents || []).map((agent) => agent.name.trim().toLowerCase())), [recap]);
  // The id is the authority when it exists — a failed id lookup means "not an
  // agent", not "unknown" — so the name door opens only for rows with no id.
  const isAgentActor = (item: NeedsYouItem): boolean => (
    item.actorUserId
      ? agentUserIds.has(item.actorUserId)
      : (!!item.actorName && agentNames.has(item.actorName.trim().toLowerCase()))
  );
  // 0-state (66400 fix 5): "Nothing needs you." and, when the history knows it,
  // when the last ask was answered — the newest ruling in this scope.
  const lastAnsweredAt = useMemo(() => {
    const times = Object.values(settledQueueDecisions)
      .filter((item) => podId === 'all' || item.podId === podId)
      .map((item) => item.ruling?.at)
      .filter((at): at is string => typeof at === 'string' && at.length > 0)
      .map((at) => new Date(at).getTime())
      .filter((ms) => Number.isFinite(ms));
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  }, [podId, settledQueueDecisions]);
  const visibleQueue = useMemo(() => {
    const settled = Object.values(settledQueueDecisions)
      .filter((item) => podId === 'all' || item.podId === podId)
      .filter((item) => !queue.some((open) => open.id === item.id));
    // Ruling 66311: Needs you never folds and runs oldest waiting first —
    // the ask that has waited longest sits at the top. Settled cards follow.
    const open = [...queue].sort((a, b) => (
      new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime()
    ));
    return [...open, ...settled];
  }, [podId, queue, settledQueueDecisions]);

  const openPod = (targetPodId: string | null, messageId?: number | string) => {
    if (!targetPodId) return;
    try {
      const active = document.activeElement?.closest<HTMLElement>('[data-activity-item-id]');
      if (accountId) sessionStorage.setItem(snapshotKey(accountId), JSON.stringify({
        window,
        podId,
        recap,
        queue,
        queueCount,
        queueRemaining,
        queueCountsByPod,
        replyDrafts,
        composePodId,
        composeDraft,
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


  const captureActionFocus = (item: NeedsYouItem) => {
    const generation = ++actionFocusGenerationRef.current;
    const active = document.activeElement;
    const row = active?.closest<HTMLElement>('[data-activity-item-id]');
    const target = active instanceof HTMLElement && row?.dataset.activityItemId === item.id ? active : null;
    // Each request owns its target. A later action supersedes older recovery,
    // and an intentional focus move must survive an eventual failed request.
    return () => {
      if (!target) return;
      globalThis.window.requestAnimationFrame(() => {
        const current = document.activeElement;
        if (generation === actionFocusGenerationRef.current
          && document.contains(target)
          && (current === document.body || current === target)) {
          target.focus({ preventScroll: true });
        }
      });
    };
  };

  const actOnApproval = async (item: NeedsYouItem, action: 'approve' | 'reject') => {
    if (actingApprovalId) return;
    const restoreActionFocus = captureActionFocus(item);
    setActingApprovalId(item.id);
    setActionError(null);
    setActionErrorItemId(null);
    try {
      const token = localStorage.getItem('token');
      const headers = { 'x-auth-token': token ?? '' };
      if (item.sourceType === 'approval_action') {
        // A runtime action proposal: the approvals store decides it, and answers { ok }.
        const response = await axios.post<{ ok?: boolean }>(
          `/api/approvals/${encodeURIComponent(item.id)}/resolve`,
          { decision: action === 'approve' ? 'approved' : 'declined' },
          { headers },
        );
        if (!response.data?.ok) throw new Error('Approval action failed');
      } else {
        const response = await axios.post<{ success?: boolean }>(
          `/api/activity/${encodeURIComponent(item.id)}/${action}`,
          { notes: `${action === 'approve' ? 'Approved' : 'Rejected'} via Activity` },
          { headers },
        );
        if (!response.data?.success) throw new Error('Approval action failed');
      }
      notifyAttentionChanged();
      setReloadKey((value) => value + 1);
    } catch {
      setActionErrorItemId(item.id);
      setActionError(t('activity.approval.actionFailed'));
      restoreActionFocus();
    } finally {
      setActingApprovalId(null);
    }
  };

  const ruleDecision = async (item: NeedsYouItem, value: string) => {
    if (rulingId || !value.trim()) return;
    const restoreActionFocus = captureActionFocus(item);
    setRulingId(item.id);
    setActionError(null);
    setActionErrorItemId(null);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.post<{
        ok?: boolean;
        decision?: { ruling?: { value?: string; by?: string } | null };
      }>(
        `/api/activity/decisions/${encodeURIComponent(item.id)}/choose`,
        { value },
        { headers: { 'x-auth-token': token ?? '' } },
      );
      if (!response.data?.ok) throw new Error('Decision ruling failed');
      const settled = response.data.decision?.ruling;
      const ruling = { value: settled?.value || value.trim(), ...(settled?.by ? { by: settled.by } : {}) };
      setRuledDecisions((current) => ({
        ...current,
        [item.id]: ruling,
      }));
      setSettledQueueDecisions((current) => ({ ...current, [item.id]: item }));
      notifyAttentionChanged();
      setOtherDecisionId(null);
      setOtherDecisionValue('');
      setReloadKey((value) => value + 1);
    } catch (error) {
      const standing = axios.isAxiosError(error) ? error.response?.data?.decision?.ruling : null;
      if (standing?.value) {
        const ruling = { value: standing.value, ...(standing.by ? { by: standing.by } : {}) };
        setRuledDecisions((current) => ({
          ...current,
          [item.id]: ruling,
        }));
        setSettledQueueDecisions((current) => ({ ...current, [item.id]: item }));
      } else {
        setActionErrorItemId(item.id);
        setActionError(t('activity.decision.actionFailed'));
        restoreActionFocus();
      }
    } finally {
      setRulingId(null);
    }
  };

  const sendCompose = async () => {
    const content = composeDraft.trim();
    if (!content || !composePodId || composing) return;
    setComposing(true);
    setComposeError(null);
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        `/api/messages/${encodeURIComponent(composePodId)}`,
        { content },
        { headers: { 'x-auth-token': token ?? '' } },
      );
      setComposeDraft('');
      notifyAttentionChanged();
      setReloadKey((value) => value + 1);
    } catch {
      setComposeError(t('activity.compose.actionFailed'));
    } finally {
      setComposing(false);
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
    const restoreActionFocus = captureActionFocus(item);
    setReplyingId(item.id);
    setActionError(null);
    setActionErrorItemId(null);
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
      setActionErrorItemId(item.id);
      setActionError(t('activity.reply.actionFailed', { defaultValue: 'Your reply could not be sent. Try again.' }));
      restoreActionFocus();
    } finally {
      setReplyingId(null);
    }
  };

  const acknowledgeAttention = async (item: NeedsYouItem, errorKey: 'activity.mention.actionFailed' | 'activity.handoff.actionFailed') => {
    if (acknowledgingAttentionId) return;
    const restoreActionFocus = captureActionFocus(item);
    setAcknowledgingAttentionId(item.id);
    setActionError(null);
    setActionErrorItemId(null);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.post<{ success?: boolean }>(
        `/api/activity/${item.attentionItemId || item.id}/acknowledge`,
        {},
        { headers: { 'x-auth-token': token ?? '' } },
      );
      if (!response.data?.success) throw new Error('Activity handling failed');
      notifyAttentionChanged();
      setReloadKey((value) => value + 1);
    } catch {
      const message = t(errorKey, { defaultValue: 'That attention item could not be marked handled. Try again.' });
      setActionErrorItemId(item.id);
      setActionError(message);
      restoreActionFocus();
    } finally {
      setAcknowledgingAttentionId(null);
    }
  };

  const acknowledgeMention = (item: NeedsYouItem) => acknowledgeAttention(item, 'activity.mention.actionFailed');
  const markHandoffHandled = (item: NeedsYouItem) => acknowledgeAttention(item, 'activity.handoff.actionFailed');


  return (
    <div className="v2-activity" aria-busy={loading}>
      <header className="v2-activity__header">
        <div className="v2-activity__bar-title">
          <h1 className="v2-activity__title">{t('activity.title')}</h1>
          <span className="v2-activity__subtitle">{t('activity.subtitle')}</span>
        </div>
      </header>
      <div className="v2-activity__controls" aria-label={t('activity.controlsAriaLabel')}>
        <div className="v2-activity__window" role="group" aria-label={t('activity.windowAriaLabel')}>
          {(['today', '7d'] as ActivityWindow[]).map((value) => (
            <button key={value} type="button" className={`v2-activity__window-button${window === value ? ' v2-activity__window-button--active' : ''}`} onClick={() => setWindow(value)} aria-pressed={window === value}>
              {t(`activity.windows.${value}`)}
            </button>
          ))}
        </div>
        <div className="v2-activity__scope" role="group" aria-label={t('activity.podScopeLabel')} onKeyDown={(event) => {
          if (event.key === 'Escape' && scopeMenuOpen) {
            event.preventDefault();
            event.stopPropagation(); // This menu restores focus; the global Escape handler blurs it.
            setScopeMenuOpen(false);
            scopeMenuButtonRef.current?.focus();
          }
        }}>
          <button type="button" className={`v2-activity__scope-button${podId === 'all' ? ' v2-activity__scope-button--active' : ''}`} onClick={() => { setPodId('all'); setScopeMenuOpen(false); }} aria-pressed={podId === 'all'}>{t('activity.allPods')}</button>
          {scopedPods.slice(0, 2).map((pod) => (
            <button key={pod.id} type="button" className={`v2-activity__scope-button${podId === pod.id ? ' v2-activity__scope-button--active' : ''}`} onClick={() => { setPodId(pod.id); setScopeMenuOpen(false); }} aria-pressed={podId === pod.id}>{pod.name}</button>
          ))}
          {scopedPods.length > 2 && <button type="button" ref={scopeMenuButtonRef} className={`v2-activity__scope-button${scopedPods.slice(2).some((pod) => pod.id === podId) ? ' v2-activity__scope-button--active' : ''}`} onClick={() => setScopeMenuOpen((open) => !open)} aria-expanded={scopeMenuOpen}>{scopedPods.slice(2).find((pod) => pod.id === podId)?.name || t('activity.morePods')}</button>}
          {scopeMenuOpen && <div className="v2-activity__scope-menu">{scopedPods.slice(2).map((pod) => (
            <button key={pod.id} type="button" className={`v2-activity__scope-button v2-activity__scope-button--menu${podId === pod.id ? ' v2-activity__scope-button--active' : ''}`} onClick={() => { setPodId(pod.id); setScopeMenuOpen(false); scopeMenuButtonRef.current?.focus(); }} aria-pressed={podId === pod.id}>{pod.name}</button>
          ))}</div>}
        </div>
      </div>

      {loading && <div className="v2-activity__loading"><span className="v2-spinner" /></div>}
      {!loading && error && <div className="v2-activity__error" role="alert">
        <span>{error}</span>
        <button type="button" className="v2-activity__queue-more" onClick={() => { setError(null); setReloadKey((value) => value + 1); }}>{t('activity.needsYou.retry', { defaultValue: 'Retry' })}</button>
      </div>}
      {!loading && !error && recap && (
        <>
          {/* The composer stays hidden while step 1 is open — nobody to wake — and returns the moment an agent exists. */}
          {!startSteps.includes('hire') && (
          <section className="v2-activity__compose" aria-labelledby="activity-compose-title">
            <div className="v2-activity__compose-top">
              <h2 id="activity-compose-title" className="v2-activity__compose-label">{t('activity.compose.label')}</h2>
              <div className="v2-activity__compose-pod">
                <span>{t('activity.compose.podLabel')}</span>
                <div ref={composePickerRef} className="v2-activity__compose-picker">
                  <button
                    type="button"
                    ref={composePickerButtonRef}
                    className="v2-activity__compose-picker-button"
                    aria-haspopup="listbox"
                    aria-expanded={composeMenuOpen}
                    onClick={() => setComposeMenuOpen((open) => !open)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && composeMenuOpen) {
                        event.preventDefault();
                        event.stopPropagation();
                        setComposeMenuOpen(false);
                        return;
                      }
                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        focusComposePickerOption(0);
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        focusComposePickerOption(scopedPods.length - 1);
                      }
                    }}
                    disabled={composing || scopedPods.length === 0}
                  >
                    {composePodName}
                  </button>
                  {composeMenuOpen && <div className="v2-activity__compose-picker-menu" role="listbox" aria-label={t('activity.compose.podLabel')}>
                    {scopedPods.map((pod, index) => (
                      <button
                        key={pod.id}
                        type="button"
                        role="option"
                        ref={(element) => { composePickerOptionRefs.current[pod.id] = element; }}
                        aria-selected={pod.id === composePodId}
                        className={`v2-activity__compose-picker-option${pod.id === composePodId ? ' is-active' : ''}`}
                        onClick={() => selectComposePod(pod.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            focusComposePickerOption(index + 1);
                          } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            focusComposePickerOption(index - 1);
                          } else if (event.key === 'Home') {
                            event.preventDefault();
                            focusComposePickerOption(0);
                          } else if (event.key === 'End') {
                            event.preventDefault();
                            focusComposePickerOption(scopedPods.length - 1);
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            setComposeMenuOpen(false);
                            composePickerButtonRef.current?.focus();
                          } else if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            selectComposePod(pod.id);
                          }
                        }}
                      >
                        {pod.name}
                      </button>
                    ))}
                  </div>}
                </div>
              </div>
            </div>
            <textarea
              aria-label={t('activity.compose.placeholder')}
              rows={2}
              placeholder={t('activity.compose.placeholder')}
              value={composeDraft}
              onChange={(event) => setComposeDraft(event.target.value)}
              onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void sendCompose(); }}
              disabled={composing || !composePodId}
            />
            <div className="v2-activity__compose-foot">
              <span className="v2-activity__compose-hint">{t('activity.compose.hint')}</span>
              <button type="button" aria-label={t('activity.compose.sendAriaLabel')} onClick={() => { void sendCompose(); }} disabled={composing || !composePodId || !composeDraft.trim()}>
                {composing ? t('activity.compose.working') : t('activity.compose.send')}
              </button>
            </div>
            {composeError && <div className="v2-activity__action-error" role="alert">{composeError}</div>}
          </section>
          )}
          {queueCount === 0 && recap.hasEverHadAttention === false && startSteps.length > 0 && (
            <section className="v2-activity__start" aria-labelledby="activity-get-started">
              <div className="v2-activity__start-head">
                <h2 id="activity-get-started">{t('activity.getStarted.title')}</h2>
                <span className="v2-activity__start-kicker">{t('activity.getStarted.kicker', { count: startSteps.length })}</span>
              </div>
              {startSteps.map((step, index) => (
                <div key={step} className="v2-activity__start-row" data-step={step}>
                  <span className="v2-activity__start-num" aria-hidden="true">{({ hire: 1, speak: 2, connect: 3 })[step]}</span>
                  <div className="v2-activity__start-copy">
                    <strong>{t(`activity.getStarted.${step}.title`)}</strong>
                    <p>{t(`activity.getStarted.${step}.description`)}</p>
                  </div>
                  <div className="v2-activity__start-act">
                    <button type="button" className={index === 0 ? 'v2-activity__start-cta--current' : ''} onClick={() => navigate(startStepTarget(step))}>{t(`activity.getStarted.${step}.cta`)}</button>
                  </div>
                </div>
              ))}
            </section>
          )}
          <div className="v2-activity__sections">
          <section className="v2-activity__section" aria-labelledby="activity-needs-you">
            <div className="v2-activity__section-heading">
              <h2 id="activity-needs-you">{t('activity.needsYou.title')}</h2>
              {queueCount !== null && queueCount > 0 && <span className="v2-activity__count" aria-label={t('activity.needsYou.countLabel', { count: queueCount })}>{queueCount}</span>}
              {queueCount !== 0 && <p>{queueCount === null
                ? t('activity.needsYou.countUnavailable', { defaultValue: 'Count unavailable' })
                : t(podId === 'all' ? 'activity.needsYou.countDescription' : 'activity.needsYou.scopedCountDescription', { count: queueCount })}</p>}
            </div>
            {queueFailed ? <>
              <p role="status">{t('activity.loadFailed')}</p>
              <button type="button" className="v2-activity__queue-more" onClick={() => setReloadKey((value) => value + 1)}>{t('activity.needsYou.retry', { defaultValue: 'Retry' })}</button>
            </> : (
              <>
              {(queueCount === 0 || visibleQueue.length === 0) && (
                <div className="v2-activity__empty v2-activity__empty--plain">
                  <span>{queueCount === 0
                    ? t('activity.needsYou.emptyTitle')
                    : t('activity.needsYou.countLabel', { count: queueCount })}</span>
                  {queueCount === 0 && lastAnsweredAt && <span>{t('activity.needsYou.emptyLast', { age: relativeTime(lastAnsweredAt) })}</span>}
                </div>
              )}
              {visibleQueue.length > 0 && (
              <div className="v2-activity__queue">
                {visibleQueue.map((item) => (
                  <article key={item.id} data-activity-item-id={item.id} tabIndex={-1} className={`v2-activity__queue-row v2-activity__queue-row--${item.kind}${item.kind === 'decision' && ruledDecisions[item.id] ? ' v2-activity__queue-row--settled' : ''}`}>
                    <span className={`v2-activity__queue-mark${item.actorName ? (isAgentActor(item) ? ' v2-activity__queue-mark--agent' : ' v2-activity__queue-mark--human') : ''}`} aria-hidden="true">
                      {item.actorName ? actorMark(item.actorName) : item.kind === 'mention' ? '@' : item.kind === 'approval' ? '!' : item.kind === 'handoff' ? '↗' : '?'}
                    </span>
                    <div className="v2-activity__queue-copy">
                      <div className="v2-activity__queue-kind">{t(`activity.needsYou.kinds.${item.kind}`)} · {shortPodName(item.podName)}{item.timestamp ? ` · ${relativeTime(item.timestamp)}` : ''}</div>
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
                          {!replyOpenIds.has(item.id) ? <button type="button" className="v2-activity__queue-action--bordered" onClick={() => setReplyOpenIds((current) => new Set(current).add(item.id))}>{t('activity.reply.open')}</button> : <div className="v2-activity__reply" data-testid="queue-reply">
                            <textarea aria-label={t('activity.reply.placeholder')} className="v2-activity__reply-input" rows={2} placeholder={t('activity.reply.placeholder')} value={replyDrafts[item.id] || ''} onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendReply(item); }} disabled={replyingId === item.id} />
                            <button type="button" onClick={() => sendReply(item)} disabled={replyingId === item.id || !(replyDrafts[item.id] || '').trim()}>{replyingId === item.id ? t('activity.reply.working') : repliedIds.has(item.id) ? t('activity.reply.sent') : t('activity.reply.send')}</button>
                          </div>}
                          <button type="button" className="v2-activity__queue-action--thread v2-activity__queue-action--bordered" onClick={() => acknowledgeMention(item)} disabled={acknowledgingAttentionId === item.id}>
                            {acknowledgingAttentionId === item.id ? t('activity.mention.working') : t('activity.mention.markHandled')}
                          </button>
                        </>
                      )}
                      {item.kind === 'handoff' && (
                        <button type="button" onClick={() => markHandoffHandled(item)} disabled={acknowledgingAttentionId === item.id}>
                          {acknowledgingAttentionId === item.id ? t('activity.handoff.working', { defaultValue: 'Saving…' }) : t('activity.handoff.markHandled', { defaultValue: 'Mark handled' })}
                        </button>
                      )}
                      {item.kind === 'decision' && (item.options || []).length > 0 && (
                        <>
                          {ruledDecisions[item.id] ? (
                            <>
                              <span className="v2-activity__decision-ruled" role="status">
                                {t('activity.decision.ruled', ruledDecisions[item.id])}
                              </span>
                              <div className="v2-activity__decision-footer">
                                <button type="button" className="v2-activity__queue-action--thread v2-activity__queue-action--bordered" onClick={() => openPod(item.podId, item.messageId)} disabled={!item.podId}>
                                  {item.messageId === undefined || item.messageId === null || item.messageId === '' ? t('activity.openPod') : t('activity.open')}
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              {(item.options || []).map((option, index) => {
                                const optionId = `${item.id}-${index}`.replace(/[^a-zA-Z0-9_-]/g, '-');
                                const recommendedId = `${optionId}-recommended`;
                                const descriptionId = `${optionId}-description`;
                                const describedBy = option.description ? descriptionId : undefined;
                                return (
                                  <div className="v2-activity__option-choice" key={option.label}>
                                    <button
                                      type="button"
                                      className={`v2-activity__option${index === 0 ? ' v2-activity__option--primary' : ''}`}
                                      onClick={() => ruleDecision(item, option.label)}
                                      disabled={rulingId === item.id}
                                      aria-label={t(option.recommended
                                        ? 'activity.decision.ruleOptionRecommended'
                                        : 'activity.decision.ruleOption', { option: option.label })}
                                      aria-describedby={describedBy}
                                    >
                                      {rulingId === item.id ? t('activity.decision.working') : option.label}
                                    </button>
                                    {option.recommended && (
                                      <span id={recommendedId} className="v2-activity__option-recommended">{t('activity.decision.recommended')}</span>
                                    )}
                                    {option.description && (
                                      <span id={descriptionId} className="v2-activity__option-description">{option.description}</span>
                                    )}
                                  </div>
                                );
                              })}
                              <div className="v2-activity__decision-footer">
                                <button
                                  type="button"
                                  className="v2-activity__queue-action--secondary v2-activity__option v2-activity__option--other"
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
                                <button type="button" className="v2-activity__queue-action--thread v2-activity__queue-action--bordered" onClick={() => openPod(item.podId, item.messageId)} disabled={!item.podId}>
                                  {item.messageId === undefined || item.messageId === null || item.messageId === '' ? t('activity.openPod') : t('activity.open')}
                                </button>
                              </div>
                            </>
                          )}
                        </>
                      )}
                      {(item.kind !== 'decision' || (item.options || []).length === 0) && (
                        <button type="button" className="v2-activity__queue-action--thread v2-activity__queue-action--bordered" onClick={() => openPod(item.podId, item.messageId)} disabled={!item.podId}>
                          {item.messageId === undefined || item.messageId === null || item.messageId === '' ? t('activity.openPod') : t('activity.open')}
                        </button>
                      )}
                    </div>
                    {actionErrorItemId === item.id && actionError && (
                      <div className="v2-activity__row-action-error v2-activity__action-error" role="alert">{actionError}</div>
                    )}
                  </article>
                ))}
              </div>
              )}
              </>
            )}
            {/* 66311 keeps the fetch under the fold: normal paging shows nothing, not even
                Loading; Retry on error; and a stalled auto-load (pages remain, none expected)
                still surfaces the way back. */}
            {visibleQueue.length > 0 && (queueMoreError || (queueHydrated && queueRemaining > 0 && !queueLoadingMore && !queueAutoPending)) && (
              <button
                type="button"
                ref={queueMoreButtonRef}
                className="v2-activity__queue-more"
                onClick={() => loadMoreQueue()}
                disabled={queueLoadingMore}
              >
                {queueLoadingMore
                  ? t('activity.needsYou.loadingMore', { defaultValue: 'Loading…' })
                  : queueMoreError
                    ? t('activity.needsYou.retry', { defaultValue: 'Retry' })
                    : t('activity.needsYou.showMore', { count: queueRemaining, defaultValue: `Show more · ${queueRemaining} remaining` })}
              </button>
            )}
            {(historyRemaining > 0 || historyMoreError) && (
              <button
                type="button"
                ref={historyMoreButtonRef}
                className="v2-activity__queue-more"
                onClick={loadMoreHistory}
                disabled={historyLoadingMore}
              >
                {historyLoadingMore
                  ? t('activity.needsYou.loadingMore', { defaultValue: 'Loading…' })
                  : historyMoreError
                    ? t('activity.needsYou.retry', { defaultValue: 'Retry' })
                    : t('activity.needsYou.showMoreSettled', { count: historyRemaining, defaultValue: `Show more settled · ${historyRemaining} remaining` })}
              </button>
            )}
            {visibleQueue.length === 0 && queueMoreError && !queueFailed && (
              <button type="button" className="v2-activity__queue-more" onClick={() => setReloadKey((value) => value + 1)}>{t('activity.needsYou.retry', { defaultValue: 'Retry' })}</button>
            )}
          </section>

          <section className="v2-activity__section v2-activity__moved" aria-labelledby="activity-moved-forward">
            <div className="v2-activity__section-heading">
              <h2 id="activity-moved-forward">{t('activity.movedForward.title')}</h2>
              <p>{t('activity.movedForward.description')}</p>
            </div>
            {movedGroups.length === 0 ? <div className="v2-activity__empty v2-activity__empty--plain"><strong>{t('activity.movedForward.empty')}</strong></div> : <div className="v2-activity__moved-list">
              {movedGroups.map((group) => {
                const visibleCount = movedVisibleCounts[group.id] || 3;
                const visible = group.lines.slice(0, Math.min(visibleCount, group.lines.length));
                const hasMore = visible.length < group.lines.length;
                const initialMore = Math.max(Math.min(20, group.lines.length) - visible.length, 0);
                const omittedCount = Math.max(group.lines.length - visible.length, 0);
                return <article key={group.id} className="v2-activity__moved-group">
                  <div className="v2-activity__moved-head"><span>{shortPodName(group.name)}</span><span>{group.lines.length}</span></div>
                  <div className="v2-activity__moved-lines">
                    {visible.map((line) => <div key={line.id} className="v2-activity__moved-line"><strong>{line.author}</strong><span>{line.text}</span><time>{relativeTime(line.timestamp)}</time></div>)}
                  </div>
                  {visibleCount > 3 && <button type="button" className="v2-activity__moved-more" onClick={(event) => {
                    const article = event.currentTarget.closest('article');
                    setMovedVisibleCounts((current) => ({ ...current, [group.id]: 3 }));
                    globalThis.window.requestAnimationFrame(() => article?.querySelector('button')?.focus());
                  }}>{t('activity.movedForward.showLess')}</button>}
                  {hasMore && <button type="button" className="v2-activity__moved-more" onClick={(event) => {
                    const article = event.currentTarget.closest('article');
                    const nextCount = Math.min(visibleCount < 20 ? 20 : visibleCount + 20, group.lines.length);
                    setMovedVisibleCounts((current) => ({ ...current, [group.id]: nextCount }));
                    if (nextCount === group.lines.length) {
                      globalThis.window.requestAnimationFrame(() => article?.querySelector('button')?.focus());
                    }
                  }}>{t('activity.movedForward.more', { count: initialMore || Math.min(20, omittedCount), pod: shortPodName(group.name) })}</button>}
                  {visibleCount >= 20 && omittedCount > 0 && <span className="v2-activity__moved-cap-note">{t('activity.movedForward.omitted', { count: omittedCount, pod: group.name, defaultValue: `${omittedCount} more updates in ${group.name} not shown` })}</span>}
                </article>;
              })}
            </div>}
          </section>
          </div>
        </>
      )}
    </div>
  );
};

export default V2ActivityPage;
