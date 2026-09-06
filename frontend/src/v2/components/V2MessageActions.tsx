import React, { useEffect, useRef, useState } from 'react';
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

const Icon = ({ d, extra }: { d: string; extra?: React.ReactNode }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
    {extra}
  </svg>
);

/**
 * The row's action strip (direction C, walk-3 miss 56): react · reply · thread
 * · more, in one 28px white box at the row's top-right on hover or focus at
 * desktop widths, inline under the body on long-press at 390. Kept out of the
 * message content flow. `v2-msg__actions` stays for the existing invariants;
 * `v2-msg__strip` is the direction-C contract name.
 */
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
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const close = (event: MouseEvent) => { if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [moreOpen]);
  if (!onReply && !onThread && !canInteract) return null;

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable: nothing to show */ }
    setMoreOpen(false);
  };
  const link = typeof window !== 'undefined'
    ? `${window.location.origin}${window.location.pathname}#message-${message.id}`
    : `#message-${message.id}`;

  return (
    <div
      className="v2-msg__actions v2-msg__strip"
      role="toolbar"
      aria-label={t('podChat.strip.label')}
      onClick={(event) => event.stopPropagation()}
    >
      {/* React is the first of the four icons whenever the strip renders; it
          is disabled, not absent, when this row cannot take a reaction yet
          (no live reactions, or a non-numeric id) — ux-lead 64476 (5). */}
      <span className="v2-msg__action-wrap">
          <button
            type="button"
            className="v2-msg__action"
            aria-label={t('podChat.strip.react')}
            title={t('podChat.strip.react')}
            onClick={onTogglePicker}
            disabled={!canInteract}
          >
            <Icon d="M8 14s1.5 2 4 2 4-2 4-2" extra={<><circle cx="12" cy="12" r="10" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></>} />
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
      {onReply && (
        <button
          type="button"
          className="v2-msg__action"
          aria-label={`Reply to ${author}`}
          title={`Reply to ${author}`}
          onClick={() => onReply(message)}
        >
          <Icon d="M20 18v-2a4 4 0 0 0-4-4H4" extra={<polyline points="9 17 4 12 9 7" />} />
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
          <Icon d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </button>
      )}
      <span className="v2-msg__action-wrap" ref={moreRef}>
        <button
          type="button"
          className="v2-msg__action"
          aria-label={t('podChat.strip.more')}
          title={t('podChat.strip.more')}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <Icon d="M5 12h.01M12 12h.01M19 12h.01" />
        </button>
        {moreOpen && (
          <span className="v2-msg__more-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => copy(link)}>{t('podChat.strip.copyLink')}</button>
            <button type="button" role="menuitem" onClick={() => copy(String(message.content || ''))}>{t('podChat.strip.copyText')}</button>
          </span>
        )}
      </span>
    </div>
  );
};

export default V2MessageActions;
