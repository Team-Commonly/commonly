import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import V2Avatar from './V2Avatar';
import { requestFirstRunGuide } from '../firstRunGuide';

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
  kind: 'mention' | 'approval';
  title: string;
  detail: string;
  podId: string | null;
  podName: string;
  timestamp: string | null;
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
  const [window, setWindow] = useState<ActivityWindow>('today');
  const [podId, setPodId] = useState('all');
  const [recap, setRecap] = useState<ActivityRecap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [actingApprovalId, setActingApprovalId] = useState<string | null>(null);
  const [acknowledgingMentionId, setAcknowledgingMentionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const token = localStorage.getItem('token');
    axios.get<ActivityRecap>('/api/activity/recap', {
      headers: { 'x-auth-token': token ?? '' },
      params: { window, ...(podId !== 'all' ? { podId } : {}) },
    })
      .then((response) => {
        if (active) setRecap(response.data);
      })
      .catch(() => {
        if (active) setError(t('activity.loadFailed'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [podId, reloadKey, t, window]);

  const openPod = (targetPodId: string | null) => {
    if (targetPodId) navigate(`/v2/pods/${targetPodId}`);
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
        `/api/activity/${item.id}/${action}`,
        { notes: `${action === 'approve' ? 'Approved' : 'Rejected'} via Activity` },
        { headers: { 'x-auth-token': token ?? '' } },
      );
      if (!response.data?.success) throw new Error('Activity action failed');
      setReloadKey((value) => value + 1);
    } catch {
      setActionError(t('activity.approval.actionFailed'));
    } finally {
      setActingApprovalId(null);
    }
  };

  const acknowledgeMention = async (item: NeedsYouItem) => {
    if (acknowledgingMentionId) return;
    setAcknowledgingMentionId(item.id);
    setActionError(null);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.post<{ success?: boolean }>(
        `/api/activity/${item.id}/acknowledge`,
        {},
        { headers: { 'x-auth-token': token ?? '' } },
      );
      if (!response.data?.success) throw new Error('Mention acknowledgement failed');
      setReloadKey((value) => value + 1);
    } catch {
      setActionError(t('activity.mention.actionFailed'));
    } finally {
      setAcknowledgingMentionId(null);
    }
  };

  const isDayZero = podId === 'all'
    && recap?.agents.length === 0
    && recap.board.length === 0;

  return (
    <div className="v2-activity" aria-busy={loading}>
      <header className="v2-activity__header">
        <div>
          <h1 className="v2-activity__title">{t('activity.title')}</h1>
          <p className="v2-activity__subtitle">{t('activity.subtitle')}</p>
        </div>
        <div className="v2-activity__controls" aria-label={t('activity.controlsAriaLabel')}>
          <div className="v2-activity__window" role="group" aria-label={t('activity.windowAriaLabel')}>
            {(['today', '7d'] as ActivityWindow[]).map((value) => (
              <button
                key={value}
                type="button"
                className={`v2-activity__window-button${window === value ? ' v2-activity__window-button--active' : ''}`}
                onClick={() => setWindow(value)}
                aria-pressed={window === value}
              >
                {t(`activity.windows.${value}`)}
              </button>
            ))}
          </div>
          <label className="v2-activity__scope">
            <span className="v2-sr-only">{t('activity.podScopeLabel')}</span>
            <select value={podId} onChange={(event) => setPodId(event.target.value)}>
              <option value="all">{t('activity.allPods')}</option>
              {(recap?.pods || []).map((pod) => <option key={pod.id} value={pod.id}>{pod.name}</option>)}
            </select>
          </label>
        </div>
      </header>

      {loading && <div className="v2-activity__loading"><span className="v2-spinner" /></div>}
      {!loading && error && <div className="v2-activity__error" role="alert">{error}</div>}
      {!loading && !error && recap && (
        <div className="v2-activity__sections">
          <section className="v2-activity__section" aria-labelledby="activity-needs-you">
            <div className="v2-activity__section-heading">
              <div>
                <div className="v2-activity__eyebrow">{t('activity.needsYou.eyebrow')}</div>
                <h2 id="activity-needs-you">{t('activity.needsYou.title')}</h2>
              </div>
              <p>{t('activity.needsYou.description')}</p>
            </div>
            {isDayZero ? (
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
            ) : recap.needsYou.length === 0 ? (
              <div className="v2-activity__empty">
                <strong>{t('activity.needsYou.emptyTitle')}</strong>
                <span>{t('activity.needsYou.emptyDescription')}</span>
              </div>
            ) : (
              <div className="v2-activity__queue">
                {recap.needsYou.map((item) => (
                  <article key={item.id} className={`v2-activity__queue-row v2-activity__queue-row--${item.kind}`}>
                    <span className="v2-activity__queue-mark" aria-hidden="true">{item.kind === 'mention' ? '@' : '!'}</span>
                    <div className="v2-activity__queue-copy">
                      <div className="v2-activity__queue-kind">{t(`activity.needsYou.kinds.${item.kind}`)}</div>
                      <strong>{item.title}</strong>
                      {item.detail && <p>{item.detail}</p>}
                      <span>{item.podName}{item.timestamp ? ` · ${relativeTime(item.timestamp)}` : ''}</span>
                    </div>
                    <div className="v2-activity__queue-actions">
                      {item.kind === 'approval' && (
                        <>
                          <button type="button" onClick={() => actOnApproval(item, 'approve')} disabled={actingApprovalId === item.id}>
                            {actingApprovalId === item.id ? t('activity.approval.working') : t('activity.approval.approve')}
                          </button>
                          <button type="button" className="v2-activity__queue-action--secondary" onClick={() => actOnApproval(item, 'reject')} disabled={actingApprovalId === item.id}>
                            {t('activity.approval.reject')}
                          </button>
                        </>
                      )}
                      {item.kind === 'mention' && (
                        <button type="button" onClick={() => acknowledgeMention(item)} disabled={acknowledgingMentionId === item.id}>
                          {acknowledgingMentionId === item.id ? t('activity.mention.working') : t('activity.mention.acknowledge')}
                        </button>
                      )}
                      <button type="button" className="v2-activity__queue-action--thread" onClick={() => openPod(item.podId)} disabled={!item.podId}>
                        {t('activity.openThread')}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {actionError && <div className="v2-activity__action-error" role="alert">{actionError}</div>}
          </section>

          <section className="v2-activity__section" aria-labelledby="activity-agents">
            <div className="v2-activity__section-heading">
              <div>
                <div className="v2-activity__eyebrow">{t('activity.agents.eyebrow')}</div>
                <h2 id="activity-agents">{t('activity.agents.title')}</h2>
              </div>
              <p>{t('activity.agents.description')}</p>
            </div>
            {recap.agents.length === 0 ? (
              <div className="v2-activity__empty">
                <strong>{t('activity.agents.emptyTitle')}</strong>
                <span>{t('activity.agents.emptyDescription')}</span>
              </div>
            ) : (
              <div className="v2-activity__agent-grid">
                {recap.agents.map((agent) => (
                  <article key={agent.id} className="v2-activity__agent-card">
                    <div className="v2-activity__agent-topline">
                      <V2Avatar name={agent.name} src={agent.profilePicture} seed={agent.id} kind="agent" />
                      <div>
                        <h3>{agent.name}</h3>
                        <span>{agent.lastActiveAt ? t('activity.lastActive', { time: relativeTime(agent.lastActiveAt) }) : ''}</span>
                      </div>
                      <span className="v2-activity__count-chip">{t('activity.updatesCount', { count: agent.messageCount })}</span>
                    </div>
                    <p className="v2-activity__agent-recap">{agent.recap}</p>
                    <div className="v2-activity__updates">
                      {agent.updates.map((update) => (
                        <button key={update.id} type="button" onClick={() => openPod(update.podId)} disabled={!update.podId}>
                          <span className="v2-activity__update-pod">{update.podName}</span>
                          <span className="v2-activity__update-content">{update.content}</span>
                          <span className="v2-activity__update-time">{relativeTime(update.timestamp)}</span>
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="v2-activity__section" aria-labelledby="activity-board">
            <div className="v2-activity__section-heading">
              <div>
                <div className="v2-activity__eyebrow">{t('activity.board.eyebrow')}</div>
                <h2 id="activity-board">{t('activity.board.title')}</h2>
              </div>
              <p>{t('activity.board.description')}</p>
            </div>
            {recap.board.length === 0 ? (
              <div className="v2-activity__empty">
                <strong>{t('activity.board.emptyTitle')}</strong>
                <span>{t('activity.board.emptyDescription')}</span>
              </div>
            ) : (
              <div className="v2-activity__board-list">
                {recap.board.map((item) => (
                  <article key={item.id} className="v2-activity__board-row">
                    <div className="v2-activity__board-main">
                      <span className={`v2-activity__status v2-activity__status--${item.status}`}>{t(`activity.board.status.${item.status}`)}</span>
                      <div>
                        <span className="v2-activity__task-id">{item.taskId}</span>
                        <h3>{item.title}</h3>
                        {item.lastUpdate && <p>{item.lastUpdate.author ? `${item.lastUpdate.author}: ` : ''}{item.lastUpdate.text}</p>}
                      </div>
                    </div>
                    <div className="v2-activity__board-meta">
                      <span>{item.podName}</span>
                      <span>{relativeTime(item.updatedAt)}</span>
                      <button type="button" onClick={() => openPod(item.podId)}>{t('activity.openThread')}</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      <footer className="v2-activity__footer">{t('activity.footer')}</footer>
    </div>
  );
};

export default V2ActivityPage;
