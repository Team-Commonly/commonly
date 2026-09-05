import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';

/**
 * Plan panel on /v2/settings.
 */
interface V2BillingPanelProps {
  showHeading?: boolean;
}

const V2BillingPanel: React.FC<V2BillingPanelProps> = ({ showHeading = true }) => {
  const { t } = useTranslation();
  const { currentUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPro = Boolean((currentUser?.entitlements as { pro?: boolean } | undefined)?.pro);

  const openBilling = async () => {
    setBusy(true);
    setError(null);
    try {
      const endpoint = isPro ? '/api/billing/portal' : '/api/billing/checkout';
      const response = await axios.post<{ url?: string }>(endpoint, {});
      if (!response.data?.url) throw new Error('Billing did not return a destination.');
      window.location.assign(response.data.url);
    } catch {
      setError(t('billing.errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="v2-billing" aria-labelledby="v2-billing-title">
      <div className="v2-billing__head">
        {showHeading && <h2 className="v2-billing__title" id="v2-billing-title">{t('billing.title')}</h2>}
        <span className={`v2-billing__badge v2-billing__badge--${isPro ? 'pro' : 'free'}`}>
          {t(isPro ? 'billing.tier.pro' : 'billing.tier.free')}
        </span>
      </div>
      {error && <p className="v2-billing__error" role="alert">{error}</p>}
      <div className="v2-billing__actions">
        <button
          className={`v2-billing__btn${isPro ? '' : ' v2-billing__btn--primary'}`}
          type="button"
          onClick={() => void openBilling()}
          disabled={busy}
        >
          {busy ? t('billing.opening') : t(isPro ? 'billing.manage' : 'billing.upgrade')}
        </button>
      </div>
    </section>
  );
};

export default V2BillingPanel;
