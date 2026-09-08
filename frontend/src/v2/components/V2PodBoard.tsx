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
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useV2Api } from '../hooks/useV2Api';
import { useSocket } from '../../context/SocketContext';

type CanonicalStatus = 'pending' | 'claimed' | 'blocked' | 'done';

interface BoardTask {
  taskId: string;
  title: string;
  status: string;
  assignee?: string | null;
  notes?: string | null;
  prUrl?: string | null;
  updatedAt?: string;
  updates?: Array<{ text: string; author: string; createdAt?: string }>;
}

interface PodMember {
  _id?: string;
  username?: string;
  displayName?: string;
  isBot?: boolean;
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
  pillClass: string;
  // Alias statuses written before the PATCH vocabulary gate (#921) render in
  // their canonical column instead of disappearing.
  statuses: string[];
  // Click-to-move targets offered on cards in this column.
  moves: Array<{ to: CanonicalStatus; labelKey: string }>;
}

const COLUMNS: ColumnMeta[] = [
  {
    key: 'pending',
    labelKey: 'board.col.pending',
    emptyKey: 'board.emptyCol.pending',
    pillClass: 'v2-inspector__pill v2-inspector__pill--progress',
    statuses: ['pending', 'todo', 'open'],
    moves: [
      { to: 'claimed', labelKey: 'board.move.start' },
      { to: 'blocked', labelKey: 'board.move.block' },
    ],
  },
  {
    key: 'claimed',
    labelKey: 'board.col.inProgress',
    emptyKey: 'board.emptyCol.inProgress',
    pillClass: 'v2-inspector__pill v2-inspector__pill--progress',
    statuses: ['claimed', 'in_progress', 'in-progress'],
    moves: [
      { to: 'done', labelKey: 'board.move.finish' },
      { to: 'blocked', labelKey: 'board.move.block' },
    ],
  },
  {
    key: 'blocked',
    labelKey: 'board.col.blocked',
    emptyKey: 'board.emptyCol.blocked',
    pillClass: 'v2-inspector__pill v2-inspector__pill--blocked',
    statuses: ['blocked'],
    moves: [
      { to: 'claimed', labelKey: 'board.move.resume' },
      { to: 'pending', labelKey: 'board.move.reopen' },
    ],
  },
  {
    key: 'done',
    labelKey: 'board.col.done',
    emptyKey: 'board.emptyCol.done',
    pillClass: 'v2-inspector__pill v2-inspector__pill--complete',
    statuses: ['done', 'completed', 'complete'],
    moves: [
      { to: 'pending', labelKey: 'board.move.reopen' },
    ],
  },
];

