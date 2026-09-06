import React from 'react';
import { useTranslation } from 'react-i18next';
import { V2Message } from '../hooks/useV2PodDetail';

export interface V2RenderedReaction {
  emoji: string;
  count: number;
  mine: boolean;
  users?: Array<{ id: string; username: string; displayName?: string }>;
}

interface V2MessageActionsProps {
  message: V2Message;
  author: string;
  onReply?: (message: V2Message) => void;
  onThread?: (message: V2Message) => void;
  canInteract: boolean;
  pickerOpen: boolean;
  reactions: V2RenderedReaction[];
  onTogglePicker: () => void;
  onToggleReaction: (emoji: string, mine: boolean) => void;
}

const REACTION_PALETTE = ['👍', '❤️', '🔥', '🤔', '👀', '🚀'];

/** The row-level action affordances, kept out of the message content flow. */
const V2MessageActions: React.FC<V2MessageActionsProps> = ({
  message,
  author,
  onReply,
  onThread,
  canInteract,
  pickerOpen,
  reactions,
  onTogglePicker,
  onToggleReaction,
}) => {
  const { t } = useTranslation();
  if (!onReply && !onThread && !canInteract) return null;

  return (
    <div
      className="v2-msg__actions"
      role="toolbar"
      aria-label="Message actions"
      onClick={(event) => event.stopPropagation()}
    >
      {onReply && (
        <button
          type="button"
          className="v2-msg__action"
          aria-label={`Reply to ${author}`}
          title={`Reply to ${author}`}
          onClick={() => onReply(message)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 17 4 12 9 7" />
            <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
          </svg>
        </button>
      )}
      {onThread && (
        <button
          type="button"
          className="v2-msg__action"
          aria-label={`${t('podChat.thread.startThread')} from ${author}`}
          title={t('podChat.thread.startThread')}
          onClick={() => onThread(message)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      )}
      {canInteract && (
        <span className="v2-msg__action-wrap">
          <button
            type="button"
            className="v2-msg__action"
            aria-label="Add reaction"
            title="Add reaction"
            onClick={onTogglePicker}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>
          {pickerOpen && (
            <span className="v2-msg__reaction-picker" role="menu">
              {REACTION_PALETTE.map((emoji) => {
                const existing = reactions.find((reaction) => reaction.emoji === emoji);
                const mine = Boolean(existing?.mine);
                return (
                  <button
                    key={emoji}
                    type="button"
                    role="menuitem"
                    className={`v2-msg__reaction-picker-item${mine ? ' v2-msg__reaction-picker-item--mine' : ''}`}
                    onClick={() => onToggleReaction(emoji, mine)}
                  >
                    {emoji}
                  </button>
                );
              })}
            </span>
          )}
        </span>
      )}
    </div>
  );
};

export default V2MessageActions;
