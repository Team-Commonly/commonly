import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { HistorySearchState, V2Message, V2Start } from '../hooks/useV2PodDetail';
import { UseV2ThreadState } from '../hooks/useV2ThreadState';
import { WELCOME_HOSTED_ACTION, type WelcomeHostedStartState } from '../hooks/useWelcomeHostedStart';
import { ThreadViewItem } from '../utils/threadView';
import { isGroupedWithPrevious } from '../utils/messageGrouping';
import V2MessageRow from './V2MessageRow';
import V2ThreadCard from './V2ThreadCard';
import V2Avatar from './V2Avatar';
import { ShellGlyph } from '../icons/glyphs';
import { formatRelativeTime } from '../utils/grouping';
import { V2DecisionCardData, V2DecisionRuling } from './V2DecisionCard';

// Expanded threads show the newest eight; a `N more replies` line reveals the rest.
const MAX_EXPANDED_REPLIES = 8;

interface V2ThreadMessagesProps {
  messages: V2Message[];
  threadView: ThreadViewItem[];
  threadState: Pick<UseV2ThreadState, 'byRoot' | 'toggleCollapsed' | 'toggleFollowing'> & Partial<Pick<UseV2ThreadState, 'setCollapsed'>>;
  decisionByMessageId: Map<string, V2DecisionCardData>;
  settledDecisionByMessageId: Map<string, V2DecisionRuling>;
  agentDisplayNames: Map<string, string>;
  agentTags?: Map<string, string>;
  agentAuthorKeys: Set<string>;
  onAuthorClick?: (author: string) => void;
  onOpenFile?: (fileName: string) => void;
  onReply?: (message: V2Message) => void;
  onThread?: (message: V2Message) => void;
  // Scout's starts, keyed by the message that offers them; already filtered to
  // the ones still available to this person (V2Thread).
  startsByMessageId?: Map<string, V2Start[]>;
  onStart?: (start: V2Start, messageId: string) => void;
  startsDisabled?: boolean;
  // The welcome's hosted start while it runs in place, or after it failed.
  hostedStart?: WelcomeHostedStartState;
  onQuoteNavigate?: (messageId: string | number) => void;
  onDecisionRuled?: (decisionId: string, ruling: V2DecisionRuling) => void;
  onAimAtThread: (rootId: string, preview: string) => void;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  // Direction C history edge: the sentinel V2Thread observes to auto-load the
  // previous page when the reader reaches the top.
  edgeRef?: React.RefObject<HTMLDivElement | null>;
  // Jump-to-latest pill: messages that arrived while the reader was scrolled up.
  jumpCount?: number;
  // Mount the pill once the reader is a viewport up, even before arrivals.
  showJump?: boolean;
  onJump?: () => void;
  /**
   * A message id the reader is landing on (quote link, Activity) that is not
   * in the DOM because its thread is collapsed or folded behind `N more
   * replies`. The transcript opens that thread in full and reports back, so
   * the landing effect can re-run — a reveal, never a history fetch
   * (sprint-review 64477).
   */
  revealMessageId?: string | null;
  onRevealed?: (messageId: string, found: boolean) => void;
  loading: boolean;
  error: string | null;
  starterPanel?: React.ReactNode;
  emptyState?: React.ReactNode;
  afterMessage?: { messageId: string; content: React.ReactNode };
  agentDeliveryHint?: { messageId: string; mentionHandle: string; wokenAgent?: string } | null;
  // A pod with no installed agent answers nothing by construction, so there is
  // no handle to suggest — a different row, in the same slot.
  noAgentsHint?: { messageId: string } | null;
  onAddAgent?: () => void;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * The transcript is intentionally separate from V2Thread's transport and
 * composer state. It owns only read order: flat rows, reply rails, and the
 * one durable decision card that can replace a request message in either.
 */
export const V2ThreadHistoryStatus: React.FC<{
  historySearch: HistorySearchState;
  onRetryHistorySearch?: () => void;
  viewport?: boolean;
}> = ({ historySearch, onRetryHistorySearch, viewport = false }) => {
  const { t } = useTranslation();
  const className = `v2-thread__history-status${viewport ? ' v2-thread__history-status--viewport' : ''}${historySearch.status === 'failed' ? ' v2-thread__history-status--error' : ''}`;
  if (historySearch.status === 'searching') {
    return (
      <div className={className} role="status" aria-live="polite">
        {t('podChat.history.searchingOlder', {
          attempt: historySearch.attempt,
          max: historySearch.maxAttempts,
        })}
      </div>
    );
  }
  if (historySearch.status === 'failed') {
    return (
      <div className={className} role="alert">
        <span>{t('podChat.history.searchOlderFailed')}</span>
        {onRetryHistorySearch && (
          <button type="button" className="v2-thread__history-retry" onClick={onRetryHistorySearch}>
            {t('podChat.history.retrySearch')}
          </button>
        )}
      </div>
    );
  }
  if (historySearch.status === 'not-found') {
    return (
      <div className={className} role="status" aria-live="polite">
        {t('podChat.history.searchOlderBound', { attempt: historySearch.attempt })}
        {onRetryHistorySearch && (
          <button type="button" className="v2-thread__history-retry" onClick={onRetryHistorySearch}>
            {t('podChat.history.retrySearch')}
          </button>
        )}
      </div>
    );
  }
  return null;
};

const V2ThreadMessages: React.FC<V2ThreadMessagesProps> = ({
  messages,
  threadView,
  threadState,
  decisionByMessageId,
  settledDecisionByMessageId,
  agentDisplayNames,
  agentTags,
  agentAuthorKeys,
  onAuthorClick,
  onOpenFile,
  onReply,
  onThread,
  startsByMessageId,
  onStart,
  startsDisabled = false,
  hostedStart = null,
  onQuoteNavigate,
  onDecisionRuled,
  onAimAtThread,
  hasMore,
  loadingOlder,
  onLoadOlder,
  edgeRef,
  jumpCount = 0,
  showJump = false,
  onJump,
  revealMessageId,
  onRevealed,
  loading,
  error,
  starterPanel,
  emptyState,
  afterMessage,
  agentDeliveryHint,
  noAgentsHint,
  onAddAgent,
  messagesContainerRef,
  messagesEndRef,
}) => {
  const { t } = useTranslation();
  // Loading → content: whatever replaces the spinner fades in once, over
  // --v2-dur. A load that never showed the spinner (an older page, a
  // reconnect catch-up) gets nothing, and a re-render never replays it.
  const showSpinner = loading && messages.length === 0;
  const spinnerShownRef = useRef(showSpinner);
  const [revealed, setRevealed] = useState(false);
  useLayoutEffect(() => {
    if (showSpinner) {
      spinnerShownRef.current = true;
      setRevealed(false);
    } else if (spinnerShownRef.current) {
      spinnerShownRef.current = false;
      setRevealed(true);
    }
  }, [showSpinner]);
  // Expanded threads show the newest MAX_EXPANDED_REPLIES; "N more replies"
  // reveals the rest for that root (walk-3 §3).
  const [expandedAll, setExpandedAll] = useState<Set<string>>(() => new Set());
  // The resting state of a thread is the chip (ux-lead 64476 (4)). Which
  // roots are open is a session gesture held here; the server `collapsed`
  // row is written to match on each open/close (it still drives the wake
  // path), but a fresh mount always shows chips.
  const [openRoots, setOpenRoots] = useState<Set<string>>(() => new Set());
  // A run of claim lines folds to one summary row; this is the open ones.
  const [openClaimRuns, setOpenClaimRuns] = useState<Set<string>>(() => new Set());
  const toggleClaimRun = useCallback((key: string) => {
    setOpenClaimRuns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const setOpen = useCallback((rootId: string, open: boolean) => {
    setOpenRoots((current) => {
      const next = new Set(current);
      if (open) next.add(rootId); else next.delete(rootId);
      return next;
    });
    threadState.setCollapsed?.(rootId, !open);
  }, [threadState]);

  // Landing on a folded reply: open its thread, drop the `N more replies`
  // fold, then tell the caller so it can land on the now-rendered row.
  useEffect(() => {
    if (!revealMessageId) return;
    const target = String(revealMessageId);
    const owner = threadView.find((item) => item.kind === 'card'
      && (item.rootId === target || item.replies.some((reply) => String(reply.id) === target)));
    if (owner && owner.kind === 'card') {
      setOpenRoots((current) => (current.has(owner.rootId) ? current : new Set(current).add(owner.rootId)));
      setExpandedAll((current) => (current.has(owner.rootId) ? current : new Set(current).add(owner.rootId)));
    }
    onRevealed?.(target, Boolean(owner));
  }, [revealMessageId, threadView, onRevealed]);

  const rootPreview = (rootId: string): string => String(
    messages.find((message) => String(message.id) === rootId)?.content || '',
  );

  const rulingMessage = (source: V2Message, ruling: V2DecisionRuling): V2Message => {
    // `chooseDecision` creates an ordinary PG reply before acknowledging the
    // choice, so a socket-connected view normally already has this durable
    // row. Reuse it for valid reactions, timestamps, and identity; the small
    // fallback only covers the short response-before-socket race.
    const durable = ruling.messageId
      ? messages.find((message) => String(message.id) === String(ruling.messageId))
      : undefined;
    if (durable) return durable;
    return {
      ...source,
      id: `decision-ruling-${source.id}`,
      user_id: 'decision-ruling',
      content: ruling.value,
      created_at: ruling.at || source.created_at,
      createdAt: ruling.at || source.createdAt,
      user: { username: ruling.by || t('common.you'), isBot: false },
      replyTo: null,
      reply_msg_id: null,
      reply_content: null,
      reply_username: null,
    };
  };

  // A settled ruling keeps the ordinary reply id it created when the choice
  // was acknowledged. When that source request is rendered inside an
  // expanded thread, replace the request with the ruling and omit the
  // durable reply row so the answer appears once with the ruled marker.
  const renderedReplyEntries = (replies: V2Message[]) => {
    const visibleReplyIds = new Set(replies.map((reply) => String(reply.id)));
    const settledRulingReplyIds = new Set(
      Array.from(settledDecisionByMessageId.entries())
        .filter(([sourceId, ruling]) => visibleReplyIds.has(String(sourceId)) && ruling.messageId)
        .map(([, ruling]) => String(ruling.messageId)),
    );
    return replies
      .filter((reply) => (
        !settledRulingReplyIds.has(String(reply.id))
        || settledDecisionByMessageId.has(String(reply.id))
      ))
      .map((reply) => {
        const settledRuling = settledDecisionByMessageId.get(String(reply.id));
        return {
          sourceId: String(reply.id),
          message: settledRuling ? rulingMessage(reply, settledRuling) : reply,
          ruling: settledRuling,
        };
      });
  };

  return (
    <div className={`v2-chat__messages${revealed ? ' v2-chat__messages--reveal' : ''}`} ref={messagesContainerRef}>
      {/* History edge: one mono line. Loads on scroll (observer in V2Thread);
          the button form stays reachable by keyboard. */}
      <div className="v2-thread__edge" ref={edgeRef} data-state={loadingOlder ? 'loading' : hasMore ? 'more' : messages.length > 0 ? 'beginning' : 'empty'}>
        {loadingOlder ? (
          <span className="v2-thread__edge-line" role="status">{t('podChat.history.loadingEarlier')}</span>
        ) : hasMore ? (
          <button type="button" className="v2-thread__edge-line" onClick={onLoadOlder}>{t('podChat.history.loadEarlier')}</button>
        ) : messages.length > 0 ? (
          <span className="v2-thread__edge-line">{t('podChat.history.beginning')}</span>
        ) : null}
      </div>
      {error && <div className="v2-chat__error">{error}</div>}
      {showSpinner && <div className="v2-empty"><span className="v2-spinner" /></div>}
      {starterPanel}
      {emptyState}
      {threadView.map((item, index, view) => {
        const renderMessage = (message: V2Message, previous: ThreadViewItem | undefined) => {
          // A held agent answers the welcome click with no install, so the
          // running line must not depend on the start carrying its limits.
          const liveHosted = hostedStart?.status === 'live' && hostedStart.messageId === String(message.id)
            ? hostedStart
            : null;
          const liveHostedCaps = liveHosted
            ? message.payload?.starts?.find((start) => start.action === WELCOME_HOSTED_ACTION)?.caps
            : undefined;
          const settledRuling = settledDecisionByMessageId.get(String(message.id));
          const renderedMessage = settledRuling ? rulingMessage(message, settledRuling) : message;
          const previousMessage = previous && previous.kind === 'message'
            ? (() => {
              const previousRuling = settledDecisionByMessageId.get(String(previous.message.id));
              return previousRuling ? rulingMessage(previous.message, previousRuling) : previous.message;
            })()
            : undefined;
          return (
            <React.Fragment key={message.id}>
              <V2MessageRow
                message={renderedMessage}
                sourceMessageId={settledRuling ? message.id : undefined}
                decision={settledRuling ? undefined : decisionByMessageId.get(String(message.id))}
                isDecisionRuling={Boolean(settledRuling)}
                onDecisionRuled={onDecisionRuled}
                agentDisplayNames={agentDisplayNames}
                agentTags={agentTags}
                agentAuthorKeys={agentAuthorKeys}
                onAuthorClick={onAuthorClick}
                onOpenFile={onOpenFile}
                onReply={onReply}
                onThread={onThread}
                onQuoteNavigate={onQuoteNavigate}
                grouped={isGroupedWithPrevious(renderedMessage, previousMessage)}
              />
              {onStart && (startsByMessageId?.get(String(message.id))?.length ?? 0) > 0 && (
                <div className="v2-chat__starts" role="group" aria-label={t('podChat.starts.label')}>
                  {startsByMessageId?.get(String(message.id))?.map((start) => {
                    const hostedHere = start.action === WELCOME_HOSTED_ACTION
                      && hostedStart?.messageId === String(message.id) ? hostedStart : null;
                    const starting = hostedHere?.status === 'starting';
                    return (
                      <React.Fragment key={start.id}>
                        <button
                          type="button"
                          className={`v2-chat__start${start.action === WELCOME_HOSTED_ACTION ? ' v2-chat__start--primary' : ''}`}
                          disabled={startsDisabled || starting}
                          aria-busy={starting || undefined}
                          onClick={() => onStart(start, String(message.id))}
                        >
                          {starting ? t('agentByo.actions.starting') : t(`podChat.starts.labels.${start.id}`, { defaultValue: start.label })}
                        </button>
                        {hostedHere?.status === 'failed' && (
                          <p className="v2-chat__start-note v2-chat__start-note--error" role="alert">{hostedHere.error}</p>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
              {liveHosted && (
                <p className="v2-chat__start-note" role="status">
                  {t('agentByo.hosted.running', { name: liveHosted.agentName })}
                  {liveHostedCaps && (
                    <>
                      {' '}
                      {t('agentByo.compact.limits', { agents: liveHostedCaps.agentsPerUser, turns: liveHostedCaps.turnsPerDay })}
                    </>
                  )}
                </p>
              )}
              {afterMessage?.messageId === String(message.id) && afterMessage.content}
              {agentDeliveryHint?.messageId === message.id && (
                <div className="v2-chat__delivery-hint" role="status">
                  <Trans
                    i18nKey={agentDeliveryHint.wokenAgent ? 'podChat.deliveryHintOthers' : 'podChat.deliveryHint'}
                    values={{ handle: agentDeliveryHint.mentionHandle, woken: agentDeliveryHint.wokenAgent }}
                    components={{ handle: <strong /> }}
                  />
                </div>
              )}
              {noAgentsHint?.messageId === message.id && (
                <div className="v2-chat__no-agents" role="status">
                  <div className="v2-chat__no-agents-kicker">{t('podChat.noAgentsInPod.kicker')}</div>
                  <div className="v2-chat__no-agents-body">{t('podChat.noAgentsInPod.body')}</div>
                  {onAddAgent && (
                    <button
                      type="button"
                      className="v2-chat__no-agents-action"
                      onClick={onAddAgent}
                    >
                      {t('podChat.noAgentsInPod.action')}
                    </button>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        };

        if (item.kind === 'claims') {
          const open = openClaimRuns.has(item.key);
          const first = item.messages[0].payload?.taskId ?? '';
          const last = item.messages[item.messages.length - 1].payload?.taskId ?? '';
          // D215 .sumrow: up to four distinct claimers' faces and the run's
          // last time. The accessible name stays the one-line label.
          const claimers = item.messages.filter((message, claimIndex) => item.messages
            .findIndex((other) => (other.user_id || other.payload?.actorName) === (message.user_id || message.payload?.actorName)) === claimIndex)
            .slice(0, 4);
          const lastAt = item.messages[item.messages.length - 1].created_at;
          return (
            <div className="v2-claim-run" key={`claims-${item.key}`}>
              <button
                type="button"
                className="v2-claim-run__toggle"
                aria-expanded={open}
                aria-label={t('podChat.claimRun.label', { count: item.messages.length, first, last })}
                onClick={() => toggleClaimRun(item.key)}
              >
                <ShellGlyph name="board" size={18} />
                <span className="v2-claim-run__faces" aria-hidden="true">
                  {claimers.map((message) => (
                    <V2Avatar
                      key={String(message.id)}
                      name={message.payload?.actorName || message.user?.username || ''}
                      src={message.user?.profile_picture || undefined}
                      size="sm"
                      tone="flat"
                      kind={message.user?.isBot === false ? 'human' : 'agent'}
                      seed={message.user_id || undefined}
                    />
                  ))}
                </span>
                <span className="v2-claim-run__label" aria-hidden="true">
                  <b>{t('podChat.claimRun.count', { count: item.messages.length })}</b>
                  {' · '}
                  {t('podChat.claimRun.range', { first, last })}
                </span>
                {lastAt && <span className="v2-claim-run__time" aria-hidden="true">{formatRelativeTime(lastAt)}</span>}
                <span className="v2-claim-run__chev" aria-hidden="true"><ShellGlyph name="chevron" size={15} /></span>
              </button>
              {open && (
                <div className="v2-claim-run__list">
                  {item.messages.map((message, claimIndex) => renderMessage(
                    message,
                    claimIndex === 0 ? view[index - 1] : { kind: 'message', message: item.messages[claimIndex - 1] },
                  ))}
                </div>
              )}
            </div>
          );
        }

        if (item.kind === 'message') {
          const next = view[index + 1];
          // A root with a live thread renders INSIDE its band (below), so the
          // root and its replies share one surface — ux-lead 64476 (2).
          if (next && next.kind === 'card' && next.rootId === String(item.message.id)
            && !settledDecisionByMessageId.has(next.rootId)) return null;
          return renderMessage(item.message, view[index - 1]);
        }

        const state = threadState.byRoot.get(item.rootId);
        // The request source has already transformed into the human's ruling
        // in the flat transcript above. Its durable reply remains in the
        // server list, but rendering both would show the same pick twice.
        if (settledDecisionByMessageId.has(item.rootId)) return null;
        const rootItem = view[index - 1];
        const rootMessage = rootItem && rootItem.kind === 'message' && String(rootItem.message.id) === item.rootId
          ? rootItem.message
          : messages.find((message) => String(message.id) === item.rootId);
        const collapsed = !openRoots.has(item.rootId);
        const shownReplies = collapsed || expandedAll.has(item.rootId) || item.replies.length <= MAX_EXPANDED_REPLIES
          ? item.replies
          : item.replies.slice(item.replies.length - MAX_EXPANDED_REPLIES);
        const hiddenReplies = item.replies.length - shownReplies.length;
        const hiddenHasAfter = hiddenReplies > 0
          && item.replies.slice(0, hiddenReplies).some((reply) => String(reply.id) === afterMessage?.messageId);
        const following = state ? state.following : null;
        const followLabel = following === true ? t('podChat.thread.following') : following === false ? t('podChat.thread.muted') : t('podChat.thread.follow');
        return (
          <div className={`v2-thread-block${collapsed ? '' : ' v2-thread-block--open'}`} key={`thread-${item.rootId}`}>
            {rootMessage && renderMessage(rootMessage, view[index - 2])}
            <div className="v2-thread-block__inner">
            {collapsed && (
              <V2ThreadCard
                replyCount={item.replyCount}
                participants={item.participants}
                lastActivityAt={item.lastActivityAt}
                collapsed
                onToggleCollapsed={() => setOpen(item.rootId, true)}
              />
            )}
            {!collapsed && (
              <div
                className="v2-thread-replies"
                role="group"
                aria-label={t('podChat.thread.groupLabel', {
                  count: item.replyCount,
                  unit: item.replyCount === 1 ? t('podChat.thread.replyOne') : t('podChat.thread.replyOther'),
                })}
              >
                {hiddenReplies > 0 && (
                  <button type="button" className="v2-thread-replies__more" onClick={() => setExpandedAll((current) => new Set(current).add(item.rootId))}>
                    {t('podChat.thread.moreReplies', { count: hiddenReplies })}
                  </button>
                )}
                {hiddenHasAfter && afterMessage?.content}
                {renderedReplyEntries(shownReplies).map(({ sourceId, message: reply, ruling }, replyIndex, renderedReplies) => (
                  <React.Fragment key={reply.id}>
                  <V2MessageRow
                    message={reply}
                    sourceMessageId={ruling ? sourceId : undefined}
                    decision={ruling ? undefined : decisionByMessageId.get(sourceId)}
                    isDecisionRuling={Boolean(ruling)}
                    onDecisionRuled={onDecisionRuled}
                    agentDisplayNames={agentDisplayNames}
                    agentTags={agentTags}
                    agentAuthorKeys={agentAuthorKeys}
                    onAuthorClick={onAuthorClick}
                    onOpenFile={onOpenFile}
                    onReply={onReply}
                    onThread={onThread}
                    onQuoteNavigate={onQuoteNavigate}
                    grouped={isGroupedWithPrevious(reply, renderedReplies[replyIndex - 1]?.message)}
                    insideThreadRoot={item.rootId}
                  />
                  {afterMessage?.messageId === sourceId && afterMessage.content}
                  </React.Fragment>
                ))}
                <div className="v2-thread-replies__foot">
                  {onReply && (
                    <button
                      type="button"
                      className="v2p-b v2p-b-s v2p-b-sm v2-thread-replies__aim"
                      aria-label={t('podChat.thread.replyFromExpandedThread')}
                      onClick={() => onAimAtThread(item.rootId, rootPreview(item.rootId))}
                    >
                      <ShellGlyph name="reply" size={16} />
                      {t('podChat.thread.replyInThread')}
                    </button>
                  )}
                  <button type="button" className="v2p-b v2p-b-g v2p-b-sm v2-thread-replies__collapse" onClick={() => setOpen(item.rootId, false)}>
                    <ShellGlyph name="chevron" size={16} />
                    {t('podChat.thread.collapse')}
                  </button>
                  <span className="v2-thread-replies__count">{item.replyCount} {item.replyCount === 1 ? t('podChat.thread.replyOne') : t('podChat.thread.replyOther')}</span>
                  <button
                    type="button"
                    className={`v2-thread-replies__follow${following === true ? ' v2-thread-replies__follow--on' : ''}${following === false ? ' v2-thread-replies__follow--muted' : ''}`}
                    aria-pressed={following === true}
                    onClick={() => threadState.toggleFollowing(item.rootId)}
                  >
                    {followLabel}
                  </button>
                </div>
              </div>
            )}
            </div>
            {collapsed && item.replies.some((reply) => String(reply.id) === afterMessage?.messageId) && afterMessage?.content}
          </div>
        );
      })}
      <div ref={messagesEndRef} />
      {onJump && (showJump || jumpCount > 0) && (
        <div className="v2-thread__jump-wrap">
          <button type="button" className="v2-thread__jump" onClick={onJump}>
            {t('podChat.history.jumpToLatest')}
            {jumpCount > 0 && <span className="v2-thread__jump-count">· {jumpCount}</span>}
          </button>
        </div>
      )}
    </div>
  );
};

export default V2ThreadMessages;
