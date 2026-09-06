import React from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
  onCancelReply: () => void;
  onCancelThread: () => void;
}

/** The one bounded input surface for a workspace thread. */
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
  onCancelReply,
  onCancelThread,
}) => {
  const { t } = useTranslation();
  return (
    <div className="v2-composer">
      {threadTarget && (
        <div className="v2-composer__target" role="status">
          <span>{t('podChat.thread.replyingInThread')} {threadTarget.preview.replace(/\[\[upload:[^\]]*\]\]/g, '📎').slice(0, 40)}</span>
          <button type="button" aria-label={t('podChat.cancelReply')} onClick={onCancelThread}>×</button>
        </div>
      )}
      {replyTarget && (
        <div className="v2-composer__target" role="status">
          <span>
            <Trans
              i18nKey="podChat.replyingTo"
              values={{ author: replyTarget.user?.username || t('podChat.messageFallback') }}
              components={{ author: <strong /> }}
            />{' '}
            {String(replyTarget.content || '').replace(/\[\[upload:[^\]]*\]\]/g, '📎').slice(0, 80)}
          </span>
          <button type="button" aria-label={t('podChat.cancelReply')} onClick={onCancelReply}>×</button>
        </div>
      )}
      <div className="v2-composer__field">
        <textarea
          ref={inputRef}
          placeholder={t('podChat.composer.placeholder', { podName })}
          value={draft}
          rows={2}
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
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,.md,.txt,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.zip"
          className="v2-composer__file"
          onChange={(event) => onAttach(event.target.files?.[0] || null)}
        />
        <div className="v2-composer__actions">
          <button
            type="button"
            className="v2-composer__attach"
            title={uploading ? t('podChat.composer.uploading') : t('podChat.composer.attachFile')}
            aria-label={t('podChat.composer.attachFile')}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11l-9 9a5 5 0 01-7-7l9-9a3 3 0 014 4l-9 9a1 1 0 01-2-2l8-8" /></svg>
          </button>
          <span className="v2-composer__posts-as">{t('podChat.composer.postsAs', { name: authorName })} · ⌘↵</span>
          <button
            type="button"
            className="v2-composer__send"
            onClick={onSend}
            disabled={sending || !draft.trim()}
            aria-label={sending ? t('podChat.composer.sending') : t('podChat.composer.sendAria')}
          >
            {sending ? t('podChat.composer.sending') : t('podChat.composer.send')}
          </button>
        </div>
      </div>
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
