// V2-native task board — /v2/pods/:podId/board.
//
// Until now "View run board" dropped users out of the v2 shell into the v1
// Pod Tools ChatRoom (MUI chrome, integrations sidebar, different nav) — the
// only v2 surface whose primary action exited v2. This page keeps the board
// inside the shell: four canonical columns (alias statuses render in their
// canonical column, mirroring the #921 sets), click-to-move actions instead
// of drag (works on phones, verifiable in CI), a create dialog, a detail
// dialog with the updates timeline, and live refresh via the same
// `task_updated` socket event the inspector consumes.
//
// Status moves PATCH `/api/v1/tasks/:podId/:taskId` with optimistic
// update + revert — the same call the v1 board makes, so both boards stay
// behaviorally interchangeable while v1 winds down.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SearchIcon from '@mui/icons-material/Search';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import BlockIcon from '@mui/icons-material/Block';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ReplayIcon from '@mui/icons-material/Replay';
import { useV2Api } from '../hooks/useV2Api';
import { useSocket } from '../../context/SocketContext';
import V2Avatar from './V2Avatar';
import { useAuth } from '../../context/AuthContext';
import { taskRecordPath } from './V2TaskRecord';
import { EXIT_SAFETY_MS, prefersReducedMotion, runViewTransition, useExitPresence, viewTransitionName } from '../utils/motion';
import './V2PodBoard.css';

type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';
const PRIORITIES: TaskPriority[] = ['P0', 'P1', 'P2', 'P3'];

type CanonicalStatus = 'pending' | 'claimed' | 'blocked' | 'done';
type BoardFilter = 'mine' | 'p0' | 'unclaimed';
const FILTERS: Array<{ key: BoardFilter; labelKey: string }> = [
  { key: 'mine', labelKey: 'board.filter.mine' },
  { key: 'p0', labelKey: 'board.filter.p0' },
  { key: 'unclaimed', labelKey: 'board.filter.unclaimed' },
];
const PHONE_MEDIA_QUERY = '(max-width: 760px)';
const DONE_STATUSES = ['done', 'completed', 'complete'];

interface BoardTask {
  taskId: string;
  title: string;
  priority?: TaskPriority;
  taskNum?: number;
  watchers?: string[];
  status: string;
  assignee?: string | null;
  claimedBy?: string | null;
  claimExpiresAt?: string | null;
  notes?: string | null;
  prUrl?: string | null;
  dep?: string | null;
  updatedAt?: string;
  updates?: Array<{ text: string; author: string; authorId?: string | null; createdAt?: string }>;
}

interface PodMember {
  _id?: string;
  username?: string;
  displayName?: string;
  isBot?: boolean;
  profilePicture?: string;
}

interface FocusTask {
  taskId: string;
  available: boolean;
  title: string | null;
  status: string | null;
  assignee: string | null;
  updatedAt: string | null;
}

interface FocusRead {
  podId: string;
  revision: number;
  focus: null | {
    goal: string;
    scope: string;
    owner: { userId: string; label: string | null; available: boolean };
    nextTasks: FocusTask[];
    updatedAt: string;
    updatedBy: { userId: string; label: string | null };
  };
  permissions?: { canEdit: boolean };
}

const memberId = (member: PodMember): string => member._id || '';
const memberLabel = (member: PodMember): string => member.displayName || member.username || memberId(member);

interface ColumnMeta {
  key: CanonicalStatus;
  labelKey: string;
  emptyKey: string;
  // Alias statuses written before the PATCH vocabulary gate (#921) render in
  // their canonical column instead of disappearing.
  statuses: string[];
  // Click-to-move targets offered on cards in this column.
  moves: Array<{ to: CanonicalStatus; labelKey: string; Icon: typeof PlayArrowIcon }>;
}

// The drawer shows this many newest updates, as the d215 frame draws; older ones fold.
const VISIBLE_UPDATES = 2;
const COLUMNS: ColumnMeta[] = [
  {
    key: 'pending',
    labelKey: 'board.col.pending',
    emptyKey: 'board.emptyCol.pending',
    statuses: ['pending', 'todo', 'open'],
    moves: [
      { to: 'claimed', labelKey: 'board.move.start', Icon: PlayArrowIcon },
      { to: 'blocked', labelKey: 'board.move.block', Icon: BlockIcon },
    ],
  },
  {
    key: 'claimed',
    labelKey: 'board.col.inProgress',
    emptyKey: 'board.emptyCol.inProgress',
    statuses: ['claimed', 'in_progress', 'in-progress'],
    moves: [
      { to: 'done', labelKey: 'board.move.finish', Icon: CheckIcon },
      { to: 'blocked', labelKey: 'board.move.block', Icon: BlockIcon },
    ],
  },
  {
    key: 'blocked',
    labelKey: 'board.col.blocked',
    emptyKey: 'board.emptyCol.blocked',
    statuses: ['blocked'],
    moves: [
      { to: 'claimed', labelKey: 'board.move.resume', Icon: PlayArrowIcon },
      { to: 'pending', labelKey: 'board.move.reopen', Icon: ReplayIcon },
    ],
  },
  {
    key: 'done',
    labelKey: 'board.col.done',
    emptyKey: 'board.emptyCol.done',
    statuses: ['done', 'completed', 'complete'],
    moves: [
      { to: 'pending', labelKey: 'board.move.reopen', Icon: ReplayIcon },
    ],
  },
];

const columnOf = (status: string): CanonicalStatus | null => COLUMNS.find((col) => col.statuses.includes(status))?.key || null;
const COLUMN_ORDER = COLUMNS.map((col) => col.key);

// While a live column change glides, <html> carries this class: it names the cards
// in the columns involved for the view transition, sets the glide's pace, and
// holds the lease pulse until the card has landed.
const GLIDE_CLASS = 'v2-board-glide';
let glidesRunning = 0;

interface LeavingCard {
  task: BoardTask;
  from: CanonicalStatus;
  to: CanonicalStatus;
  index: number;
}

