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
  const [rulingId, setRulingId] = useState<string | null>(null);
  const [otherDecisionId, setOtherDecisionId] = useState<string | null>(null);
  const [otherDecisionValue, setOtherDecisionValue] = useState('');
  const [ruledDecisions, setRuledDecisions] = useState<Record<string, { value: string; by: string }>>({});
  const [composePodId, setComposePodId] = useState('');
  const [composeDraft, setComposeDraft] = useState('');
  const [composing, setComposing] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);

  const [queue, setQueue] = useState<NeedsYouItem[]>([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const token = localStorage.getItem('token');
    const headers = { 'x-auth-token': token ?? '' };
    // The recap paints the room; the decision queue is the reason the page
    // exists (TASK-083). They load together, but a queue failure must not
    // blank the recap — degrade to recap.needsYou (mentions + approvals).
    Promise.all([
      axios.get<ActivityRecap>('/api/activity/recap', {
        headers,
        params: { window, ...(podId !== 'all' ? { podId } : {}) },
      }),
      axios.get<{
        items: Array<NeedsYouItem & { createdAt?: string | null }>;
        composePodId?: string | null;
      }>(
        '/api/activity/decision-queue',
        { headers },
      ).catch(() => null),
    ])
      .then(([recapResponse, queueResponse]) => {
        if (!active) return;
        setRecap(recapResponse.data);
        // A well-formed queue response has an items ARRAY. Anything else —
        // endpoint failed (null), older server, malformed body — degrades to
        // recap.needsYou (mentions + approvals) rather than an empty queue.
        const rawItems = queueResponse?.data?.items;
        const availablePods = recapResponse.data.pods || [];
        const setComposeDefault = (candidate = '') => {
          const fallback = candidate || availablePods[0]?.id || '';
          setComposePodId((current) => (
            current && availablePods.some((pod) => pod.id === current) ? current : fallback
          ));
        };
        if (!Array.isArray(rawItems)) {
          setQueue(recapResponse.data.needsYou || []);
          setComposeDefault();
          return;
        }
        const queueItems = rawItems.map((item) => ({
          ...item,
          detail: item.detail || '',
          podName: item.podName || '',
          timestamp: item.timestamp ?? item.createdAt ?? null,
        }));
        setQueue(podId !== 'all'
          ? queueItems.filter((item) => item.podId === podId)
          : queueItems);
        // Preserve an intentional target choice across queue refreshes. On
        // first load, anchor the composer to the most recent direct traffic;
        // no traffic simply falls back to the user's first available pod.
        setComposeDefault(queueResponse?.data?.composePodId || '');
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
        `/api/activity/${encodeURIComponent(item.id)}/${action}`,
        { notes: `${action === 'approve' ? 'Approved' : 'Rejected'} via Activity` },
        { headers: { 'x-auth-token': token ?? '' } },
      );
      if (!response.data?.success) throw new Error('Approval action failed');
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
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
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
      setReloadKey((value) => value + 1);
    } catch {
      setActionError(t('activity.mention.actionFailed'));
    } finally {
      setReplyingId(null);
    }
  };

  const acknowledgeMention = async (item: NeedsYouItem) => {
    if (acknowledgingMentionId) return;
    setAcknowledgingMentionId(item.id);
    setActionError(null);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.post<{ success?: boolean }>(
        `/api/activity/${item.attentionItemId || item.id}/acknowledge`,
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
    && queue.length === 0
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
        <>
          <section className="v2-activity__compose" aria-labelledby="activity-compose-title">
            <div className="v2-activity__compose-top">
              <h2 id="activity-compose-title" className="v2-activity__compose-label">{t('activity.compose.label')}</h2>
              <label className="v2-activity__compose-pod">
                <span>{t('activity.compose.podLabel')}</span>
                <select value={composePodId} onChange={(event) => setComposePodId(event.target.value)}>
                  {(recap.pods || []).map((pod) => <option key={pod.id} value={pod.id}>{pod.name}</option>)}
                </select>
              </label>
            </div>
            <textarea
              aria-label={t('activity.compose.placeholder')}
              rows={2}
              placeholder={t('activity.compose.placeholder')}
              value={composeDraft}
              onChange={(event) => setComposeDraft(event.target.value)}
              onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') sendCompose(); }}
              disabled={composing || !composePodId}
            />
            <div className="v2-activity__compose-foot">
              <span className="v2-activity__compose-hint">{t('activity.compose.hint')}</span>
              <button type="button" aria-label={t('activity.compose.sendAriaLabel')} onClick={sendCompose} disabled={composing || !composePodId || !composeDraft.trim()}>
                {composing ? t('activity.compose.working') : t('activity.compose.send')}
              </button>
            </div>
            {composeError && <div className="v2-activity__action-error" role="alert">{composeError}</div>}
          </section>

          <div className="v2-activity__sections">
          <section className="v2-activity__section" aria-labelledby="activity-needs-you">
            <div className="v2-activity__section-heading">
              <h2 id="activity-needs-you">{t('activity.needsYou.title')}</h2>
              {!isDayZero && queue.length > 0 && <span className="v2-activity__count" aria-label={t('activity.needsYou.countLabel', { count: queue.length })}>{queue.length}</span>}
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
            ) : queue.length === 0 ? (
              <div className="v2-activity__empty">
                <strong>{t('activity.needsYou.emptyTitle')}</strong>
                <span>{t('activity.needsYou.emptyDescription')}</span>
              </div>
            ) : (
              <div className="v2-activity__queue">
                {queue.map((item) => (
                  <article key={item.id} className={`v2-activity__queue-row v2-activity__queue-row--${item.kind}${item.kind === 'decision' && ruledDecisions[item.id] ? ' v2-activity__queue-row--settled' : ''}`}>
                    <span className="v2-activity__queue-mark" aria-hidden="true">
                      {item.kind === 'mention' ? '@' : item.kind === 'approval' ? '!' : '?'}
                    </span>
                    <div className="v2-activity__queue-copy">
                      {item.kind !== 'mention' && <div className="v2-activity__queue-kind">{t(`activity.needsYou.kinds.${item.kind}`)}</div>}
                      <div className="v2-activity__queue-topline">
                        <strong>{item.kind === 'mention' && item.actorName ? item.actorName : item.title}</strong>
                        <span>{item.podName}{item.timestamp ? ` · ${relativeTime(item.timestamp)}` : ''}</span>
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
                          <div className="v2-activity__reply" data-testid="queue-reply">
                            <textarea
                              className="v2-activity__reply-input"
                              rows={2}
                              placeholder={t('activity.reply.placeholder')}
                              value={replyDrafts[item.id] || ''}
                              onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))}
                              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendReply(item); }}
                              disabled={replyingId === item.id}
                            />
                            <button
                              type="button"
                              onClick={() => sendReply(item)}
                              disabled={replyingId === item.id || !(replyDrafts[item.id] || '').trim()}
                            >
                              {replyingId === item.id ? t('activity.reply.working') : repliedIds.has(item.id) ? t('activity.reply.sent') : t('activity.reply.send')}
                            </button>
                          </div>
                          <button type="button" className="v2-activity__queue-action--thread" onClick={() => acknowledgeMention(item)} disabled={acknowledgingMentionId === item.id}>
                            {acknowledgingMentionId === item.id ? t('activity.mention.working') : t('activity.mention.acknowledge')}
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
              <h2 id="activity-agents">{t('activity.agents.title')}</h2>
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
              <h2 id="activity-board">{t('activity.board.title')}</h2>
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
        </>
      )}
      <footer className="v2-activity__footer">{t('activity.footer')}</footer>
    </div>
  );
};

export default V2ActivityPage;
