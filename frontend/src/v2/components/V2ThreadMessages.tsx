import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { V2Message } from '../hooks/useV2PodDetail';
import { UseV2ThreadState } from '../hooks/useV2ThreadState';
import { ThreadViewItem } from '../utils/threadView';
import { isGroupedWithPrevious } from '../utils/messageGrouping';
import V2MessageRow from './V2MessageRow';
import V2ThreadCard from './V2ThreadCard';
import { V2DecisionCardData, V2DecisionRuling } from './V2DecisionCard';

// Expanded threads show the newest eight; a `N more replies` line reveals the rest.
const MAX_EXPANDED_REPLIES = 8;

interface V2ThreadMessagesProps {
  messages: V2Message[];
  threadView: ThreadViewItem[];
  threadState: Pick<UseV2ThreadState, 'byRoot' | 'toggleCollapsed' | 'toggleFollowing'>;
  decisionByMessageId: Map<string, V2DecisionCardData>;
  settledDecisionByMessageId: Map<string, V2DecisionRuling>;
  agentDisplayNames: Map<string, string>;
  agentTags?: Map<string, string>;
  agentAuthorKeys: Set<string>;
  onAuthorClick?: (author: string) => void;
  onOpenFile?: (fileName: string) => void;
  onReply?: (message: V2Message) => void;
  onThread?: (message: V2Message) => void;
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
  loading: boolean;
  error: string | null;
  starterPanel?: React.ReactNode;
  emptyState?: React.ReactNode;
  agentDeliveryHint?: { messageId: string; mentionHandle: string } | null;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * The transcript is intentionally separate from V2Thread's transport and
 * composer state. It owns only read order: flat rows, reply rails, and the
 * one durable decision card that can replace a request message in either.
 */
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
  onDecisionRuled,
  onAimAtThread,
  hasMore,
  loadingOlder,
  onLoadOlder,
  edgeRef,
  jumpCount = 0,
  showJump = false,
  onJump,
  loading,
  error,
  starterPanel,
  emptyState,
  agentDeliveryHint,
  messagesContainerRef,
  messagesEndRef,
}) => {
  const { t } = useTranslation();
  // Expanded threads show the newest MAX_EXPANDED_REPLIES; "N more replies"
  // reveals the rest for that root (walk-3 §3).
  const [expandedAll, setExpandedAll] = useState<Set<string>>(() => new Set());

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

  return (
    <div className="v2-chat__messages" ref={messagesContainerRef}>
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
      {loading && messages.length === 0 && <div className="v2-empty"><span className="v2-spinner" /></div>}
      {starterPanel}
      {emptyState}
      {threadView.map((item, index, view) => {
        if (item.kind === 'message') {
          const message = item.message;
          const previous = view[index - 1];
          const settledRuling = settledDecisionByMessageId.get(String(message.id));
          return (
            <React.Fragment key={message.id}>
              <V2MessageRow
                message={settledRuling ? rulingMessage(message, settledRuling) : message}
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
                grouped={isGroupedWithPrevious(
                  message,
                  previous && previous.kind === 'message' ? previous.message : undefined,
                )}
              />
              {agentDeliveryHint?.messageId === message.id && (
                <div className="v2-chat__delivery-hint" role="status">
                  <Trans
                    i18nKey="podChat.deliveryHint"
                    values={{ handle: agentDeliveryHint.mentionHandle }}
                    components={{ handle: <strong /> }}
                  />
                </div>
              )}
            </React.Fragment>
          );
        }

        const state = threadState.byRoot.get(item.rootId);
        // The request source has already transformed into the human's ruling
        // in the flat transcript above. Its durable reply remains in the
        // server list, but rendering both would show the same pick twice.
        if (settledDecisionByMessageId.has(item.rootId)) return null;
        // A missing state row is not permission to invent a collapsed thread.
        const collapsed = state ? state.collapsed : false;
        const shownReplies = collapsed || expandedAll.has(item.rootId) || item.replies.length <= MAX_EXPANDED_REPLIES
          ? item.replies
          : item.replies.slice(item.replies.length - MAX_EXPANDED_REPLIES);
        const hiddenReplies = item.replies.length - shownReplies.length;
        return (
          <div className={`v2-thread-block${collapsed ? '' : ' v2-thread-block--open'}`} key={`thread-${item.rootId}`}>
            <V2ThreadCard
              replyCount={item.replyCount}
              participants={item.participants}
              lastActivityAt={item.lastActivityAt}
              collapsed={collapsed}
              following={state ? state.following : null}
              onToggleCollapsed={() => threadState.toggleCollapsed(item.rootId)}
              onToggleFollowing={() => threadState.toggleFollowing(item.rootId)}
              onReplyInThread={onReply ? () => onAimAtThread(item.rootId, rootPreview(item.rootId)) : undefined}
            />
            {!collapsed && (
              <div className="v2-thread-replies">
                {hiddenReplies > 0 && (
                  <button type="button" className="v2-thread-replies__more" onClick={() => setExpandedAll((current) => new Set(current).add(item.rootId))}>
                    {t('podChat.thread.moreReplies', { count: hiddenReplies })}
                  </button>
                )}
                {shownReplies.map((reply, replyIndex) => (
                  <V2MessageRow
                    key={reply.id}
                    message={reply}
                    decision={decisionByMessageId.get(String(reply.id))}
                    onDecisionRuled={onDecisionRuled}
                    agentDisplayNames={agentDisplayNames}
                    agentTags={agentTags}
                    agentAuthorKeys={agentAuthorKeys}
                    onAuthorClick={onAuthorClick}
                    onOpenFile={onOpenFile}
                    onReply={onReply}
                    onThread={onThread}
                    grouped={isGroupedWithPrevious(reply, shownReplies[replyIndex - 1])}
                    insideThreadRoot={item.rootId}
                  />
                ))}
                <div className="v2-thread-replies__foot">
                  <button type="button" className="v2-thread-replies__collapse" onClick={() => threadState.toggleCollapsed(item.rootId)}>
                    {t('podChat.thread.collapse')}
                  </button>
                  <span className="v2-thread-replies__count">{item.replyCount} {item.replyCount === 1 ? t('podChat.thread.replyOne') : t('podChat.thread.replyOther')}</span>
                  {onReply && (
                    <button
                      type="button"
                      className="v2-thread-replies__aim"
                      aria-label={t('podChat.thread.replyFromExpandedThread')}
                      onClick={() => onAimAtThread(item.rootId, rootPreview(item.rootId))}
                    >
                      {t('podChat.thread.replyInThread')}
                    </button>
                  )}
                </div>
              </div>
            )}
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