const V2PodBoard: React.FC = () => {
  const { podId } = useParams<{ podId: string }>();
  const { t } = useTranslation();
  const api = useV2Api();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { socket, connected, joinPod, leavePod } = useSocket();

  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [podName, setPodName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<BoardTask | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [podMembers, setPodMembers] = useState<PodMember[]>([]);
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
  const focusWasConnectedRef = useRef(connected);

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

  const load = useCallback(async () => {
    if (!podId) return;
    try {
      const data = await api.get<{ tasks: BoardTask[] }>(`/api/v1/tasks/${podId}`);
      setTasks(data.tasks || []);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [api, podId]);

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
    load();
  }, [load]);

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
    const wasConnected = focusWasConnectedRef.current;
    focusWasConnectedRef.current = connected;
    if (connected && !wasConnected) loadFocus();
  }, [connected, loadFocus]);

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
      load();
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
        ...(newAssignee.trim() ? { assignee: newAssignee.trim() } : {}),
      });
      setNewTitle('');
      setNewAssignee('');
      setCreateOpen(false);
      load();
    } catch {
      setCreateError(t('board.createError'));
    } finally {
      setCreating(false);
    }
  }, [api, podId, newTitle, newAssignee, creating, load, t]);

  const columnTasks = useMemo(() => {
    const byColumn = new Map<CanonicalStatus, BoardTask[]>();
    COLUMNS.forEach((col) => {
      byColumn.set(col.key, tasks.filter((task) => col.statuses.includes(task.status)));
    });
    return byColumn;
  }, [tasks]);

  const pillFor = (status: string): { className: string; label: string } => {
    const col = COLUMNS.find((c) => c.statuses.includes(status)) || COLUMNS[0];
    return { className: col.pillClass, label: t(col.labelKey) };
  };

  return (
    <div className="v2-board" data-testid="v2-board">
      <header className="v2-board__head">
        <button
          type="button"
          className="v2-board__back"
          onClick={() => navigate(`/v2/pods/${podId}`)}
        >
          <ArrowBackIcon fontSize="small" aria-hidden="true" />
          {t('board.backToChat')}
        </button>
        <div className="v2-board__title-wrap">
          <h1 className="v2-board__title">{podName || t('board.title')}</h1>
          <span className="v2-board__subtitle">
            {t('board.taskCount', { count: tasks.length })}
          </span>
        </div>
        <button
          type="button"
          className="v2-board__new"
          onClick={openCreateTask}
        >
          <AddIcon fontSize="small" aria-hidden="true" />
          {t('board.newTask')}
        </button>
      </header>

      <section className="v2-board__focus" aria-labelledby="v2-board-focus-title">
        <div className="v2-board__focus-head">
          <div>
            <div className="v2-board__focus-eyebrow">{t('board.focus.eyebrow')}</div>
            <h2 id="v2-board-focus-title" className="v2-board__focus-title">{t('board.focus.title')}</h2>
          </div>
          {focusRead?.permissions?.canEdit && (
            <button type="button" className="v2-board__focus-edit" onClick={openFocusEditor}>
              {focusRead.focus ? t('board.focus.edit') : t('board.focus.set')}
            </button>
          )}
        </div>
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
            <p className="v2-board__focus-goal">{focusRead.focus.goal}</p>
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
                        if (boardTask) setSelected(boardTask);
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
      </section>

      {loading && <div className="v2-empty"><span className="v2-spinner" /></div>}
      {!loading && loadError && (
        <div className="v2-empty">
          <div className="v2-empty__title">{t('board.loadErrorTitle')}</div>
          <div className="v2-empty__text">{t('board.loadErrorText')}</div>
        </div>
      )}

      {!loading && !loadError && (
        <div className="v2-board__columns">
          {COLUMNS.map((col) => {
            const items = columnTasks.get(col.key) || [];
            return (
              <section key={col.key} className="v2-board__col" aria-label={t(col.labelKey)}>
                <div className="v2-board__col-head">
                  <span className="v2-board__col-name">{t(col.labelKey)}</span>
                  <span className="v2-board__col-count">{items.length}</span>
                </div>
                {items.length === 0 && (
                  <div className="v2-board__col-empty">{t(col.emptyKey)}</div>
                )}
                {items.map((task) => (
                  <article key={task.taskId} className="v2-board__card">
                    <button
                      type="button"
                      className="v2-board__card-main"
                      onClick={() => setSelected(task)}
                    >
                      <span className="v2-board__card-id">{task.taskId}</span>
                      <span className="v2-board__card-title">{task.title}</span>
                      {task.assignee && (
                        <span className="v2-board__card-assignee">@{task.assignee}</span>
                      )}
                    </button>
                    <div className="v2-board__card-actions">
                      {col.moves.map((move) => (
                        <button
                          key={move.to}
                          type="button"
                          className="v2-board__card-move"
                          onClick={() => moveTask(task, move.to)}
                        >
                          {t(move.labelKey)}
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="v2-modal__overlay" role="presentation" onClick={() => setSelected(null)}>
          <div
            className="v2-modal v2-board__detail"
            role="dialog"
            aria-label={selected.title}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="v2-modal__head">
              <div className="v2-modal__title">
                <span className="v2-board__card-id">{selected.taskId}</span> {selected.title}
              </div>
              <button type="button" className="v2-modal__close" onClick={() => setSelected(null)}>×</button>
            </div>
            <div className="v2-modal__body">
              <div className="v2-board__detail-meta">
                {(() => { const pill = pillFor(selected.status); return <span className={pill.className}>{pill.label}</span>; })()}
                {selected.assignee && <span className="v2-board__card-assignee">@{selected.assignee}</span>}
                {selected.prUrl && (
                  <a className="v2-board__detail-pr" href={selected.prUrl} target="_blank" rel="noreferrer">
                    {t('board.detail.pr')}
                  </a>
                )}
              </div>
              {selected.notes && <p className="v2-board__detail-notes">{selected.notes}</p>}
              <div className="v2-board__detail-moves">
                {(COLUMNS.find((c) => c.statuses.includes(selected.status))?.moves || []).map((move) => (
                  <button
                    key={move.to}
                    type="button"
                    className="v2-board__card-move"
                    onClick={() => moveTask(selected, move.to)}
                  >
                    {t(move.labelKey)}
                  </button>
                ))}
              </div>
              {(selected.updates?.length || 0) > 0 && (
                <>
                  <div className="v2-modal__section-title">{t('board.detail.updates')}</div>
                  <ul className="v2-board__detail-updates">
                    {(selected.updates || []).slice().reverse().map((update, index) => (
                      // Updates have no id; index-in-reversed-list is stable
                      // for a render of an immutable snapshot.
                      // eslint-disable-next-line react/no-array-index-key
                      <li key={index}>
                        <span className="v2-board__detail-update-author">{update.author}</span>
                        <span className="v2-board__detail-update-text">{update.text}</span>
                      </li>
                    ))}
                  </ul>
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
