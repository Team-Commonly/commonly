import React from 'react';
import { useTranslation } from 'react-i18next';

interface V2ThreadStarterProps {
  inviteUrl: string;
  inviteLoading: boolean;
  inviteError: string | null;
  inviteCopied: boolean;
  onDismiss: () => void;
  onCopyInvite: () => void;
  onRetryInvite: () => void;
  onOpenInvite: () => void;
  onFocusComposer: () => void;
}

/**
 * The empty-room onboarding surface is separate from the transcript so the
 * message list does not own pod creation, invite issuance, or focus control.
 */
const V2ThreadStarter: React.FC<V2ThreadStarterProps> = ({
  inviteUrl,
  inviteLoading,
  inviteError,
  inviteCopied,
  onDismiss,
  onCopyInvite,
  onRetryInvite,
  onOpenInvite,
  onFocusComposer,
}) => {
  const { t } = useTranslation();
  return (
    <section className="v2-chat__new-pod" aria-label={t('podChat.newPod.label')}>
      <div className="v2-chat__new-pod-head">
        <div>
          <div className="v2-chat__new-pod-title">{t('podChat.newPod.title')}</div>
          <div className="v2-chat__new-pod-text">{t('podChat.newPod.text')}</div>
        </div>
        <button
          type="button"
          className="v2-chat__new-pod-dismiss"
          aria-label={t('podChat.newPod.dismiss')}
          onClick={onDismiss}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="v2-chat__new-pod-actions">
        <div className="v2-chat__new-pod-action v2-chat__new-pod-action--invite">
          <div className="v2-chat__new-pod-action-title">{t('podChat.newPod.inviteTitle')}</div>
          <div className="v2-chat__new-pod-action-text">{t('podChat.newPod.inviteText')}</div>
          {inviteLoading && <div className="v2-chat__new-pod-status">{t('podChat.newPod.preparingInvite')}</div>}
          {inviteUrl && (
            <div className="v2-invite-link-row">
              <input
                type="text"
                className="v2-invite-link"
                aria-label={t('podChat.newPod.inviteLinkLabel')}
                readOnly
                value={inviteUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
              <button type="button" className="v2-chat__new-pod-copy" onClick={onCopyInvite}>
                {inviteCopied ? t('common.copied') : t('common.copy')}
              </button>
            </div>
          )}
          {inviteError && (
            <div className="v2-chat__new-pod-error">
              <span>{inviteError}</span>
              <button type="button" onClick={onRetryInvite}>{t('podChat.newPod.tryAgain')}</button>
            </div>
          )}
        </div>
        <button type="button" className="v2-chat__new-pod-action" onClick={onOpenInvite}>
          <span className="v2-chat__new-pod-action-title">{t('podChat.newPod.addAgentTitle')}</span>
          <span className="v2-chat__new-pod-action-text">{t('podChat.newPod.addAgentText')}</span>
        </button>
        <button type="button" className="v2-chat__new-pod-action" onClick={onFocusComposer}>
          <span className="v2-chat__new-pod-action-title">{t('podChat.newPod.messageTitle')}</span>
          <span className="v2-chat__new-pod-action-text">{t('podChat.newPod.messageText')}</span>
        </button>
      </div>
    </section>
  );
};

export default V2ThreadStarter;