const V2PodBoard: React.FC = () => {
  const { podId } = useParams<{ podId: string }>();
  const { t } = useTranslation();
  const api = useV2Api();
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { socket, connected, joinPod, leavePod } = useSocket();
  const connectionRef = useRef({ podId: null as string | null, wasConnected: false, hasConnected: false });

  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [taskWriteAllowed, setTaskWriteAllowed] = useState(false);
  const [recordReadAllowed, setRecordReadAllowed] = useState(false);
  const reloadTasksRef = useRef<() => void>(() => undefined);
  const taskLoadPendingRef = useRef(false);
  const [claimClock, setClaimClock] = useState(() => Date.now());
  const [podName, setPodName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<BoardTask | null>(null);
  const [updatesExpanded, setUpdatesExpanded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newPriority, setNewPriority] = useState<TaskPriority>('P2');
  const [detailSaving, setDetailSaving] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const taskRequestRef = useRef(0);
  const taskMutationRef = useRef(0);
  const detailDialogRef = useRef<HTMLDivElement | null>(null);
  const tasksRef = useRef<BoardTask[]>(tasks);
  tasksRef.current = tasks;
  const isPhoneRef = useRef(false);
  const mobileTabRef = useRef<CanonicalStatus>('pending');
  const columnTasksRef = useRef<Map<CanonicalStatus, BoardTask[]>>(new Map());
  const [leavingCards, setLeavingCards] = useState<LeavingCard[]>([]);
  const [countTick, setCountTick] = useState<{ col: CanonicalStatus | null; n: number }>({ col: null, n: 0 });
  const detailReturnRef = useRef<HTMLElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [podMembers, setPodMembers] = useState<PodMember[]>([]);

  // Re-render at the next lease boundary even if no socket event arrives.
  // A lapsed claim must stop looking held while the board stays open.
  useEffect(() => {
    const nextExpiry = tasks.reduce((soonest, task) => {
      if (!['claimed', 'in_progress', 'in-progress'].includes(task.status) || !task.claimedBy || !task.claimExpiresAt) return soonest;
      const expiry = Date.parse(task.claimExpiresAt);
      return Number.isFinite(expiry) && expiry > claimClock ? Math.min(soonest, expiry) : soonest;
    }, Infinity);
    if (!Number.isFinite(nextExpiry)) return undefined;
    const timer = window.setTimeout(() => setClaimClock(Date.now()), Math.min(Math.max(0, nextExpiry - Date.now()), 60_000));
    return () => window.clearTimeout(timer);
  }, [tasks, claimClock]);

  const openTask = useCallback((task: BoardTask | null) => {
    if (task && document.activeElement instanceof HTMLElement) detailReturnRef.current = document.activeElement;
    taskMutationRef.current += 1;
    setDetailSaving(false);
    setDetailError(null);
    setUpdatesExpanded(false);
    setSelected(task);
  }, []);

  useEffect(() => {
    const dialog = detailDialogRef.current;
    if (!selected || !dialog) return undefined;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), a[href], input:not(:disabled)'));
    controls()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); openTask(null); }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0];
      const last = items[items.length - 1];
      if (!dialog.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); detailReturnRef.current?.focus(); };
  }, [selected?.taskId, openTask]);

  const updateDetail = useCallback(async (task: BoardTask, change: { priority: TaskPriority } | { following: boolean }) => {
    if (!podId || detailSaving) return;
    const requestId = ++taskMutationRef.current;
    setDetailSaving(true);
    setDetailError(null);
    try {
      const path = `/api/v1/tasks/${podId}/${encodeURIComponent(task.taskId)}`;
      const result = 'following' in change
        ? await api.post<{ task: BoardTask }>(`${path}/watch`, change)
        : await api.patch<{ task: BoardTask }>(path, change);
      if (requestId !== taskMutationRef.current) return;
      if ('following' in change) {
        // The response is a snapshot from before another follower's write.
        // A new read owns the complete set; never replace it with that snapshot.
        reloadTasksRef.current();
        return;
      }
      taskRequestRef.current += 1;
      if (taskLoadPendingRef.current) reloadTasksRef.current();
      const merge = (existing: BoardTask): BoardTask => {
        if (existing.taskId !== task.taskId) return existing;
        return Date.parse(existing.updatedAt || '') > Date.parse(result.task.updatedAt || '') ? existing : result.task;
      };
      setTasks((rows) => rows.map(merge));
      setSelected((previous) => previous ? merge(previous) : null);
    } catch {
      if (requestId === taskMutationRef.current) setDetailError(t('board.detail.saveError'));
    } finally {
      if (requestId === taskMutationRef.current) setDetailSaving(false);
    }
  }, [api, podId, detailSaving, t]);

  const claimHolderName = useCallback((task: BoardTask): string => {
    const member = podMembers.find((item) => memberId(item) === task.claimedBy || item.username === task.claimedBy);
    if (member) return memberLabel(member);
    // The claim route records the claimant's User id and resolved author on
    // the update. Match identity rather than the wording of the update text.
    const holderUpdate = task.updates?.slice().reverse().find((update) => update.authorId === task.claimedBy);
    return holderUpdate?.author || (/^[0-9a-f]{24}$/i.test(task.claimedBy || '') ? t('board.detail.memberUnavailable') : task.claimedBy) || '';
  }, [podMembers, t]);
  const leaseFor = (task: BoardTask) => {
    const claimed = ['claimed', 'in_progress', 'in-progress'].includes(task.status) && Boolean(task.claimedBy);
    const expiry = Date.parse(task.claimExpiresAt || '');
    const knownExpiry = Number.isFinite(expiry);
    return { claimed, expiry, knownExpiry, expired: claimed && knownExpiry && expiry <= claimClock,
      minutes: knownExpiry ? Math.max(0, Math.ceil((expiry - claimClock) / 60_000)) : null };
  };
  const timeLabel = (expiry: number) => new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(expiry));
  // The frame's card line is the lease timer and the claimant's avatar, nothing else:
  // an assigned-but-unclaimed task shows no owner text.
  const ownerLine = (task: BoardTask) => {
    if (['done', 'completed', 'complete'].includes(task.status)) return null;
    // The frame marks a blocked card with what it waits on, and an open one with a hollow ring.
    if (task.status === 'blocked') {
      if (!task.dep) return null;
      const needs = t('board.card.needs', { dep: task.dep });
      return <span className="v2-board__blocked-mark" role="img" aria-label={needs} title={needs}><BlockIcon aria-hidden="true" /></span>;
    }
    const lease = leaseFor(task);
    if (!lease.claimed) {
      return <span className="v2-board__unclaimed" role="img" aria-label={t('board.detail.notClaimed')} title={t('board.detail.notClaimed')} />;
    }
    const holder = claimHolderName(task);
    const member = podMembers.find((item) => memberId(item) === task.claimedBy || item.username === task.claimedBy);
    const state = lease.expired ? 'expired' : 'live';
    return (
      <span className="v2-board__owner-line">
        <span aria-hidden="true" className={`v2-board__owner-dot v2-board__owner-dot--${state}`} />
        <span className="v2-board__owner-time">
          {lease.expired ? t('board.owner.expiredShort') : lease.knownExpiry ? t('board.owner.leaseShort', { minutes: lease.minutes }) : t('board.owner.claimedShort')}
        </span>
        <V2Avatar name={holder} src={member?.profilePicture} kind={member?.isBot === undefined ? undefined : member.isBot ? 'agent' : 'human'} seed={member ? memberId(member) : holder} size="sm" className="v2-board__card-avatar" />
      </span>
    );
  };
  const memberAvatar = (member: PodMember, name: string) => (
    <V2Avatar name={name} src={member.profilePicture} kind={member.isBot === undefined ? undefined : member.isBot ? 'agent' : 'human'} seed={memberId(member)} size="sm" className="v2-board__member-avatar" />
  );
  // The drawer keeps the last task on screen while it slides out.
  const drawer = useExitPresence(selected);
  const drawerTask = drawer.shown;
  const drawerExitRef = drawer.ref;
  const setDetailDialog = useCallback((node: HTMLDivElement | null) => {
    detailDialogRef.current = node;
    drawerExitRef(node);
  }, [drawerExitRef]);
  const watchers = drawerTask ? [...(drawerTask.watchers || [])].sort((a, b) => (
    Number(b === currentUser?._id) - Number(a === currentUser?._id)
  )) : [];
  const following = Boolean(currentUser?._id && watchers.includes(currentUser._id));
  const [focusRead, setFocusRead] = useState<FocusRead | null>(null);
  const [focusLoading, setFocusLoading] = useState(true);
  const [focusError, setFocusError] = useState(false);
  const [focusEditorOpen, setFocusEditorOpen] = useState(false);
  const [focusGoal, setFocusGoal] = useState('');
  const [focusScope, setFocusScope] = useState('');
  const [focusOwner, setFocusOwner] = useState('');
  const [focusTaskIds, setFocusTaskIds] = useState<string[]>([]);
  const [focusMoveAnnouncement, setFocusMoveAnnouncement] = useState('');
  const [focusSaving, setFocusSaving] = useState(false);
  const [focusSaveError, setFocusSaveError] = useState<string | null>(null);
  const [focusConflictLatest, setFocusConflictLatest] = useState<FocusRead | null>(null);
  const [focusConflictReviewed, setFocusConflictReviewed] = useState(false);
  const [focusBaseRevision, setFocusBaseRevision] = useState<number | null>(null);
  const focusDialogRef = useRef<HTMLDivElement | null>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const focusTaskRowRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const focusMoveTargetRef = useRef<string | null>(null);
  const closeFocusEditorRef = useRef<() => void>(() => undefined);
  const focusRequestRef = useRef(0);
  const focusMutationRef = useRef(0);

  const openCreateTask = useCallback(() => {
    setCreateError(null);
    setCreateOpen(true);
  }, []);

  // Activity's empty-workspace onboarding hands its final step to the real
  // board dialog. Consuming the intent here keeps task creation in its one
  // existing surface instead of teaching the recap page to write Task rows.
  useEffect(() => {
    if (searchParams.get('createTask') !== '1') return;
    openCreateTask();
    const next = new URLSearchParams(searchParams);
    next.delete('createTask');
    setSearchParams(next, { replace: true });
  }, [openCreateTask, searchParams, setSearchParams]);

  // `live` marks a read caused by someone else's change arriving over the socket.
  // Only those animate a card changing column: the first load, a reconnect
  // catch-up and a refetch the user started all land at once.
  const load = useCallback(async (options: { live?: boolean } = {}) => {
    if (!podId) return;
    const requestId = ++taskRequestRef.current;
    taskLoadPendingRef.current = true;
    try {
      const data = await api.get<{ tasks: BoardTask[]; permissions?: { canWrite: boolean; canReadRecord?: boolean } }>(`/api/v1/tasks/${podId}`);
      if (requestId !== taskRequestRef.current) return;
      const next = data.tasks || [];
      const apply = () => {
        setTasks(next);
        setTaskWriteAllowed(data.permissions?.canWrite === true);
        setRecordReadAllowed(data.permissions?.canReadRecord === true);
        setSelected((previous) => previous ? next.find((task) => task.taskId === previous.taskId) || null : null);
        setClaimClock(Date.now());
        setLoadError(false);
      };
      const before = new Map(tasksRef.current.map((task) => [task.taskId, columnOf(task.status)]));
      const moved = options.live ? next.flatMap((task) => {
        const from = before.get(task.taskId);
        const to = columnOf(task.status);
        return from && to && from !== to ? [{ task, from, to }] : [];
      }) : [];
      if (!moved.length) {
        apply();
      } else if (isPhoneRef.current) {
        // One column per tab: a card can't glide to a tab that isn't showing. It
        // fades out of the open tab toward the one it went to, that tab's count
        // ticks, and the open tab stays where the user left it.
        const open = mobileTabRef.current;
        const leaving = prefersReducedMotion() ? [] : moved.flatMap(({ task, from, to }) => {
          const index = (columnTasksRef.current.get(from) || []).findIndex((item) => item.taskId === task.taskId);
          return from === open && index >= 0 ? [{ task: (columnTasksRef.current.get(from) || [])[index], from, to, index }] : [];
        });
        apply();
        if (leaving.length) setLeavingCards((current) => [...current.filter((item) => !leaving.some((l) => l.task.taskId === item.task.taskId)), ...leaving]);
        setCountTick((current) => ({ col: moved[moved.length - 1].to, n: current.n + 1 }));
      } else {
        // The cards in the columns involved carry a view-transition-name, so the
        // browser glides the moved card and the others close the gap in one go.
        const columns = Array.from(new Set(moved.flatMap(({ from, to }) => [from, to])));
        const sections = columns.flatMap((key) => Array.from(document.querySelectorAll<HTMLElement>(`.v2-board__col--${key}`)));
        const root = document.documentElement;
        sections.forEach((section) => { section.dataset.glide = ''; });
        root.classList.add(GLIDE_CLASS);
        glidesRunning += 1;
        const settle = () => {
          sections.forEach((section) => { delete section.dataset.glide; });
          glidesRunning = Math.max(0, glidesRunning - 1);
          if (!glidesRunning) root.classList.remove(GLIDE_CLASS);
        };
        const transition = runViewTransition(() => { flushSync(apply); });
        if (!transition?.finished) settle();
        else transition.finished.catch(() => undefined).then(settle);
      }
    } catch {
      if (requestId === taskRequestRef.current) setLoadError(true);
    } finally {
      if (requestId === taskRequestRef.current) { taskLoadPendingRef.current = false; setLoading(false); }
    }
  }, [api, podId]);

  useLayoutEffect(() => { reloadTasksRef.current = load; }, [load]);

  const loadFocus = useCallback(async () => {
    if (!podId) return;
    const requestId = ++focusRequestRef.current;
    setFocusError(false);
    setFocusLoading(true);
    try {
      const data = await api.get<FocusRead>(`/api/pods/${podId}/focus`);
      if (requestId !== focusRequestRef.current) return;
      if (data?.podId && data.podId !== podId) return;
      setFocusRead((previous) => previous && data.revision < previous.revision ? previous : data);
      setFocusError(false);
    } catch {
      if (requestId !== focusRequestRef.current) return;
      setFocusError(true);
    } finally {
      if (requestId === focusRequestRef.current) setFocusLoading(false);
    }
  }, [api, podId]);

  useEffect(() => {
    setLoading(true);
    setSelected(null);
    setDetailError(null);
    setDetailSaving(false);
    load();
    return () => { taskRequestRef.current += 1; taskMutationRef.current += 1; };
  }, [load]);

  useEffect(() => {
    const state = connectionRef.current;
    if (state.podId !== podId) {
      connectionRef.current = { podId: podId || null, wasConnected: connected, hasConnected: connected };
      return;
    }
    const reconnected = connected && !state.wasConnected && state.hasConnected;
    state.wasConnected = connected;
    if (connected) state.hasConnected = true;
    if (reconnected && podId) load();
  }, [podId, connected, load]);

  useEffect(() => {
    focusRequestRef.current += 1;
    focusMutationRef.current += 1;
    setFocusRead(null);
    setFocusError(false);
    setFocusLoading(true);
    setFocusEditorOpen(false);
    setFocusConflictLatest(null);
    setFocusConflictReviewed(false);
    setFocusBaseRevision(null);
    setFocusSaveError(null);
    setFocusSaving(false);
  }, [podId]);

  useEffect(() => {
    loadFocus();
  }, [loadFocus]);

  useEffect(() => {
    if (!focusConflictLatest || !focusRead || focusRead.revision <= focusConflictLatest.revision) return;
    setFocusConflictLatest(focusRead);
    setFocusConflictReviewed(false);
  }, [focusRead, focusConflictLatest]);

  // Pod name for the header — membership-gated read; a failure only costs
  // the label.
  useEffect(() => {
    if (!podId) return;
    let cancelled = false;
    (async () => {
      try {
        const pod = await api.get<{ name?: string; members?: PodMember[] }>(`/api/pods/${podId}`);
        if (!cancelled && pod?.name) setPodName(pod.name);
        if (!cancelled && Array.isArray(pod?.members)) setPodMembers(pod.members);
      } catch {
        // Header falls back to the generic title.
      }
    })();
    return () => { cancelled = true; };
  }, [api, podId]);

  useEffect(() => {
    if (!podId || !socket || !connected) return undefined;
    joinPod(podId);
    return () => { leavePod(podId); };
  }, [podId, socket, connected, joinPod, leavePod]);

  useEffect(() => {
    if (!podId || !socket || !connected) return undefined;
    const onFocusUpdated = (payload: { podId?: string } | null) => {
      if (!payload || (payload.podId && payload.podId !== podId)) return;
      loadFocus();
    };
    socket.on('pod_focus_updated', onFocusUpdated);
    return () => { socket.off('pod_focus_updated', onFocusUpdated); };
  }, [podId, socket, connected, loadFocus]);

  useEffect(() => {
    if (!socket) return undefined;
    const onConnect = () => { loadFocus(); };
    socket.on('connect', onConnect);
    return () => { socket.off('connect', onConnect); };
  }, [socket, loadFocus]);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') loadFocus(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [loadFocus]);

  const openFocusEditor = useCallback(() => {
    focusReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = focusRead?.focus;
    setFocusGoal(current?.goal || '');
    setFocusScope(current?.scope || '');
    setFocusOwner(current?.owner.userId || memberId(podMembers[0] || {}));
    setFocusTaskIds(current?.nextTasks.map((task) => task.taskId) || []);
    setFocusMoveAnnouncement('');
    setFocusSaveError(null);
    setFocusConflictLatest(null);
    setFocusConflictReviewed(false);
    setFocusBaseRevision(focusRead?.revision ?? 0);
    setFocusEditorOpen(true);
  }, [focusRead, podMembers]);

  const closeFocusEditor = useCallback(() => {
    if (focusSaving) return;
    const current = focusRead?.focus;
    const initialOwner = current?.owner.userId || memberId(podMembers[0] || {});
    const initialTasks = current?.nextTasks.map((task) => task.taskId) || [];
    const dirty = focusGoal.trim() !== (current?.goal || '')
      || focusScope.trim() !== (current?.scope || '')
      || focusOwner !== initialOwner
      || focusTaskIds.join('\u0000') !== initialTasks.join('\u0000');
    if (!dirty || window.confirm(t('board.focus.discard'))) setFocusEditorOpen(false);
  }, [focusSaving, focusRead, podMembers, focusGoal, focusScope, focusOwner, focusTaskIds, t]);

  closeFocusEditorRef.current = closeFocusEditor;

  useEffect(() => {
    if (!focusEditorOpen || !focusDialogRef.current) return undefined;
    const dialog = focusDialogRef.current;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
    ));
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeFocusEditorRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      focusReturnRef.current?.focus();
      focusReturnRef.current = null;
    };
  }, [focusEditorOpen]);

  const saveFocus = useCallback(async (clear = false) => {
    if (!podId || focusSaving) return;
    const requestId = ++focusMutationRef.current;
    const requestPodId = podId;
    setFocusSaving(true);
    setFocusSaveError(null);
    const nextFocus = clear ? null : {
      goal: focusGoal.trim(),
      scope: focusScope.trim(),
      ownerUserId: focusOwner,
      nextTaskIds: focusTaskIds,
    };
    try {
      const result = await api.patch<FocusRead>(`/api/pods/${podId}/focus`, {
        expectedRevision: focusBaseRevision ?? 0,
        focus: nextFocus,
      });
      if (requestId !== focusMutationRef.current || requestPodId !== podId) return;
      setFocusRead(result);
      setFocusConflictLatest(null);
      setFocusConflictReviewed(false);
      setFocusBaseRevision(null);
      setFocusEditorOpen(false);
    } catch (error: any) {
      if (requestId !== focusMutationRef.current || requestPodId !== podId) return;
      if (error?.response?.status === 409) {
        if (error.response.data?.current) setFocusRead(error.response.data.current);
        if (error.response.data?.current) setFocusConflictLatest(error.response.data.current);
        setFocusConflictReviewed(false);
        setFocusSaveError(t('board.focus.conflict'));
      } else {
        setFocusSaveError(t('board.focus.saveError'));
      }
    } finally {
      if (requestId === focusMutationRef.current && requestPodId === podId) setFocusSaving(false);
    }
  }, [api, podId, focusSaving, focusGoal, focusScope, focusOwner, focusTaskIds, focusBaseRevision, t]);

  const toggleFocusTask = (taskId: string) => {
    setFocusTaskIds((current) => current.includes(taskId)
      ? current.filter((id) => id !== taskId)
      : current.length < 10 ? [...current, taskId] : current);
  };

  const moveFocusTask = useCallback((index: number, delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= focusTaskIds.length) return;
    const taskId = focusTaskIds[index];
    const copy = focusTaskIds.slice();
    [copy[index], copy[next]] = [copy[next], copy[index]];
    focusMoveTargetRef.current = taskId;
    setFocusMoveAnnouncement(t('board.focus.moved', { taskId, position: next + 1, count: copy.length }));
    setFocusTaskIds(copy);
  }, [focusTaskIds, t]);

  useLayoutEffect(() => {
    const taskId = focusMoveTargetRef.current;
    if (!taskId) return;
    focusMoveTargetRef.current = null;
    focusTaskRowRefs.current[taskId]?.focus();
  }, [focusTaskIds]);

  // Same live wire the inspector uses — the board must never be staler than
  // the chat narrating it.
  useEffect(() => {
    if (!podId || !socket || !connected) return undefined;
    const onTaskUpdated = (payload: { podId?: string } | null) => {
      if (!payload || (payload.podId && payload.podId !== podId)) return;
      load({ live: true });
      loadFocus();
    };
    socket.on('task_updated', onTaskUpdated);
    return () => { socket.off('task_updated', onTaskUpdated); };
  }, [podId, socket, connected, load, loadFocus]);

  const moveTask = useCallback(async (task: BoardTask, to: CanonicalStatus) => {
    if (!podId || task.status === to) return;
    const previous = task;
    setTasks((prev) => prev.map((item) => (item.taskId === task.taskId ? { ...item, status: to } : item)));
    setSelected((prev) => (prev && prev.taskId === task.taskId ? { ...prev, status: to } : prev));
    try {
      const res = await api.patch<{ task: BoardTask }>(
        `/api/v1/tasks/${podId}/${encodeURIComponent(task.taskId)}`,
        { status: to },
      );
      const updated = res.task;
      setTasks((prev) => prev.map((item) => (item.taskId === updated.taskId ? updated : item)));
      setSelected((prev) => (prev && prev.taskId === updated.taskId ? updated : prev));
    } catch {
      setTasks((prev) => prev.map((item) => (item.taskId === previous.taskId ? previous : item)));
      setSelected((prev) => (prev && prev.taskId === previous.taskId ? previous : prev));
    }
  }, [api, podId]);

  const createTask = useCallback(async () => {
    const title = newTitle.trim();
    if (!podId || !title || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api.post(`/api/v1/tasks/${podId}`, {
        title,
        priority: newPriority,
        ...(newAssignee.trim() ? { assignee: newAssignee.trim() } : {}),
      });
      setNewTitle('');
      setNewAssignee('');
      setNewPriority('P2');
      setCreateOpen(false);
      load();
    } catch {
      setCreateError(t('board.createError'));
    } finally {
      setCreating(false);
    }
  }, [api, podId, newTitle, newAssignee, newPriority, creating, load, t]);

  // The frame puts the filter chips under the tabs on a phone, so they render in one place or the other.
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_MEDIA_QUERY)?.matches,
  );
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_MEDIA_QUERY);
    if (!query) return undefined;
    const onChange = () => setIsPhone(query.matches);
    onChange();
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  const [filters, setFilters] = useState<BoardFilter[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [mobileTab, setMobileTab] = useState<CanonicalStatus>('pending');
  const toggleFilter = (key: BoardFilter) => setFilters((prev) => (
    prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
  ));
  const visibleTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (filters.includes('mine')) {
        const me = [currentUser?.username, currentUser?._id].filter(Boolean);
        if (!me.some((id) => id === task.assignee || id === task.claimedBy)) return false;
      }
      if (filters.includes('p0') && task.priority !== 'P0') return false;
      if (filters.includes('unclaimed') && (task.claimedBy || task.assignee)) return false;
      if (needle && !`${task.taskId} ${task.title}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [tasks, filters, query, currentUser]);
  const columnTasks = useMemo(() => {
    const byColumn = new Map<CanonicalStatus, BoardTask[]>();
    COLUMNS.forEach((col) => {
      byColumn.set(col.key, visibleTasks.filter((task) => col.statuses.includes(task.status)).sort((a, b) => (a.priority || 'P2').localeCompare(b.priority || 'P2')
        || (a.taskNum || 0) - (b.taskNum || 0) || a.taskId.localeCompare(b.taskId)));
    });
    return byColumn;
  }, [visibleTasks]);
  isPhoneRef.current = isPhone;
  mobileTabRef.current = mobileTab;
  columnTasksRef.current = columnTasks;

  // A card that left the open tab is gone once its fade ends, or after the
  // safety net if the animation never reports back.
  const dropLeaving = useCallback((taskId: string) => {
    setLeavingCards((current) => current.filter((item) => item.task.taskId !== taskId));
  }, []);
  useEffect(() => {
    if (!leavingCards.length) return undefined;
    const ids = leavingCards.map((item) => item.task.taskId);
    const timer = window.setTimeout(() => {
      setLeavingCards((current) => current.filter((item) => !ids.includes(item.task.taskId)));
    }, EXIT_SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [leavingCards]);
  // Switching tabs by hand drops any card still fading out of the old one.
  useEffect(() => { setLeavingCards([]); }, [mobileTab, isPhone]);

  const cardFace = (task: BoardTask) => (
    <>
      <span className="v2-board__card-kicker">
        <span className="v2-board__card-id">{task.taskId}</span>
        <span className={`v2-board__priority${task.priority === 'P0' ? ' v2-board__priority--p0' : ''}${(task.priority || 'P2') === 'P2' ? ' v2-board__priority--p2' : ''}`}>{task.priority || 'P2'}</span>
        <span className="v2-board__card-spacer" />
        {ownerLine(task)}
      </span>
      <span className="v2-board__card-title">{task.title}</span>
    </>
  );
  // The open phone tab keeps a leaving card in its old slot until its fade ends.
  const cardsFor = (key: CanonicalStatus, items: BoardTask[]) => {
    const rows: Array<{ task: BoardTask; leaving: LeavingCard | null }> = items.map((task) => ({ task, leaving: null }));
    if (!isPhone || key !== mobileTab) return rows;
    leavingCards.filter((item) => item.from === key).sort((a, b) => a.index - b.index).forEach((item) => {
      rows.splice(Math.min(item.index, rows.length), 0, { task: item.task, leaving: item });
    });
    return rows;
  };
  const filterChips = (
    <div className="v2-board__filters" role="group" aria-label={t('board.filter.label')}>
    {FILTERS.map((f) => (
      <button
        key={f.key}
        type="button"
        className={`v2-board__chip${filters.includes(f.key) ? ' is-on' : ''}`}
        aria-pressed={filters.includes(f.key)}
        onClick={() => toggleFilter(f.key)}
      >
        {f.key === 'mine' && <PersonOutlineIcon aria-hidden="true" />}
        {t(f.labelKey)}
      </button>
    ))}
  </div>
  );
  // The frame puts search inside the filter group on desktop and in the top bar on a phone.
  const searchControls = (
    <>
      {searchOpen && (
        <input
          type="search"
          className="v2-board__search"
          value={query}
          placeholder={t('board.search.placeholder')}
          aria-label={t('board.search.label')}
          onChange={(e) => setQuery(e.target.value)}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
      )}
      <button
        type="button"
        className="v2-board__icon-btn v2-board__key v2-board__key--ghost v2-board__key--icon"
        aria-label={t('board.search.label')}
        title={t('board.search.label')}
        aria-pressed={searchOpen}
        onClick={() => { setSearchOpen((open) => !open); if (searchOpen) setQuery(''); }}
      >
        <SearchIcon aria-hidden="true" />
      </button>
    </>
  );

  return (
    <div className="v2-board" data-testid="v2-board">
      <header className="v2-board__head">
        <button
          type="button"
          className="v2-board__back v2-board__key v2-board__key--ghost v2-board__key--icon"
          aria-label={t('board.backToChat')}
          title={t('board.backToChat')}
          onClick={() => navigate(`/v2/pods/${podId}`)}
        >
          <ArrowBackIcon fontSize="small" aria-hidden="true" />
        </button>
        <div className="v2-board__title-wrap">
          <h1 className="v2-board__title">{podName || t('board.title')}</h1>
          <span className="v2-board__subtitle">
            {t('board.taskCount', { count: tasks.length })}
          </span>
        </div>
        {isPhone ? searchControls : (
          <div className="v2-board__tools">
            {filterChips}
            {searchControls}
          </div>
        )}
        <button
          type="button"
          className="v2-board__new v2-board__key v2-board__key--ink v2-board__key--icon"
          aria-label={t('board.newTask')}
          title={t('board.newTask')}
          onClick={openCreateTask}
        >
          <AddIcon fontSize="small" aria-hidden="true" />
        </button>
      </header>

      <details className="v2-board__focus" aria-labelledby="v2-board-focus-title">
        <summary className="v2-board__focus-strip">
          <BoltOutlinedIcon className="v2-board__focus-icon" aria-hidden="true" />
          <span className="v2-board__focus-eyebrow">{t('board.focus.eyebrow')}</span>
          <h2 id="v2-board-focus-title" className="v2-board__focus-title">
            {focusRead?.focus ? focusRead.focus.goal : t('board.focus.title')}
          </h2>
          {focusRead?.focus && focusRead.focus.nextTasks.length > 0 && (
            <span className="v2-board__focus-progress">
              {t('board.focus.progress', {
                done: focusRead.focus.nextTasks.filter((task) => DONE_STATUSES.includes(task.status || '')).length,
                total: focusRead.focus.nextTasks.length,
              })}
            </span>
          )}
          {focusRead?.permissions?.canEdit && (
            <button type="button" className="v2-board__focus-edit" onClick={openFocusEditor}>
              {focusRead.focus ? t('board.focus.edit') : t('board.focus.set')}
            </button>
          )}
          <ExpandMoreIcon className="v2-board__focus-chevron" aria-hidden="true" />
        </summary>
        {focusLoading && !focusRead && <div className="v2-board__focus-muted">{t('board.focus.loading')}</div>}
        {focusError && (
          <div className="v2-board__focus-error">
            <span>{t('board.focus.loadError')}</span>
            <button type="button" className="v2-board__focus-retry" onClick={loadFocus}>{t('board.focus.retry')}</button>
          </div>
        )}
        {!focusLoading && !focusError && !focusRead?.focus && (
          <div className="v2-board__focus-muted">{t('board.focus.empty')}</div>
        )}
        {focusRead?.focus && (
          <div className="v2-board__focus-body">
            <p className="v2-board__focus-scope">{focusRead.focus.scope}</p>
            <div className="v2-board__focus-meta">
              <span>{t('board.focus.owner')}: <strong>{focusRead.focus.owner.label || focusRead.focus.owner.userId}</strong>{!focusRead.focus.owner.available && ` (${t('board.focus.unavailable')})`}</span>
              <span>{t('board.focus.updatedBy')}: <strong>{focusRead.focus.updatedBy.label || focusRead.focus.updatedBy.userId}</strong></span>
              <span>{t('board.focus.revision', { revision: focusRead.revision })}</span>
            </div>
            {focusRead.focus.nextTasks.length > 0 && (
              <ol className="v2-board__focus-tasks">
                {focusRead.focus.nextTasks.map((task, index) => (
                  <li key={task.taskId} className={!task.available ? 'v2-board__focus-task--unavailable' : undefined}>
                    <span className="v2-board__focus-task-position" aria-hidden="true">{index + 1}</span>
                    <span className="v2-board__focus-task-id">{task.taskId}</span>
                    {task.available && tasks.some((item) => item.taskId === task.taskId) ? (
                      <button type="button" className="v2-board__focus-task-title v2-board__focus-task-link" onClick={() => {
                        const boardTask = tasks.find((item) => item.taskId === task.taskId);
                        if (boardTask) openTask(boardTask);
                      }}>{task.title}</button>
                    ) : <span className="v2-board__focus-task-title">{t('board.focus.taskUnavailable')}</span>}
                    {(task.status || task.assignee) && <span className="v2-board__focus-task-meta">
                      {task.status && <span className="v2-board__focus-task-status">{task.status}</span>}
                      {task.assignee && <span className="v2-board__focus-task-status">@{task.assignee}</span>}
                    </span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </details>

      {loading && <div className="v2-empty"><span className="v2-spinner" /></div>}
      {!loading && loadError && (
        <div className="v2-empty">
          <div className="v2-empty__title">{t('board.loadErrorTitle')}</div>
          <div className="v2-empty__text">{t('board.loadErrorText')}</div>
        </div>
      )}

      {!loading && !loadError && (
        <>
          <div className="v2-board__tabs" role="tablist" aria-label={t('board.title')}>
            {COLUMNS.map((col) => (
              <button
                key={col.key}
                type="button"
                role="tab"
                aria-selected={mobileTab === col.key}
                className={`v2-board__tab${mobileTab === col.key ? ' is-active' : ''}`}
                onClick={() => setMobileTab(col.key)}
              >
                {t(col.labelKey)}
                <span
                  key={countTick.col === col.key ? `tick-${countTick.n}` : 'count'}
                  className={`v2-board__tab-count${countTick.col === col.key ? ' is-ticking' : ''}`}
                >
                  {(columnTasks.get(col.key) || []).length}
                </span>
              </button>
            ))}
          </div>
          {isPhone && filterChips}
          <div className={`v2-board__columns${showDone ? ' is-showdone' : ''}`}>
          {COLUMNS.map((col) => {
            const items = columnTasks.get(col.key) || [];
            return (
              <section key={col.key} className={`v2-board__col v2-board__col--${col.key}${mobileTab === col.key ? ' is-active' : ''}`} aria-label={t(col.labelKey)}>
                <div className="v2-board__col-head">
                  <span className={`v2-board__col-dot v2-board__col-dot--${col.key}${items.some((task) => leaseFor(task).claimed && !leaseFor(task).expired) ? ' is-live' : ''}`} aria-hidden="true" />
                  <span className="v2-board__col-name">{t(col.labelKey)}</span>
                  <span className="v2-board__col-count">{items.length}</span>
                  {col.key === 'pending' && (
                    // Opens the one create dialog; a new task always starts in Pending.
                    <button
                      type="button"
                      className="v2-board__col-new v2-board__key v2-board__key--ghost v2-board__key--icon v2-board__key--sm"
                      aria-label={t('board.addTo', { column: t(col.labelKey) })}
                      title={t('board.addTo', { column: t(col.labelKey) })}
                      onClick={openCreateTask}
                    >
                      <AddIcon aria-hidden="true" />
                    </button>
                  )}
                  {col.key === 'done' && (
                    <button type="button" className="v2-board__col-add v2-board__col-hide" onClick={() => setShowDone(false)}>
                      {t('board.doneRail.hide')}
                    </button>
                  )}
                </div>
                <div className="v2-board__col-body">
                {items.length === 0 && (
                  <div className="v2-board__col-empty">{t(col.emptyKey)}</div>
                )}
                {cardsFor(col.key, items).map(({ task, leaving }) => (leaving ? (
                  // A copy of the card that just left this tab, fading toward its new one.
                  <article
                    key={`leaving-${task.taskId}`}
                    className={`v2-board__card is-leaving is-leaving--${COLUMN_ORDER.indexOf(leaving.to) > COLUMN_ORDER.indexOf(leaving.from) ? 'next' : 'prev'}`}
                    aria-hidden="true"
                    {...{ inert: '' }}
                    onAnimationEnd={(event) => { if (event.target === event.currentTarget) dropLeaving(task.taskId); }}
                  >
                    <span className="v2-board__card-main">{cardFace(task)}</span>
                  </article>
                ) : (
                  <article
                    key={task.taskId}
                    className={`v2-board__card${col.key === 'done' ? ' v2-board__card--done' : ''}${col.key === 'blocked' ? ' v2-board__card--blocked' : ''}${selected?.taskId === task.taskId ? ' is-picked' : ''}`}
                    style={{ '--v2-task-vt': viewTransitionName('task', task.taskId) } as React.CSSProperties}
                  >
                    <button
                      type="button"
                      className="v2-board__card-main"
                      title={task.taskId}
                      onClick={() => openTask(task)}
                    >
                      {cardFace(task)}
                    </button>
                    <div className="v2-board__card-actions">
                      {col.moves.map((move) => (
                        <button
                          key={move.to}
                          type="button"
                          className="v2-board__card-move v2-board__key v2-board__key--ghost v2-board__key--icon"
                          aria-label={t(move.labelKey)}
                          title={t(move.labelKey)}
                          onClick={() => moveTask(task, move.to)}
                        >
                          <move.Icon aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </article>
                )))}
                </div>
              </section>
            );
          })}
          <aside className="v2-board__donecol" aria-label={t('board.col.done')}>
            <span className="v2-board__donecol-label"><CheckIcon aria-hidden="true" />{t('board.col.done')}</span>
            <span className="v2-board__donecol-count">{(columnTasks.get('done') || []).length}</span>
            <button type="button" className="v2-board__donecol-show v2-board__key v2-board__key--soft v2-board__key--sm" onClick={() => setShowDone(true)}>
              {t('board.doneRail.show')}
            </button>
          </aside>
          </div>
        </>
      )}

      {drawerTask && (
        <div
          className="v2-modal__overlay v2-board__overlay v2-board__overlay--drawer"
          role="presentation"
          onClick={() => openTask(null)}
          // While it slides out the drawer stays mounted, inert (React 18 takes
          // `inert` only as a string attribute).
          {...(drawer.leaving ? { inert: '', 'data-leaving': '' } : {})}
        >
          <div
            className="v2-modal v2-board__detail v2-board__drawer"
            {...(drawer.leaving ? { 'data-leaving': '' } : {})}
            ref={setDetailDialog}
            onAnimationEnd={drawer.onAnimationEnd}
            role="dialog"
            aria-label={drawerTask.title}
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="v2-board__grab" aria-hidden="true" />
            <div className="v2-board__drawer-head">
              <span className="v2-board__drawer-id">{drawerTask.taskId}</span>
              <span className={`v2-board__priority${drawerTask.priority === 'P0' ? ' v2-board__priority--p0' : ''}${(drawerTask.priority || 'P2') === 'P2' ? ' v2-board__priority--p2' : ''}`}>{drawerTask.priority || 'P2'}</span>
              <span className="v2-board__card-spacer" />
              <button
                type="button"
                className="v2-board__drawer-close v2-board__key v2-board__key--ghost v2-board__key--icon v2-board__key--sm"
                aria-label={t('common.close')}
                title={t('common.close')}
                onClick={() => openTask(null)}
              >
                <CloseIcon aria-hidden="true" />
              </button>
            </div>
            <div className="v2-board__drawer-body">
              <h2 className="v2-board__drawer-title">{drawerTask.title}</h2>
              <div className="v2-board__detail-meta">
                <div className="v2-board__status-segment" role="radiogroup" aria-label={t('board.detail.statusLabel')}>
                  {COLUMNS.map((column) => {
                    const current = column.statuses.includes(drawerTask.status);
                    return (
                      <button
                        key={column.key}
                        type="button"
                        role="radio"
                        aria-checked={current}
                        className="v2-board__status-option"
                        disabled={detailSaving || !taskWriteAllowed || current}
                        onClick={() => moveTask(drawerTask, column.statuses[0] as CanonicalStatus)}
                      >
                        {t(column.labelKey)}
                      </button>
                    );
                  })}
                </div>
                {drawerTask.prUrl && (
                  <a className="v2-board__detail-pr" href={drawerTask.prUrl} target="_blank" rel="noreferrer">
                    {t('board.detail.pr')}
                  </a>
                )}
                {recordReadAllowed && taskRecordPath(podId, drawerTask.taskId) && (
                  <Link className="v2-board__detail-pr" to={taskRecordPath(podId, drawerTask.taskId) as string}>
                    {t('board.detail.record')}
                  </Link>
                )}
              </div>
              <dl className="v2-board__ownership">
                <dt><label htmlFor="task-priority">{t('board.detail.priority')}</label></dt>
                <dd><select id="task-priority" value={drawerTask.priority || 'P2'} disabled={detailSaving || !taskWriteAllowed} onChange={(event) => updateDetail(drawerTask, { priority: event.target.value as TaskPriority })}>
                  {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
                </select></dd>
                <dt>{t('board.detail.assignedTo')}</dt>
                <dd>{drawerTask.assignee ? <>{memberAvatar(podMembers.find((member) => member.username === drawerTask.assignee) || {}, drawerTask.assignee)}{drawerTask.assignee}</> : <span className="v2-board__empty-owner">{t('board.detail.unassigned')}</span>}</dd>
                <dt>{t('board.detail.claimedBy')}</dt>
                <dd>{leaseFor(drawerTask).claimed ? <><span aria-hidden="true" className={`v2-board__owner-dot v2-board__owner-dot--${leaseFor(drawerTask).expired ? 'expired' : 'live'}`} />{memberAvatar(podMembers.find((item) => memberId(item) === drawerTask.claimedBy || item.username === drawerTask.claimedBy) || {}, claimHolderName(drawerTask))}{claimHolderName(drawerTask)}</> : <span className="v2-board__empty-owner">{t('board.detail.notClaimed')}</span>}</dd>
                <dt>{t('board.detail.leaseLeft')}</dt>
                <dd className="v2-board__lease-value">{leaseFor(drawerTask).claimed && leaseFor(drawerTask).knownExpiry
                  ? leaseFor(drawerTask).expired ? t('board.detail.expiredAt', { time: timeLabel(leaseFor(drawerTask).expiry) })
                    : t('board.detail.remaining', { minutes: leaseFor(drawerTask).minutes, time: timeLabel(leaseFor(drawerTask).expiry) })
                  : t(leaseFor(drawerTask).claimed ? 'board.detail.timeUnavailable' : 'board.detail.notClaimed')}</dd>
                <dt>{t('board.detail.depends')}</dt>
                <dd>{drawerTask.dep ? <span className="v2-board__dep">{drawerTask.dep}</span> : <span className="v2-board__empty-owner">{t('board.detail.noDeps')}</span>}</dd>
              </dl>
              <section className="v2-board__watchers" aria-label={t('board.detail.watchers')}>
                <div className="v2-board__watchers-head"><h3>{t('board.detail.watchers')}</h3><span className="v2-board__watchers-count">{watchers.length}</span>
                  <button type="button" className="v2-board__follow" aria-pressed={following} aria-disabled={detailSaving || !currentUser?._id} onClick={() => { if (!detailSaving && currentUser?._id) updateDetail(drawerTask, { following: !following }); }}>{following && <span aria-hidden="true">✓ </span>}{t(following ? 'board.detail.following' : 'board.detail.follow')}</button>
                </div>
                <div className="v2-board__watcher-list">{watchers.map((id) => {
                  const member = podMembers.find((item) => memberId(item) === id) || (id === currentUser?._id ? currentUser : {});
                  const name = memberLabel(member) || t('board.detail.memberUnavailable');
                  return <span className="v2-board__watcher" key={id}>{memberAvatar(member, name)}{name}</span>;
                })}</div>
                <p className="v2-board__watcher-hint">{t('board.detail.digestHint')}</p>
              </section>
              {detailError && <p className="v2-modal__error" role="alert">{detailError}</p>}
              {drawerTask.notes && <p className="v2-board__detail-notes">{drawerTask.notes}</p>}
              {(drawerTask.updates?.length || 0) > 0 && (
                <>
                  <div className="v2-modal__section-title">{t('board.detail.updates')}</div>
                  <ul className="v2-board__detail-updates">
                    {(() => {
                      // Newest first. The two newest stay visible (d215 frame); older ones fold behind a toggle.
                      const ordered = (drawerTask.updates || []).slice().reverse();
                      const earlier = Math.max(0, ordered.length - VISIBLE_UPDATES);
                      return (updatesExpanded ? ordered : ordered.slice(0, ordered.length - earlier)).map((update, index) => (
                        // Updates have no id; index-in-reversed-list is stable
                        // for a render of an immutable snapshot.
                        // eslint-disable-next-line react/no-array-index-key
                        <li key={index}>
                          {memberAvatar(podMembers.find((member) => memberId(member) === update.authorId) || {}, update.author)}
                          <span className="v2-board__detail-update-text">
                            {/* The frame draws only the face; the name stays for screen readers. */}
                            {update.author && <span className="v2-board__update-author">{update.author}: </span>}
                            {update.text}
                            {Number.isFinite(Date.parse(update.createdAt || '')) && (
                              <> <span className="v2-board__update-time">{timeLabel(Date.parse(update.createdAt as string))}</span></>
                            )}
                          </span>
                        </li>
                      ));
                    })()}
                  </ul>
                  {(drawerTask.updates?.length || 0) > VISIBLE_UPDATES && (
                    <button type="button" className="v2-board__updates-toggle" aria-expanded={updatesExpanded} onClick={() => setUpdatesExpanded((open) => !open)}>
                      <ExpandMoreIcon aria-hidden="true" />
                      {updatesExpanded
                        ? t('board.detail.hideEarlierUpdates')
                        : t('board.detail.showEarlierUpdates', { count: (drawerTask.updates?.length || 0) - VISIBLE_UPDATES })}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {focusEditorOpen && (
        <div className="v2-modal__overlay" role="presentation" onClick={closeFocusEditor}>
          <div ref={focusDialogRef} className="v2-modal v2-board__focus-editor" role="dialog" aria-modal="true" aria-label={t('board.focus.editorTitle')} onClick={(event) => event.stopPropagation()}>
            <div className="v2-modal__head">
              <div className="v2-modal__title">{t('board.focus.editorTitle')}</div>
              <button type="button" className="v2-modal__close" onClick={closeFocusEditor}>×</button>
            </div>
            <div className="v2-modal__body">
              <label className="v2-board__field">
                <span>{t('board.focus.goal')}</span>
                <input type="text" value={focusGoal} maxLength={240} onChange={(event) => setFocusGoal(event.target.value)} />
              </label>
              <label className="v2-board__field">
                <span>{t('board.focus.scope')}</span>
                <textarea value={focusScope} maxLength={2000} onChange={(event) => setFocusScope(event.target.value)} rows={4} />
              </label>
              <label className="v2-board__field">
                <span>{t('board.focus.owner')}</span>
                <select value={focusOwner} onChange={(event) => setFocusOwner(event.target.value)}>
                  <option value="">{t('board.focus.chooseOwner')}</option>
                  {podMembers.filter((member) => memberId(member)).map((member) => (
                    <option key={memberId(member)} value={memberId(member)}>{memberLabel(member)}</option>
                  ))}
                </select>
              </label>
              <div className="v2-board__field">
                <span>{t('board.focus.tasks')}</span>
                <div className="v2-board__focus-task-picker">
                  {tasks.map((task) => (
                    <label key={task.taskId} className="v2-board__focus-task-option">
                      <input type="checkbox" checked={focusTaskIds.includes(task.taskId)} onChange={() => toggleFocusTask(task.taskId)} />
                      <span>{task.taskId} — {task.title}</span>
                    </label>
                  ))}
                </div>
              </div>
              {focusTaskIds.length > 0 && (
                <ol className="v2-board__focus-selected" data-testid="focus-selected">
                  {focusTaskIds.map((taskId, index) => {
                    const task = tasks.find((item) => item.taskId === taskId);
                    return (
                      <li
                        key={taskId}
                        ref={(node) => { focusTaskRowRefs.current[taskId] = node; }}
                        tabIndex={-1}
                      >
                        <span className="v2-board__focus-position" aria-hidden="true">{index + 1}</span>
                        <span className="v2-board__focus-task-label">{taskId} — {task?.title || t('board.focus.taskUnavailable')}</span>
                        <button type="button" onClick={() => moveFocusTask(index, -1)} disabled={index === 0}>{t('board.focus.up')}</button>
                        <button type="button" onClick={() => moveFocusTask(index, 1)} disabled={index === focusTaskIds.length - 1}>{t('board.focus.down')}</button>
                        <button type="button" onClick={() => toggleFocusTask(taskId)}>{t('board.focus.remove')}</button>
                      </li>
                    );
                  })}
                </ol>
              )}
              <div className="v2-board__focus-live" role="status" aria-live="polite">{focusMoveAnnouncement}</div>
              {focusSaveError && <div className="v2-modal__error">{focusSaveError}</div>}
              {focusConflictLatest && (
                <section className="v2-board__focus-conflict" aria-label={t('board.focus.latestTitle')}>
                  <h3>{t('board.focus.latestTitle')}</h3>
                  {focusConflictLatest.focus ? <>
                    <p><strong>{t('board.focus.goal')}:</strong> {focusConflictLatest.focus.goal}</p>
                    <p><strong>{t('board.focus.scope')}:</strong> {focusConflictLatest.focus.scope}</p>
                    <p><strong>{t('board.focus.owner')}:</strong> {focusConflictLatest.focus.owner.label || t('board.focus.unavailable')}{!focusConflictLatest.focus.owner.available && ` — ${t('board.focus.unavailable')}`}</p>
                    <ol>
                      {focusConflictLatest.focus.nextTasks.map((task) => (
                        <li key={task.taskId}>{task.taskId} — {task.title || t('board.focus.taskUnavailable')}</li>
                      ))}
                    </ol>
                  </> : <p>{t('board.focus.empty')}</p>}
                  <p><strong>{t('board.focus.revision', { revision: focusConflictLatest.revision })}</strong></p>
                  <button
                    type="button"
                    className="v2-board__focus-review-latest"
                    disabled={focusConflictReviewed}
                    onClick={() => {
                      setFocusBaseRevision(focusConflictLatest.revision);
                      setFocusConflictReviewed(true);
                    }}
                  >
                    {focusConflictReviewed ? t('board.focus.latestReviewed') : t('board.focus.reviewLatest')}
                  </button>
                </section>
              )}
              <div className="v2-board__focus-actions">
                {focusRead?.focus && <button type="button" className="v2-board__focus-clear" disabled={focusSaving} onClick={() => saveFocus(true)}>{t('board.focus.clear')}</button>}
                <button type="button" className="v2-board__focus-save" disabled={focusSaving || !focusGoal.trim() || !focusScope.trim() || !focusOwner || Boolean(focusConflictLatest && !focusConflictReviewed)} onClick={() => saveFocus()}>{focusSaving ? t('board.focus.saving') : t('board.focus.save')}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {createOpen && (
        <div className="v2-modal__overlay" role="presentation" onClick={() => setCreateOpen(false)}>
          <div
            className="v2-modal v2-board__create"
            role="dialog"
            aria-label={t('board.newTask')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="v2-modal__head">
              <div className="v2-modal__title">{t('board.newTask')}</div>
              <button type="button" className="v2-modal__close" onClick={() => setCreateOpen(false)}>×</button>
            </div>
            <div className="v2-modal__body">
              <label className="v2-board__field">
                <span>{t('board.form.title')}</span>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') createTask(); }}
                  placeholder={t('board.form.titlePlaceholder')}
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                />
              </label>
              <div className="v2-board__create-row">
              <label className="v2-board__field">
                <span>{t('board.form.assignee')}</span>
                <input
                  type="text"
                  value={newAssignee}
                  onChange={(event) => setNewAssignee(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') createTask(); }}
                  placeholder={t('board.form.assigneePlaceholder')}
                />
              </label>
              <label className="v2-board__field">
                <span>{t('board.detail.priority')}</span>
                <select value={newPriority} onChange={(event) => setNewPriority(event.target.value as TaskPriority)}>
                  {PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}{priority === 'P2' ? ` · ${t('board.form.defaultPriority')}` : ''}</option>)}
                </select>
                <small>{t('board.form.priorityHint')}</small>
              </label>
              </div>
              {createError && <div className="v2-modal__error">{createError}</div>}
              <button
                type="button"
                className="v2-board__create-submit"
                disabled={!newTitle.trim() || creating}
                onClick={createTask}
              >
                {creating ? t('board.form.creating') : t('board.form.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default V2PodBoard;
