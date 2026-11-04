import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ActGlyph, KindGlyph, ShellGlyph } from '../icons/glyphs';
import { AuthContext } from '../../context/AuthContext';
import { ATTENTION_CHANGED, notifyAttentionChanged } from '../hooks/useV2PodAttention';
import V2Segmented from './V2Segmented';
import { usePhone } from '../connectors/usePhone';
import { compactAge, compactNow } from '../utils/compactTime';
import './V2ActivityPage.css';

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
  kind: 'mention' | 'approval' | 'decision' | 'handoff' | 'blocked';
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
  if (minutes < 1) return compactNow();
  if (minutes < 60) return compactAge('minute', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return compactAge('hour', hours);
  return compactAge('day', Math.floor(hours / 24));
};

// Closes a popover on a mouse or touch press outside the element that holds it.
const useOutsidePress = (open: boolean, holder: React.RefObject<HTMLElement | null>, close: () => void) => {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return undefined;
    const onPress = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (target instanceof Node && holder.current && !holder.current.contains(target)) closeRef.current();
    };
    document.addEventListener('mousedown', onPress);
    document.addEventListener('touchstart', onPress);
    return () => {
      document.removeEventListener('mousedown', onPress);
      document.removeEventListener('touchstart', onPress);
    };
  }, [open, holder]);
};

interface PickerOption { id: string; label: string }

