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
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  const { socket, connected } = useSocket();

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

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Pod name for the header — membership-gated read; a failure only costs
  // the label.
  useEffect(() => {
    if (!podId) return;
    let cancelled = false;
    (async () => {
      try {
        const pod = await api.get<{ name?: string }>(`/api/pods/${podId}`);
        if (!cancelled && pod?.name) setPodName(pod.name);
      } catch {
        // Header falls back to the generic title.
      }
    })();
    return () => { cancelled = true; };
  }, [api, podId]);

  // Same live wire the inspector uses — the board must never be staler than
  // the chat narrating it.
  useEffect(() => {
    if (!podId || !socket || !connected) return undefined;
    const onTaskUpdated = (payload: { podId?: string } | null) => {
      if (!payload || (payload.podId && payload.podId !== podId)) return;
      load();
    };
    socket.on('task_updated', onTaskUpdated);
    return () => { socket.off('task_updated', onTaskUpdated); };
  }, [podId, socket, connected, load]);

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
