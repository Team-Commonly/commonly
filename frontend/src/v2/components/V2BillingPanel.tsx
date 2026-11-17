import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';

/**
 * Plan panel on /v2/settings. The paid tier has ended, so there is nothing to
 * upgrade to: the panel shows only for an account that already has Pro, so an
 * existing subscriber can still manage or cancel through the billing portal.
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

  if (!isPro) return null;

  const openBilling = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await axios.post<{ url?: string }>('/api/billing/portal', {});
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
      <span className="lb"><Card />{t('billing.title')}</span>
      <span className="vl">
        <span className="v2-settings__plan">{t('billing.tier.pro')}</span>
      </span>
      <span className="ac">
        <button
          className="v2p-b v2p-b-sm v2p-b-g"
          type="button"
          onClick={() => void openBilling()}
          disabled={busy}
        >
          {busy ? t('billing.opening') : t('billing.manage')}
        </button>
      </span>
      {error && <span className="v2-settings__error v2-settings__error--row" role="alert">{error}</span>}
    </div>
  );
};

export default V2BillingPanel;
