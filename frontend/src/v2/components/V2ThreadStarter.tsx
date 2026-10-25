import React from 'react';
import { useTranslation } from 'react-i18next';

interface V2ThreadStarterProps {
  hostedAvailable: boolean;
  hostedState: 'idle' | 'installing' | 'starting' | 'running';
  hostedError: string | null;
  inviteUrl: string;
  inviteLoading: boolean;
  inviteError: string | null;
  inviteCopied: boolean;
  onDismiss: () => void;
  onRunHosted: () => void;
  onBringOwn: () => void;
  onCopyInvite: () => void;
  onRetryInvite: () => void;
}

/**
 * The empty-room onboarding surface is separate from the transcript so the
 * message list does not own pod creation, invite issuance, or focus control.
 */
const V2ThreadStarter: React.FC<V2ThreadStarterProps> = ({
  hostedAvailable,
  hostedState,
  hostedError,
  inviteUrl,
  inviteLoading,
  inviteError,
  inviteCopied,
  onDismiss,
  onRunHosted,
  onBringOwn,
  onCopyInvite,
  onRetryInvite,
}) => {
  const { t } = useTranslation();
  return (
    <section className="v2-chat__new-pod" aria-label={t('podChat.newPod.label')}>
      <div className="v2-chat__new-pod-head">
        <div>
          <div className="v2-chat__new-pod-title">{t('podChat.newPod.title')}</div>
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
        {hostedAvailable && (
          <button
            type="button"
            className="v2-chat__new-pod-action v2-chat__new-pod-action--hosted"
            onClick={onRunHosted}
            disabled={hostedState !== 'idle'}
          >
            {hostedState === 'idle' ? t('podChat.newPod.runHere') : t(`podChat.newPod.hosted.${hostedState}`)}
          </button>
        )}
        <button type="button" className="v2-chat__new-pod-action" onClick={onBringOwn}>
          {t('podChat.newPod.bringOwn')}
        </button>
        <div className="v2-chat__new-pod-action v2-chat__new-pod-action--invite">
          <div className="v2-chat__new-pod-action-title">{t('podChat.newPod.inviteTitle')}</div>
          {inviteLoading && <div className="v2-chat__new-pod-status">{t('podChat.newPod.preparingInvite')}</div>}
          {!inviteUrl && !inviteError && <button type="button" className="v2-chat__new-pod-copy" disabled={inviteLoading}
            onClick={onCopyInvite}>{t('teammate.act')}</button>}
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
      </div>
      {hostedError && <div className="v2-chat__new-pod-error" role="alert">{hostedError}</div>}
    </section>
  );
};

export default V2ThreadStarter;
