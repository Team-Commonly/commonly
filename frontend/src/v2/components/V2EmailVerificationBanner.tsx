import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import axios from '../../utils/axiosConfig';
import { ShellGlyph } from '../icons/glyphs';

// A dismiss is kept per account in a module-level set (F652). V2App mounts a
// fresh shell behind each auth gate, so component state alone was lost on
// every route change between them. The set survives in-app navigation and
// remounts, and the reminder comes back on the next page load, as the
// product ruling says.
const dismissedAccounts = new Set<string>();

const V2EmailVerificationBanner: React.FC = () => {
  const { currentUser } = useAuth();
  const { t } = useTranslation();
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const needsVerification = currentUser?.verified === false;
  const accountKey = String(currentUser?._id || currentUser?.id || currentUser?.email || '');

  useEffect(() => {
    setNotice(null);
  }, [accountKey, needsVerification]);

  const dismissed = Boolean(accountKey) && (dismissedFor === accountKey || dismissedAccounts.has(accountKey));

  if (!needsVerification || dismissed || !currentUser?.email) return null;

  const dismiss = () => {
    dismissedAccounts.add(accountKey);
    setDismissedFor(accountKey);
  };

  const resend = async () => {
    if (resending) return;
    setResending(true);
    setNotice(null);
    try {
      await axios.post('/api/auth/resend-verification', { email: currentUser.email });
      setNotice(t('auth.verificationBanner.resent'));
    } catch {
      setNotice(t('auth.verificationBanner.resendFailed'));
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="v2-verification-banner" role="status" aria-live="polite">
      <div className="v2-verification-banner__content">
        <span className="v2-verification-banner__text">
          {t('auth.verificationBanner.message', { email: currentUser.email })}
        </span>
        {notice && <span className="v2-verification-banner__notice">{notice}</span>}
      </div>
      <button
        type="button"
        className="v2-verification-banner__resend"
        onClick={resend}
        disabled={resending}
      >
        {resending ? t('auth.verificationBanner.sending') : t('auth.verificationBanner.resend')}
      </button>
      <button
        type="button"
        className="v2-verification-banner__dismiss"
        onClick={dismiss}
        aria-label={t('auth.verificationBanner.dismiss')}
      >
        <ShellGlyph name="close" size={17} />
      </button>
    </div>
  );
};

export default V2EmailVerificationBanner;
