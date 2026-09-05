import React from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { V2Message } from '../hooks/useV2PodDetail';
import { UseV2ThreadState } from '../hooks/useV2ThreadState';
import { ThreadViewItem } from '../utils/threadView';
import { isGroupedWithPrevious } from '../utils/messageGrouping';
import V2MessageRow from './V2MessageRow';
import V2ThreadCard from './V2ThreadCard';
import { V2DecisionCardData, V2DecisionRuling } from './V2DecisionCard';

interface V2ThreadMessagesProps {
  messages: V2Message[];
  threadView: ThreadViewItem[];
  threadState: Pick<UseV2ThreadState, 'byRoot' | 'toggleCollapsed' | 'toggleFollowing'>;
  decisionByMessageId: Map<string, V2DecisionCardData>;
  settledDecisionByMessageId: Map<string, V2DecisionRuling>;
  agentDisplayNames: Map<string, string>;
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
  loading,
  error,
  starterPanel,
  emptyState,
  agentDeliveryHint,
  messagesContainerRef,
  messagesEndRef,
}) => {
  const { t } = useTranslation();

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
      {hasMore && (
        <div className="v2-chat__older">
          <button
            type="button"
            className="v2-chat__older-btn"
            onClick={onLoadOlder}
            disabled={loadingOlder}
          >
            {loadingOlder ? t('podChat.loadingOlder') : t('podChat.loadOlder')}
          </button>
        </div>
      )}
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
        return (
          <div className="v2-thread-block" key={`thread-${item.rootId}`}>
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
                {item.replies.map((reply, replyIndex) => (
                  <V2MessageRow
                    key={reply.id}
                    message={reply}
                    decision={decisionByMessageId.get(String(reply.id))}
                    onDecisionRuled={onDecisionRuled}
                    agentDisplayNames={agentDisplayNames}
                    agentAuthorKeys={agentAuthorKeys}
                    onAuthorClick={onAuthorClick}
                    onOpenFile={onOpenFile}
                    onReply={onReply}
                    onThread={onThread}
                    grouped={isGroupedWithPrevious(reply, item.replies[replyIndex - 1])}
                    insideThreadRoot={item.rootId}
                  />
                ))}
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
            )}
          </div>
        );
      })}
      <div ref={messagesEndRef} />
    </div>
  );
};

export default V2ThreadMessages;
