import React from 'react';
import { useTranslation } from 'react-i18next';
import V2Avatar from './V2Avatar';

/**
 * The thread chip (direction C, Thread states board — @ux-lead 64476).
 *
 * Renders under its root while the thread is collapsed. No chevron, no reply
 * button, no follow toggle: those live in the expanded band's foot
 * (V2ThreadMessages).
 *
 * The chip previews its latest reply. Ruling D278 (2026-11-09) superseded
 * 64476's "the chip is a door, not a preview — no reply bodies, no names":
 * answers to a mention now land in the mention's thread, so the main channel
 * has to show that an answer arrived. One line, tappable as a whole: the
 * latest replier's 16px face and name, the reply as one ellipsized line,
 * `· N replies`, and `N new` when this person has replies they haven't read.
 * Only the preview gives way at narrow widths; the count never wraps.
 *
 * `collapsed` is a prop, never derived here; the resting state is the chip
 * and V2ThreadMessages owns which roots are open.
 */
export interface V2ThreadParticipant {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  isBot?: boolean;
}

export interface V2ThreadCardLatestReply extends V2ThreadParticipant {
  /** One line of plain text; empty for a card with no summary. */
  text: string;
  isCard?: boolean;
}

interface V2ThreadCardProps {
  replyCount: number;
  participants: V2ThreadParticipant[];
  /** The newest reply. Absent on older call sites: the chip shows a face and the count. */
  latestReply?: V2ThreadCardLatestReply | null;
  /** Replies this person hasn't read (D278). 0 shows no mark. */
  unreadCount?: number;
  collapsed: boolean;
  /** An item in this thread addresses me. */
  addressed?: boolean;
  onToggleCollapsed: () => void;
}

const V2ThreadCard: React.FC<V2ThreadCardProps> = ({
  replyCount,
  participants,
  latestReply = null,
  unreadCount = 0,
  collapsed,
  addressed = false,
  onToggleCollapsed,
}) => {
  const { t } = useTranslation();
  const face: V2ThreadParticipant | undefined = latestReply || participants[0];
  const countLabel = t('podChat.thread.replyCount', { count: replyCount });
  const unread = Math.max(0, unreadCount);
  const previewText = latestReply
    ? (latestReply.text || (latestReply.isCard ? t('podChat.thread.sentCard') : ''))
    : '';
  // Label in name (WCAG 2.5.3): every piece of the visible line — the name,
  // the preview, the count, the unread mark — is in the accessible name.
  let summary = countLabel;
  if (latestReply && previewText) {
    summary = t('podChat.thread.latestFrom', { replies: countLabel, name: latestReply.name, text: previewText });
  } else if (latestReply) {
    summary = t('podChat.thread.latestFromNoText', { replies: countLabel, name: latestReply.name });
  }
  if (unread > 0) summary = t('podChat.thread.unreadSummary', { summary, count: unread });

  return (
    <div
      className={`v2-thread-card${collapsed ? '' : ' v2-thread-card--expanded'}${addressed ? ' v2-thread-card--addressed' : ''}${unread > 0 ? ' v2-thread-card--unread' : ''}`}
      data-testid="v2-thread-card"
    >
      <button
        type="button"
        className="v2-thread-card__main v2-msg__thread-chip"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        // The accessible name carries the state, then everything the line
        // shows: replier, preview, count and what's unread.
        aria-label={collapsed
          ? t('podChat.thread.expandAria', { replies: summary })
          : t('podChat.thread.collapseAria', { replies: summary })}
      >
        {face && (
          <span className="v2-thread-card__faces" aria-hidden="true">
            <V2Avatar
              key={face.userId}
              name={face.name}
              src={face.avatarUrl || undefined}
              size="sm"
              tone="flat"
              kind={typeof face.isBot === 'boolean' ? (face.isBot ? 'agent' : 'human') : undefined}
              seed={face.userId}
            />
          </span>
        )}
        {latestReply && (
          <>
            <span className="v2-thread-card__name">{latestReply.name}</span>
            {previewText && <span className="v2-thread-card__preview">{previewText}</span>}
            <span className="v2-thread-card__sep" aria-hidden="true">·</span>
          </>
        )}
        <span className="v2-thread-card__count">
          {addressed && <span className="v2-thread-card__dot" aria-hidden="true" />}
          {countLabel}
        </span>
        {unread > 0 && (
          <span className="v2-thread-card__unread">
            <span className="v2-thread-card__dot" aria-hidden="true" />
            {t('podChat.thread.unreadCount', { count: unread })}
          </span>
        )}
      </button>
    </div>
  );
};

export default V2ThreadCard;
