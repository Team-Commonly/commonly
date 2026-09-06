import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import V2Avatar from './V2Avatar';
import type { V2Message } from '../hooks/useV2PodDetail';

export interface V2ComposerMention {
  id: string;
  label: string;
  subtitle: string;
  avatar?: string | null;
  value: string;
}

export interface V2ComposerWarning {
  agentName: string;
  state: 'gone-dark' | 'never-connected';
  fixCommand?: string;
}

interface V2ComposerProps {
  podName: string;
  authorName: string;
  draft: string;
  sending: boolean;
  uploading: boolean;
  sendError?: string | null;
  composerError?: string | null;
  replyTarget: V2Message | null;
  threadTarget: { id: string; preview: string } | null;
  mentionOpen: boolean;
  mentionIndex: number;
  mentions: V2ComposerMention[];
  warnings: V2ComposerWarning[];
  inputRef: React.RefObject<HTMLTextAreaElement>;
  fileInputRef: React.RefObject<HTMLInputElement>;
  mentionDropdownRef: React.RefObject<HTMLDivElement>;
  onDraftChange: (value: string, cursor: number | null) => void;
  onDraftPointer: (value: string, cursor: number | null) => void;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  onMentionSelect: (item: V2ComposerMention) => void;
  onSend: () => void;
  onAttach: (file: File | null) => void;
  // Direction C plus menu: attach any file, attach an image, or paste an image
  // from the clipboard. The first two open the file input with the right
  // accept; the third reads the clipboard (falls back to the file input when
  // the browser refuses).
  onPasteFromClipboard?: () => void;
  onCancelReply: () => void;
  onCancelThread: () => void;
}

// One line at rest, five lines at most; past that the textarea scrolls.
const LINE_HEIGHT = 20;
const MAX_LINES = 5;
const VERTICAL_PADDING = 12;
const FILE_ACCEPT = 'image/*,.pdf,.md,.txt,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.zip';

/** The one bounded input surface for a workspace thread (direction C). */
const V2Composer: React.FC<V2ComposerProps> = ({
  podName,
  authorName,
  draft,
  sending,
  uploading,
  sendError,
  composerError,
  replyTarget,
  threadTarget,
  mentionOpen,
  mentionIndex,
  mentions,
  warnings,
  inputRef,
  fileInputRef,
  mentionDropdownRef,
  onDraftChange,
  onDraftPointer,
  onKeyDown,
  onMentionSelect,
  onSend,
  onAttach,
  onPasteFromClipboard,
  onCancelReply,
  onCancelThread,
}) => {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accept, setAccept] = useState(FILE_ACCEPT);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hasText = draft.trim().length > 0;

  // Grow with the draft up to five lines, then scroll inside the field.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = LINE_HEIGHT * MAX_LINES + VERTICAL_PADDING;
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${Math.max(next, LINE_HEIGHT + VERTICAL_PADDING)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [draft, inputRef]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onEsc = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen]);

  const openFileInput = (nextAccept: string) => {
    setAccept(nextAccept);
    setMenuOpen(false);
    // The accept attribute must be on the input before the picker opens.
    window.setTimeout(() => fileInputRef.current?.click(), 0);
  };

  const pasteFromClipboard = () => {
    setMenuOpen(false);
    if (onPasteFromClipboard) onPasteFromClipboard();
    else openFileInput('image/*');
  };

  // The aim chip (direction C): `↳ replying in thread` / `↳ replying to <author>`,
  // mono lowercase, inside the row before the placeholder.
  const target = threadTarget
    ? { label: t('podChat.composer.aimThread'), cancel: onCancelThread }
    : replyTarget
      ? { label: t('podChat.composer.aimReply', { author: replyTarget.user?.username || t('podChat.messageFallback') }), cancel: onCancelReply }
      : null;

  return (
    <div className={`v2-composer${hasText ? ' v2-composer--typing' : ''}${uploading ? ' v2-composer--uploading' : ''}`}>
      <div className="v2-composer__row">
        <div className="v2-composer__plus-wrap" ref={menuRef}>
          <button
            type="button"
            className="v2-composer__plus"
            aria-label={t('podChat.composer.more')}
            title={t('podChat.composer.more')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            disabled={uploading}
          />
          {menuOpen && (
            <div className="v2-composer__menu" role="menu" aria-label={t('podChat.composer.more')}>
              <button type="button" role="menuitem" onClick={() => openFileInput(FILE_ACCEPT)}>{t('podChat.composer.attachFile')}</button>
              <button type="button" role="menuitem" onClick={() => openFileInput('image/*')}>{t('podChat.composer.attachImage')}</button>
              <button type="button" role="menuitem" onClick={pasteFromClipboard}>{t('podChat.composer.pasteImage')}</button>
            </div>
          )}
        </div>
        {target && (
          <span className="v2-composer__aim v2-composer__tag" role="status">
            {target.label}
            <button type="button" className="v2-composer__aim-cancel v2-composer__tag-cancel" aria-label={t('podChat.cancelReply')} onClick={target.cancel}>×</button>
          </span>
        )}
        <div className="v2-composer__field">
          <textarea
            ref={inputRef}
            placeholder={threadTarget ? t('podChat.thread.replyInThread') : replyTarget ? t('podChat.composer.replyPlaceholder', { author: replyTarget.user?.username || t('podChat.messageFallback') }) : t('podChat.composer.placeholder', { podName })}
            value={draft}
            rows={1}
            onChange={(event) => onDraftChange(event.target.value, event.target.selectionStart)}
            onClick={(event) => onDraftPointer(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyUp={(event) => onDraftPointer(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
          />
          {mentionOpen && mentions.length > 0 && (
            <div className="v2-mention-dropdown" ref={mentionDropdownRef} role="listbox">
              {mentions.map((item, index) => (
                <button
                  type="button"
                  key={item.id}
                  className={`v2-mention-item${index === mentionIndex ? ' v2-mention-item--active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onMentionSelect(item)}
                  role="option"
                  aria-selected={index === mentionIndex}
                >
                  <V2Avatar name={item.label} src={item.avatar || undefined} size="sm" />
                  <span className="v2-mention-item__text">
                    <span className="v2-mention-item__label">@{item.value || item.label}</span>
                    <span className="v2-mention-item__sub">{item.subtitle}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {uploading && <span className="v2-composer__uploading" role="status">{t('podChat.composer.uploading')}</span>}
        {hasText && (
          <button
            type="button"
            className="v2-composer__send"
            onClick={onSend}
            disabled={sending}
            aria-label={sending ? t('podChat.composer.sending') : t('podChat.composer.sendAria')}
            title={t('podChat.composer.sendTooltip', { name: authorName })}
          >
            <span aria-hidden="true">↵</span>
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        className="v2-composer__file"
        onChange={(event) => onAttach(event.target.files?.[0] || null)}
      />
      {(composerError || sendError) && <p className="v2-composer__error">{composerError || sendError}</p>}
      {warnings.length > 0 && (
        <div className="v2-composer__warnings" data-testid="mention-state-warning">
          {warnings.map((warning) => (
            <span key={warning.agentName}>
              {warning.state === 'never-connected'
                ? (warning.fixCommand
                  ? t('podChat.mentionState.neverOwner', { handle: warning.agentName, command: warning.fixCommand })
                  : t('podChat.mentionState.neverPeer', { handle: warning.agentName }))
                : (warning.fixCommand
                  ? t('podChat.mentionState.darkOwner', { handle: warning.agentName, command: warning.fixCommand })
                  : t('podChat.mentionState.darkPeer', { handle: warning.agentName }))}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export default V2Composer;
