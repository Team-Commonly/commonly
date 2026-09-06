import React from 'react';
import V2Avatar from './V2Avatar';
import { shortTimeSince } from '../utils/shortTime';

/**
 * The thread chip (direction C, Thread states board — @ux-lead 64476).
 *
 * Renders under its root while the thread is collapsed: up to three 16px
 * faces, `N replies` and `· last <age>` — and nothing else. No chevron, no
 * reply button, no follow toggle: those live in the expanded band's foot
 * (V2ThreadMessages). The chip is a door, not a preview — no reply bodies,
 * no names.
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

interface V2ThreadCardProps {
  replyCount: number;
  participants: V2ThreadParticipant[];
  lastActivityAt?: string | null;
  collapsed: boolean;
  /** An item in this thread addresses me. The card's only use of accent. */
  addressed?: boolean;
  onToggleCollapsed: () => void;
  /** Injected in tests so the stamp is about boundaries, not about the clock. */
  now?: Date;
}

const MAX_AVATARS = 3;

const V2ThreadCard: React.FC<V2ThreadCardProps> = ({
  replyCount,
  participants,
  lastActivityAt,
  collapsed,
  addressed = false,
  onToggleCollapsed,
  now,
}) => {
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
        // The accessible name carries the state — there is no visual cue for it.
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
                tone="flat"
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
        {stamp && <span className="v2-thread-card__time">· last {stamp}</span>}
      </button>
    </div>
  );
};

export default V2ThreadCard;
