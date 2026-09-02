import React, { useEffect, useState } from 'react';
import CloseIcon from '@mui/icons-material/Close';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import axios from '../../utils/axiosConfig';

const V2EmailVerificationBanner: React.FC = () => {
  const { currentUser } = useAuth();
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const [resending, setResending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const needsVerification = currentUser?.verified === false;

  useEffect(() => {
    setNotice(null);
    // Keep a dismissal through route changes in this mounted app shell, but
    // restore the reminder on the next page load as the product ruling says.
    setDismissed(false);
  }, [currentUser?._id, currentUser?.id, needsVerification]);

  if (!needsVerification || dismissed || !currentUser?.email) return null;

  const dismiss = () => {
    setDismissed(true);
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
      <span className="v2-verification-banner__text">
        {t('auth.verificationBanner.message', { email: currentUser.email })}
      </span>
      {notice && <span className="v2-verification-banner__notice">{notice}</span>}
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
        <CloseIcon fontSize="small" aria-hidden="true" />
      </button>
    </div>
  );
};

export default V2EmailVerificationBanner;
