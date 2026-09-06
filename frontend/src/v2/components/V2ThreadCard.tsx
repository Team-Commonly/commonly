import React from 'react';
import { useTranslation } from 'react-i18next';
import V2Avatar from './V2Avatar';
import { shortTimeSince } from '../utils/shortTime';

/**
 * The thread summary chip (direction C, walk-3 miss 54).
 *
 * Sits directly under its root message and renders INSTEAD of that root's
 * replies while collapsed: overlapping 16px face squares, `N replies` in
 * cobalt, `· last <age>` in muted mono. No chevron at rest, no separate reply
 * button in the chip, no accent dot unless something in the thread addresses
 * me — the card is a door and not a preview.
 *
 * `collapsed` is a prop, never derived here. It arrives already resolved from
 * the payload (#1145, @ux-lead 56996): a client that computed it would need
 * the threading cutoff, which is the migration detail that ruling removed from
 * the wire.
 *
 * `following` is the raw tri-state and renders three labels. Null is NOT
 * "not following" — it means the server will decide from participation — so it
 * reads "Follow" (an invitation) rather than "Muted" (a state). Shown expanded.
 */
export interface V2ThreadParticipant {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  isBot?: boolean;
}

interface V2ThreadCardProps {
  replyCount: number;
  participants: V2ThreadParticipant[];
  lastActivityAt?: string | null;
  collapsed: boolean;
  following: boolean | null;
  /** An item in this thread addresses me. The chip's only use of accent beyond the count. */
  addressed?: boolean;
  onToggleCollapsed: () => void;
  onToggleFollowing: () => void;
  /** Aim the composer at this card's root without first opening the rail. */
  onReplyInThread?: () => void;
  /** Injected in tests so the stamp is about boundaries, not about the clock. */
  now?: Date;
}

const MAX_AVATARS = 3;

const followLabel = (following: boolean | null): string => {
  if (following === true) return 'Following';
  if (following === false) return 'Muted';
  return 'Follow';
};

const followClass = (following: boolean | null): string => {
  if (following === true) return 'v2-thread-card__follow v2-thread-card__follow--on';
  if (following === false) return 'v2-thread-card__follow v2-thread-card__follow--muted';
  return 'v2-thread-card__follow';
};

const V2ThreadCard: React.FC<V2ThreadCardProps> = ({
  replyCount,
  participants,
  lastActivityAt,
  collapsed,
  following,
  addressed = false,
  onToggleCollapsed,
  onToggleFollowing,
  onReplyInThread,
  now,
}) => {
  const { t } = useTranslation();
  const shown = participants.slice(0, MAX_AVATARS);
  const stamp = shortTimeSince(lastActivityAt, now);
  const countLabel = `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;

  return (
    <div
      className={`v2-thread-card${collapsed ? '' : ' v2-thread-card--expanded'}${addressed ? ' v2-thread-card--addressed' : ''}`}
      data-testid="v2-thread-card"
    >
      <button
        type="button"
        className="v2-thread-card__main v2-msg__thread-chip"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        // The accessible name carries the state, because the visual cue for it
        // is a small chevron and a rotation is not announced.
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} thread, ${countLabel}`}
      >
        {shown.length > 0 && (
          <span className="v2-thread-card__faces" aria-hidden="true">
            {shown.map((p) => (
              <V2Avatar
                key={p.userId}
                name={p.name}
                src={p.avatarUrl || undefined}
                size="sm"
                kind={typeof p.isBot === 'boolean' ? (p.isBot ? 'agent' : 'human') : undefined}
                seed={p.userId}
              />
            ))}
          </span>
        )}
        <span className="v2-thread-card__count">
          {addressed && <span className="v2-thread-card__dot" aria-hidden="true" />}
          {countLabel}
        </span>
        {stamp && <span className="v2-thread-card__time">· {t('podChat.thread.last')} {stamp}</span>}
        {!collapsed && <span className="v2-thread-card__chevron" aria-hidden="true">⌄</span>}
      </button>

      {onReplyInThread && (
        <button
          type="button"
          className="v2-thread-card__reply"
          onClick={onReplyInThread}
        >
          {t('podChat.thread.replyInThread')}
        </button>
      )}

      {/* Follow lives outside the expand button: nesting a control inside a
          control is invalid, and a mis-hit that silently muted a thread is the
          expensive direction. Only shown expanded, per the brief. */}
      {!collapsed && (
        <button
          type="button"
          className={followClass(following)}
          onClick={onToggleFollowing}
          aria-pressed={following === true}
        >
          {followLabel(following)}
        </button>
      )}
    </div>
  );
};

export default V2ThreadCard;