// The d215 `.sel`: one key that names the current choice and opens a listbox of
// the others. The pod scope and the composer's destination are both this key.
const ActivityPicker: React.FC<{
  value: string;
  options: PickerOption[];
  onSelect: (id: string) => void;
  listLabel: string;
  triggerLabel: string;
  buttonClassName: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  disabled?: boolean;
}> = ({ value, options, onSelect, listLabel, triggerLabel, buttonClassName, open, setOpen, disabled = false }) => {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  useOutsidePress(open, holderRef, () => setOpen(false));
  const focusOption = (index: number) => {
    if (options.length === 0) return;
    const option = options[(index + options.length) % options.length];
    if (!option) return;
    setOpen(true);
    globalThis.window.requestAnimationFrame(() => optionRefs.current[option.id]?.focus());
  };
  const choose = (id: string) => {
    onSelect(id);
    setOpen(false);
    globalThis.window.requestAnimationFrame(() => buttonRef.current?.focus());
  };
  return (
    <div ref={holderRef} className="v2-activity__picker">
      <button
        type="button"
        ref={buttonRef}
        className={`v2-activity__sel ${buttonClassName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation(); // This menu keeps focus; the global Escape handler blurs it.
            setOpen(false);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusOption(0);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusOption(options.length - 1);
          }
        }}
      >
        <span className="v2-activity__sel-label">{triggerLabel}</span>
        <ShellGlyph name="chevron" size={14} />
      </button>
      {open && (
        <div className="v2-activity__menu v2-activity__menu--list" role="listbox" aria-label={listLabel}>
          {options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              ref={(element) => { optionRefs.current[option.id] = element; }}
              aria-selected={option.id === value}
              className={`v2-activity__menu-item${option.id === value ? ' is-active' : ''}`}
              onClick={() => choose(option.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  focusOption(index + 1);
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  focusOption(index - 1);
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  focusOption(0);
                } else if (event.key === 'End') {
                  event.preventDefault();
                  focusOption(options.length - 1);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                  buttonRef.current?.focus();
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  choose(option.id);
                }
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

interface RowAct { key: string; label: string; glyph: React.ReactNode; onSelect: () => void; disabled?: boolean }

// The phone's ⋯ key (d215 activity 390): there is no hover, so the row's
// secondary acts live behind one 44px key, in the same order as the cluster.
const RowMenu: React.FC<{ acts: RowAct[]; label: string; open: boolean; setOpen: (open: boolean) => void }> = ({
  acts, label, open, setOpen,
}) => {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useOutsidePress(open, holderRef, () => setOpen(false));
  return (
    <div
      ref={holderRef}
      className="v2-activity__more"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={buttonRef}
        className="v2p-b v2p-b-g v2p-ib v2-activity__more-key"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ShellGlyph name="more" />
      </button>
      {open && (
        <div className="v2-activity__menu" role="menu" aria-label={label}>
          {acts.map((act) => (
            <button
              key={act.key}
              type="button"
              role="menuitem"
              className="v2-activity__menu-item"
              disabled={act.disabled}
              onClick={() => { setOpen(false); act.onSelect(); }}
            >
              {act.glyph}
              <span>{act.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const V2ActivityPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const auth = useContext(AuthContext);
  const currentUser = auth?.currentUser || null;
  const authLoading = auth?.loading || false;
  const accountId = currentUser?._id ? String(currentUser._id) : null;
  const emailTargetRef = useRef(new URLSearchParams(location.search).get('item'));
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
  const [expandedDetailIds, setExpandedDetailIds] = useState<Set<string>>(new Set());
  // A reader who collapsed a detail keeps focus on it; this stops the focus
  // preview from re-opening it until the button is blurred and focused again.
  const [dismissedDetailIds, setDismissedDetailIds] = useState<Set<string>>(new Set());
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [composePodId, setComposePodId] = useState('');
  const [composeDraft, setComposeDraft] = useState('');
  const [composeMenuOpen, setComposeMenuOpen] = useState(false);
  // The composer is one line until its text area takes focus (d215 activity), and stays open
  // while focus is inside it or it holds a draft, a send or an error.
  const [composeFocused, setComposeFocused] = useState(false);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  // At phone width the head holds only the title and count; the window and scope move into
  // the page as one row, and each row's secondary acts sit behind ⋯ (d215 activity 390).
  const phone = usePhone('(max-width: 760px)');
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
    const fromEmail = Boolean(emailTargetRef.current);
    // A saved Back snapshot can be scoped to a different pod. An email link
    // names a particular ask, so search across pods and let that ask win focus.
    restoredSnapshotRef.current = fromEmail ? null : snapshot;
    if (fromEmail && accountId) sessionStorage.removeItem(snapshotKey(accountId));
    setRuledDecisions({});
    setSettledQueueDecisions({});
    setHistoryRemaining(0);
    setHistoryMoreError(false);
    setHistoryLoadingMore(false);
    historyOffsetRef.current = 0;
    if (snapshot) {
      const startingScope = fromEmail ? 'all' : snapshot.podId || 'all';
      const startingQueue = fromEmail ? [] : snapshot.queue || [];
      setWindow(snapshot.window || 'today');
      setPodId(startingScope);
      setRecap(snapshot.recap || null);
      queueScopeRef.current = startingScope;
      queueRef.current = startingQueue;
      setQueue(queueRef.current);
      setQueueCount(fromEmail ? null : snapshot.queueCount ?? null);
      setQueueCountsByPod(fromEmail ? {} : snapshot.queueCountsByPod || {});
      setQueueRemaining(fromEmail ? 0 : snapshot.queueRemaining || 0);
      setReplyDrafts(snapshot.replyDrafts || {});
      setComposePodId(snapshot.composePodId || '');
      setComposeDraft(snapshot.composeDraft || '');
      setComposeMenuOpen(false);
      revalidationExtentRef.current = startingQueue.length;
      revalidationScopeRef.current = startingScope;
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
  // Step 2 names the pod it lands in (ux-lead 67327): the first pod holding a seat, else the
  // account's first pod — the one step 1 will seat an agent in.
  const speakPod = useMemo(() => {
    const target = seatedPods[0]?.podId ?? recap?.pods[0]?.id;
    return target ? { id: target, name: recap?.pods.find((pod) => pod.id === target)?.name ?? '' } : null;
  }, [seatedPods, recap]);
  // Get started never pops in (d215 s-activity, walk 11-02): on an account the card can show for,
  // its steps wait on the roster and the connector count. While either is in flight the card
  // holds its place as a placeholder the height of the two-step day-zero card, so in that case
  // Needs you does not move when they land. A one- or three-step result shifts it by one row,
  // and an empty result removes the card.
  // Eligibility is the card's own gate, so a failed or unknown history still shows nothing.
  const startEligible = queueCount === 0 && recap?.hasEverHadAttention === false && podId === 'all';
  const startPending = startEligible && (seatPods === null || connectorCount === null);
  const startStepTarget = (step: 'hire' | 'speak' | 'connect') => {
    if (step === 'hire') return '/v2/agents';
    if (step === 'speak') return speakPod ? `/v2/pods/${speakPod.id}` : '/v2';
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

  useEffect(() => {
    const target = emailTargetRef.current;
    if (!target || !queueHydrated || !queue.some((item) => item.attentionItemId === target)) return;
    emailTargetRef.current = null;
    globalThis.window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-attention-id="${CSS.escape(target)}"]`);
      row?.scrollIntoView({ block: 'center' });
      row?.focus({ preventScroll: true });
    });
  }, [queue, queueHydrated]);

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
  const podOptions = useMemo(() => scopedPods.map((pod) => ({ id: pod.id, label: pod.name })), [scopedPods]);
  const scopeOptions = useMemo(() => [{ id: 'all', label: t('activity.allPods') }, ...podOptions], [podOptions, t]);
  const scopeName = scopeOptions.find((option) => option.id === podId)?.label || t('activity.allPods');
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

  // Reply-in-place (2026-09-01: "a way to really work with these agents
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


  const openLabel = (item: NeedsYouItem) => (
    item.messageId === undefined || item.messageId === null || item.messageId === '' ? t('activity.openPod') : t('activity.open')
  );
  const openAct = (item: NeedsYouItem): RowAct => ({
    key: 'open', label: openLabel(item), glyph: <ActGlyph name="open" />, onSelect: () => openPod(item.podId, item.messageId), disabled: !item.podId,
  });
  const iconKey = (act: RowAct) => (
    <button key={act.key} type="button" className="v2p-b v2p-b-g v2p-ib v2p-b-sm v2-activity__icon-key" aria-label={act.label} title={act.label} onClick={act.onSelect} disabled={act.disabled}>
      {act.glyph}
    </button>
  );
  // A row's secondary acts: the hover cluster at desktop, the ⋯ menu on a phone (d215 activity).
  const secondaryActs = (item: NeedsYouItem): RowAct[] => {
    if (item.kind === 'approval') {
      return [{
        key: 'deny', label: t('activity.approval.deny'), glyph: <ActGlyph name="deny" />, onSelect: () => { void actOnApproval(item, 'reject'); }, disabled: actingApprovalId === item.id,
      }, openAct(item)];
    }
    if (item.kind === 'mention') {
      return [{
        key: 'handled',
        label: acknowledgingAttentionId === item.id ? t('activity.mention.working') : t('activity.mention.markHandled'),
        glyph: <ActGlyph name="handled" />,
        onSelect: () => { void acknowledgeMention(item); },
        disabled: acknowledgingAttentionId === item.id,
      }, openAct(item)];
    }
    if (item.kind === 'handoff' || item.kind === 'blocked') return [openAct(item)];
    return [];
  };
  const primaryKey = (item: NeedsYouItem): React.ReactNode => {
    if (item.kind === 'approval') {
      return (
        <button type="button" className="v2p-b v2p-b-s v2p-b-sm v2-activity__key" onClick={() => actOnApproval(item, 'approve')} disabled={actingApprovalId === item.id}>
          {actingApprovalId === item.id ? t('activity.approval.working') : t('activity.approval.approve')}
        </button>
      );
    }
    if (item.kind === 'mention') {
      if (replyOpenIds.has(item.id)) return null;
      return (
        <button type="button" className="v2p-b v2p-b-s v2p-b-sm v2-activity__key" onClick={() => setReplyOpenIds((current) => new Set(current).add(item.id))}>
          {t('activity.reply.open')}
        </button>
      );
    }
    if (item.kind === 'handoff' || item.kind === 'blocked') {
      return (
        <button type="button" className="v2p-b v2p-b-s v2p-b-sm v2-activity__key" onClick={() => markHandoffHandled(item)} disabled={acknowledgingAttentionId === item.id}>
          {acknowledgingAttentionId === item.id ? t('activity.handoff.working', { defaultValue: 'Saving…' }) : t('activity.handoff.markHandled', { defaultValue: 'Mark handled' })}
        </button>
      );
    }
    // A decision's only act beside its row is Open; its choices are keys inside the row.
    return iconKey(openAct(item));
  };
  const rowDomId = (item: NeedsYouItem) => `activity-row-${item.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const movedCount = movedGroups.reduce((sum, group) => sum + group.lines.length, 0);
  const startGlyph = { hire: 'agents', speak: 'chat', connect: 'plug' } as const;

  const controls = (
    <div className="v2-activity__controls" role="group" aria-label={t('activity.controlsAriaLabel')}>
      <V2Segmented<ActivityWindow>
        className="v2-activity__window"
        ariaLabel={t('activity.windowAriaLabel')}
        value={window}
        onChange={setWindow}
        options={(['today', '7d'] as ActivityWindow[]).map((value) => ({ value, label: t(`activity.windows.${value}`) }))}
      />
      <ActivityPicker
        value={podId}
        options={scopeOptions}
        onSelect={setPodId}
        listLabel={t('activity.podScopeLabel')}
        triggerLabel={scopeName}
        buttonClassName="v2-activity__scope-button"
        open={scopeMenuOpen}
        setOpen={setScopeMenuOpen}
      />
    </div>
  );
  const composeOpen = composeFocused || composeDraft.length > 0 || composing || Boolean(composeError);

  return (
    <div className="v2-activity" aria-busy={loading}>
      <header className="v2p-ph v2-activity__head">
        <h1 className="v2-activity__title">{t('activity.title')}</h1>
        {queueCount !== null && <span className="meta v2-activity__meta">{`${t('activity.head.needsYou', { count: queueCount })} · ${t('activity.head.moved', { count: movedCount })}`}</span>}
        {!phone && <><span className="sp" />{controls}</>}
      </header>
      <div className="v2-activity__body">
        <div className="v2-activity__col">
          {phone && controls}
          {loading && <div className="v2-activity__loading"><span className="v2-spinner" /></div>}
          {!loading && error && <div className="v2-activity__error" role="alert">
            <span>{error}</span>
            <button type="button" className="v2p-b v2p-b-s v2p-b-sm v2-activity__queue-more" onClick={() => { setError(null); setReloadKey((value) => value + 1); }}>{t('activity.needsYou.retry', { defaultValue: 'Retry' })}</button>
          </div>}
          {!loading && !error && recap && (
            <>
              {/* The composer stays hidden while step 1 is open — nobody to wake — and returns the moment an agent exists. */}
              {!startSteps.includes('hire') && (
                <section
                  className={`v2-activity__compose${composeOpen ? ' v2-activity__compose--open' : ''}`}
                  aria-label={t('activity.compose.placeholder')}
                  onBlur={(event) => {
                    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setComposeFocused(false);
                  }}
                >
                  <span className="v2-activity__compose-icon" aria-hidden="true"><ShellGlyph name="pencil" size={15} /></span>
                  <textarea
                    aria-label={t('activity.compose.placeholder')}
                    rows={composeOpen ? 2 : 1}
                    placeholder={t('activity.compose.placeholder')}
                    value={composeDraft}
                    onFocus={() => setComposeFocused(true)}
                    onChange={(event) => setComposeDraft(event.target.value)}
                    onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void sendCompose(); }}
                    disabled={composing || !composePodId}
                  />
                  <div className="v2-activity__compose-foot">
                    <span className="v2-activity__compose-post">{t('activity.compose.podLabel')}</span>
                    <ActivityPicker
                      value={composePodId}
                      options={podOptions}
                      onSelect={setComposePodId}
                      listLabel={t('activity.compose.podLabel')}
                      triggerLabel={composePodName}
                      buttonClassName="v2-activity__compose-picker-button"
                      open={composeMenuOpen}
                      setOpen={setComposeMenuOpen}
                      disabled={composing || scopedPods.length === 0}
                    />
                    <span className="v2-activity__compose-sp" />
                    <kbd className="v2-activity__kbd" aria-hidden="true">{t('activity.compose.hint')}</kbd>
                    <button type="button" className="v2p-b v2p-b-p v2p-b-sm v2-activity__send" aria-label={t('activity.compose.sendAriaLabel')} onClick={() => { void sendCompose(); }} disabled={composing || !composePodId || !composeDraft.trim()}>
                      {composing ? t('activity.compose.working') : t('activity.compose.send')}
                    </button>
                  </div>
                  {composeError && <div className="v2-activity__action-error" role="alert">{composeError}</div>}
                </section>
              )}
              {startPending && (
                <section className="v2-activity__section v2-activity__start v2-activity__start--pending" aria-busy="true" aria-labelledby="activity-get-started" data-testid="activity-start-pending">
                  <div className="v2-activity__gtitle">
                    <ShellGlyph name="play" size={13} />
                    <h2 id="activity-get-started">{t('activity.getStarted.title')}</h2>
                    <span className="v2-activity__gtitle-r">{t('activity.getStarted.checking')}</span>
                  </div>
                  <div className="v2-activity__list">
                    {/* The same rows as the loaded steps, with bars where the words land. */}
                    {['first', 'second'].map((row) => (
                      <div key={row} className="v2-activity__queue-row v2-activity__start-row" aria-hidden="true">
                        <span className="v2-activity__queue-mark" />
                        <div className="v2-activity__queue-copy">
                          <i className="v2-activity__start-bar v2-activity__start-bar--title" />
                          <i className="v2-activity__start-bar" />
                        </div>
                        <div className="v2-activity__acts"><i className="v2-activity__start-bar v2-activity__start-bar--key" /></div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {!startPending && startEligible && startSteps.length > 0 && (
                <section className="v2-activity__section v2-activity__start" aria-labelledby="activity-get-started">
                  <div className="v2-activity__gtitle">
                    <ShellGlyph name="play" size={13} />
                    <h2 id="activity-get-started">{t('activity.getStarted.title')}</h2>
                    <span className="v2-activity__gtitle-r">{t('activity.getStarted.kicker', { count: startSteps.length })}</span>
                  </div>
                  <div className="v2-activity__list">
                    {startSteps.map((step, index) => (
                      <div key={step} className="v2-activity__queue-row v2-activity__start-row" data-step={step}>
                        <span className="v2-activity__queue-mark" aria-hidden="true"><ShellGlyph name={startGlyph[step]} /></span>
                        <div className="v2-activity__queue-copy">
                          <strong className="v2-activity__queue-name">{t(`activity.getStarted.${step}.title`)}</strong>
                          <p className="v2-activity__queue-snip">{t(`activity.getStarted.${step}.description`)}</p>
                        </div>
                        <div className="v2-activity__acts">
                          {/* Every step is a raised key, as the d215 day-zero frames draw it; the class still names the current one. */}
                          <button type="button" className={`v2p-b v2p-b-s v2p-b-sm ${index === 0 ? 'v2-activity__start-cta--current' : 'v2-activity__start-cta--next'}`} onClick={() => navigate(startStepTarget(step))}>{t(`activity.getStarted.${step}.cta`, { pod: speakPod?.name || t('activity.getStarted.speak.anyPod') })}</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <section className="v2-activity__section" aria-labelledby="activity-needs-you">
                <div className="v2-activity__gtitle">
                  <ShellGlyph name="inbox" size={13} />
                  <h2 id="activity-needs-you">{t('activity.needsYou.title')}</h2>
                  <span className="v2-activity__gtitle-r">
                    {queueCount !== null && queueCount > 0 && <span className="v2-activity__count" aria-label={t('activity.needsYou.countLabel', { count: queueCount })}>{queueCount}</span>}
                    {queueCount !== null && queueCount > 0 && !phone && <span className="v2-activity__order">{` · ${t('activity.needsYou.order')}`}</span>}
                    {queueCount === null && <span>{t('activity.needsYou.countUnavailable', { defaultValue: 'Count unavailable' })}</span>}
                  </span>
                </div>
                {queueFailed ? (
                  <div className="v2-activity__list">
                    <div className="v2-activity__empty" role="status">
                      <span>{t('activity.loadFailed')}</span>
                      <button type="button" className="v2p-b v2p-b-s v2p-b-sm v2-activity__queue-more" onClick={() => setReloadKey((value) => value + 1)}>{t('activity.needsYou.retry', { defaultValue: 'Retry' })}</button>
                    </div>
                  </div>
                ) : (
                  <div className="v2-activity__list v2-activity__queue">
                    {(queueCount === 0 || visibleQueue.length === 0) && (
                      <div className="v2-activity__empty">
                        <span>{queueCount === 0
                          ? t('activity.needsYou.emptyTitle')
                          : t('activity.needsYou.countLabel', { count: queueCount })}</span>
                        {/* Under a minute the age reads "now", and "answered now ago" is not a
                            sentence in either language, so that case has its own line. */}
                        {queueCount === 0 && lastAnsweredAt && <span>{Date.now() - new Date(lastAnsweredAt).getTime() < 60_000
                          ? t('activity.needsYou.emptyLastNow')
                          : t('activity.needsYou.emptyLast', { age: relativeTime(lastAnsweredAt) })}</span>}
                      </div>
                    )}
                    {visibleQueue.map((item) => {
                      const ruled = item.kind === 'decision' ? ruledDecisions[item.id] : undefined;
                      const choosing = item.kind === 'decision' && (item.options || []).length > 0 && !ruled;
                      const secondary = secondaryActs(item);
                      const titleId = `${rowDomId(item)}-title`;
                      return (
                        <article key={item.id} data-activity-item-id={item.id} data-attention-id={item.attentionItemId} tabIndex={-1} className={`v2-activity__queue-row v2-activity__queue-row--${item.kind}${choosing ? ' v2-activity__queue-row--open' : ''}${ruled ? ' v2-activity__queue-row--settled' : ''}`}>
                          {/* The kind is a mark; its word stays for assistive tech. */}
                          <span className="v2-activity__queue-mark" role="img" aria-label={t(`activity.needsYou.kinds.${item.kind}`)} title={t(`activity.needsYou.kinds.${item.kind}`)}>
                            <KindGlyph kind={item.kind} />
                          </span>
                          <div className="v2-activity__queue-copy">
                            <div className="v2-activity__queue-line">
                              <strong id={titleId} className="v2-activity__queue-name">{item.kind === 'mention' && item.actorName ? item.actorName : item.title}</strong>
                              <span className="v2-activity__queue-meta">{shortPodName(item.podName)}{item.timestamp ? ` · ${relativeTime(item.timestamp)}` : ''}</span>
                            </div>
                            {item.detail && (
                              <button
                                type="button"
                                className={`v2-activity__queue-detail${expandedDetailIds.has(item.id) ? ' v2-activity__queue-detail--expanded' : ''}${dismissedDetailIds.has(item.id) ? ' v2-activity__queue-detail--dismissed' : ''}`}
                                aria-expanded={expandedDetailIds.has(item.id)}
                                onClick={() => {
                                  const collapsing = expandedDetailIds.has(item.id);
                                  setExpandedDetailIds((current) => {
                                    const next = new Set(current);
                                    if (next.has(item.id)) next.delete(item.id);
                                    else next.add(item.id);
                                    return next;
                                  });
                                  setDismissedDetailIds((current) => {
                                    const next = new Set(current);
                                    if (collapsing) next.add(item.id);
                                    else next.delete(item.id);
                                    return next;
                                  });
                                }}
                                onBlur={() => setDismissedDetailIds((current) => {
                                  if (!current.has(item.id)) return current;
                                  const next = new Set(current);
                                  next.delete(item.id);
                                  return next;
                                })}
                              >
                                {item.detail}
                              </button>
                            )}
                            {ruled && (
                              <span className="v2-activity__decision-ruled" role="status">
                                {t('activity.decision.ruled', ruled)}
                              </span>
                            )}
                            {choosing && (
                              <>
                                {/* The decision is the only open row: its choices are keys inside it, in authored order. */}
                                <div className="v2-activity__keys" role="group" aria-labelledby={titleId}>
                                  {(item.options || []).map((option, index) => {
                                    const descriptionId = `${rowDomId(item)}-${index}-description`;
                                    return (
                                      <button
                                        key={option.label}
                                        type="button"
                                        className="v2p-b v2p-b-s v2p-b-sm v2-activity__option"
                                        onClick={() => ruleDecision(item, option.label)}
                                        disabled={rulingId === item.id}
                                        aria-label={t(option.recommended
                                          ? 'activity.decision.ruleOptionRecommended'
                                          : 'activity.decision.ruleOption', { option: option.label })}
                                        aria-describedby={option.description ? descriptionId : undefined}
                                      >
                                        {rulingId === item.id ? t('activity.decision.working') : option.label}
                                        {option.recommended && rulingId !== item.id && <span className="v2-activity__option-recommended">{t('activity.decision.recommended')}</span>}
                                      </button>
                                    );
                                  })}
                                  <button
                                    type="button"
                                    className="v2p-b v2p-b-g v2p-b-sm v2-activity__option v2-activity__option--other"
                                    onClick={() => setOtherDecisionId((current) => current === item.id ? null : item.id)}
                                    disabled={rulingId === item.id}
                                    aria-expanded={otherDecisionId === item.id}
                                  >
                                    {t('activity.decision.other')}
                                  </button>
                                </div>
                                {(item.options || []).some((option) => option.description) && (
                                  <ul className="v2-activity__option-notes">
                                    {(item.options || []).map((option, index) => option.description && (
                                      <li key={option.label}>
                                        <b>{option.label}</b>
                                        {' '}
                                        <span id={`${rowDomId(item)}-${index}-description`} className="v2-activity__option-description">{option.description}</span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                                {otherDecisionId === item.id && (
                                  <div className="v2-activity__editor v2-activity__decision-other" data-testid="decision-other">
                                    <textarea
                                      aria-label={t('activity.decision.otherPlaceholder')}
                                      rows={2}
                                      value={otherDecisionValue}
                                      onChange={(event) => setOtherDecisionValue(event.target.value)}
                                      disabled={rulingId === item.id}
                                    />
                                    <button
                                      type="button"
                                      className="v2p-b v2p-b-p v2p-b-sm"
                                      onClick={() => ruleDecision(item, otherDecisionValue)}
                                      disabled={rulingId === item.id || !otherDecisionValue.trim()}
                                    >
                                      {rulingId === item.id ? t('activity.decision.working') : t('activity.decision.sendOther')}
                                    </button>
                                  </div>
                                )}
                              </>
                            )}
                            {item.kind === 'mention' && replyOpenIds.has(item.id) && (
                              <div className="v2-activity__editor v2-activity__reply" data-testid="queue-reply">
                                <textarea aria-label={t('activity.reply.placeholder')} className="v2-activity__reply-input" rows={2} placeholder={t('activity.reply.placeholder')} value={replyDrafts[item.id] || ''} onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendReply(item); }} disabled={replyingId === item.id} />
                                <button type="button" className="v2p-b v2p-b-p v2p-b-sm" onClick={() => sendReply(item)} disabled={replyingId === item.id || !(replyDrafts[item.id] || '').trim()}>{replyingId === item.id ? t('activity.reply.working') : repliedIds.has(item.id) ? t('activity.reply.sent') : t('activity.reply.send')}</button>
                              </div>
                            )}
                            {actionErrorItemId === item.id && actionError && (
                              <div className="v2-activity__row-action-error v2-activity__action-error" role="alert">{actionError}</div>
                            )}
                          </div>
                          <div className="v2-activity__acts">
                            {primaryKey(item)}
                            {secondary.length > 0 && (phone
                              ? <RowMenu acts={secondary} label={t('activity.moreActions')} open={rowMenuId === item.id} setOpen={(open) => setRowMenuId(open ? item.id : null)} />
                              : <span className="v2-activity__hv">{secondary.map(iconKey)}</span>)}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
                {/* 66311 keeps the fetch under the fold: normal paging shows nothing, not even
                    Loading; Retry on error; and a stalled auto-load (pages remain, none expected)
                    still surfaces the way back. */}
                {visibleQueue.length > 0 && (queueMoreError || (queueHydrated && queueRemaining > 0 && !queueLoadingMore && !queueAutoPending)) && (
                  <div className="v2-activity__foot">
                    <button
                      type="button"
                      ref={queueMoreButtonRef}
                      className="v2p-b v2p-b-s v2p-b-sm v2-activity__queue-more"
                      onClick={() => loadMoreQueue()}
                      disabled={queueLoadingMore}
                    >
                      {queueLoadingMore
                        ? t('activity.needsYou.loadingMore', { defaultValue: 'Loading…' })
                        : queueMoreError
                          ? t('activity.needsYou.retry', { defaultValue: 'Retry' })
                          : t('activity.needsYou.showMore', { count: queueRemaining, defaultValue: `Show more · ${queueRemaining} remaining` })}
                    </button>
                  </div>
                )}
                {(historyRemaining > 0 || historyMoreError) && (
                  <div className="v2-activity__foot">
                    <button
                      type="button"
                      ref={historyMoreButtonRef}
                      className="v2p-b v2p-b-s v2p-b-sm v2-activity__queue-more"
                      onClick={loadMoreHistory}
                      disabled={historyLoadingMore}
                    >
                      {historyLoadingMore
                        ? t('activity.needsYou.loadingMore', { defaultValue: 'Loading…' })
                        : historyMoreError
                          ? t('activity.needsYou.retry', { defaultValue: 'Retry' })
                          : t('activity.needsYou.showMoreSettled', { count: historyRemaining, defaultValue: `Show more settled · ${historyRemaining} remaining` })}
                    </button>
                  </div>
                )}
                {visibleQueue.length === 0 && queueMoreError && !queueFailed && (
                  <div className="v2-activity__foot">
                    <button type="button" className="v2p-b v2p-b-s v2p-b-sm v2-activity__queue-more" onClick={() => setReloadKey((value) => value + 1)}>{t('activity.needsYou.retry', { defaultValue: 'Retry' })}</button>
                  </div>
                )}
              </section>

              <section className="v2-activity__section v2-activity__moved" aria-labelledby="activity-moved-forward">
                <div className="v2-activity__gtitle">
                  <ShellGlyph name="send" size={13} />
                  <h2 id="activity-moved-forward">{t('activity.movedForward.title')}</h2>
                  {movedCount > 0 && <span className="v2-activity__gtitle-r">{movedCount}{phone ? '' : ` · ${t('activity.movedForward.order')}`}</span>}
                </div>
                <div className="v2-activity__list v2-activity__moved-list">
                  {movedGroups.length === 0 ? <div className="v2-activity__empty">{t(window === '7d' ? 'activity.movedForward.emptyWeek' : 'activity.movedForward.empty')}</div> : movedGroups.map((group) => {
                    const visibleCount = movedVisibleCounts[group.id] || 3;
                    const visible = group.lines.slice(0, Math.min(visibleCount, group.lines.length));
                    const hasMore = visible.length < group.lines.length;
                    const initialMore = Math.max(Math.min(20, group.lines.length) - visible.length, 0);
                    const omittedCount = Math.max(group.lines.length - visible.length, 0);
                    // One list, a mono sub-row per pod, then Journal's time column (d215 activity).
                    return <article key={group.id} className="v2-activity__moved-group">
                      <div className="v2-activity__moved-head"><span>{shortPodName(group.name)}</span><span>{group.lines.length}</span></div>
                      {visible.map((line) => (
                        <div key={line.id} className="v2-activity__moved-line">
                          <time>{relativeTime(line.timestamp)}</time>
                          <span className="v2-activity__moved-text"><strong>{line.author}</strong>{' '}<span>{line.text}</span></span>
                        </div>
                      ))}
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
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default V2ActivityPage;
