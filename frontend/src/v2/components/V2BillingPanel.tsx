import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useV2Api } from '../hooks/useV2Api';

/**
 * Plan panel on /v2/settings.
 *
 * Reads the tier from `entitlements.pro` on the current user — the same flag
 * the backend gates on, so the UI can never claim a tier the API would refuse.
 * It NEVER writes that flag: upgrading redirects to Stripe Checkout and the
 * entitlement arrives later via the signed webhook. A user returning from a
 * successful checkout may briefly still read as Free; that is correct, and the
 * copy says so rather than faking the optimistic state.
 */
const V2BillingPanel: React.FC = () => {
  const { t } = useTranslation();
  const { currentUser } = useAuth() as {
    currentUser?: {
      entitlements?: { pro?: boolean };
      billing?: { subscriptionStatus?: string; cancelAtPeriodEnd?: boolean; currentPeriodEnd?: string };
    } | null;
  };
  const api = useV2Api();
  const [busy, setBusy] = useState<'upgrade' | 'manage' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isPro = currentUser?.entitlements?.pro === true;
  const cancelling = currentUser?.billing?.cancelAtPeriodEnd === true;

  const go = async (kind: 'upgrade' | 'manage') => {
    setBusy(kind);
    setError(null);
    try {
      const path = kind === 'upgrade' ? '/api/billing/checkout' : '/api/billing/portal';
      const res = await api.post<{ url?: string; error?: string }>(path, {});
      if (res?.url) {
        // Full navigation, not a router push: Stripe is a different origin.
        window.location.href = res.url;
        return;
      }
      setError(t('billing.errors.generic'));
    } catch (err) {
      const code = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(code === 'billing_not_configured'
        ? t('billing.errors.notConfigured')
        : t('billing.errors.generic'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="v2-billing" aria-labelledby="v2-billing-title">
      <div className="v2-billing__head">
        <h2 className="v2-billing__title" id="v2-billing-title">{t('billing.title')}</h2>
        <span className={`v2-billing__badge${isPro ? ' v2-billing__badge--pro' : ''}`}>
          {isPro ? t('billing.tier.pro') : t('billing.tier.free')}
        </span>
      </div>

      <p className="v2-billing__note">
        {isPro ? t('billing.proNote') : t('billing.freeNote')}
      </p>

      {cancelling && (
        <p className="v2-billing__warn">{t('billing.cancelling')}</p>
      )}

      {error && <p className="v2-billing__error" role="alert">{error}</p>}

      <div className="v2-billing__actions">
        {isPro ? (
          <button
            type="button"
            className="v2-billing__btn"
            onClick={() => go('manage')}
            disabled={busy !== null}
          >
            {busy === 'manage' ? t('billing.opening') : t('billing.manage')}
          </button>
        ) : (
          <button
            type="button"
            className="v2-billing__btn v2-billing__btn--primary"
            onClick={() => go('upgrade')}
            disabled={busy !== null}
          >
            {busy === 'upgrade' ? t('billing.opening') : t('billing.upgrade')}
          </button>
        )}
      </div>
    </section>
  );
};

export default V2BillingPanel;
