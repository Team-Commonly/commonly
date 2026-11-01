import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';

/**
 * Plan panel on /v2/settings.
 */
const Card = () => (
  <svg className="v2-settings__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18v12H3zM3 10h18" /></svg>
);

const V2BillingPanel: React.FC = () => {
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
    <div className="v2p-lrow">
      <span className="lb"><Card />Plan</span>
      <span className="vl">
        <span className="v2-settings__plan">{t(isPro ? 'billing.tier.pro' : 'billing.tier.free')}</span>
        {error && <span className="v2-settings__error" role="alert">{error}</span>}
      </span>
      <span className="ac">
        <button
          className={`v2p-b v2p-b-sm ${isPro ? 'v2p-b-g' : 'v2p-b-p'}`}
          type="button"
          onClick={() => void openBilling()}
          disabled={busy}
        >
          {busy ? t('billing.opening') : t(isPro ? 'billing.manage' : 'billing.upgrade')}
        </button>
      </span>
    </div>
  );
};

export default V2BillingPanel;
