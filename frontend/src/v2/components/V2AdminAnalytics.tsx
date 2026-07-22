// v2-native admin usage dashboard (Wave 0 "See & Hear", GH#662). Renders
// /api/admin/analytics/usage + /funnel: DAU/WAU cards, signups/day and
// messages/day bars, and the activation-funnel cohort table. The route
// element wraps this in <ProtectedRoute requireAdmin> + V2FeaturePage chrome
// (see V2App.tsx). Charts are plain inline SVG — no chart library.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';

interface UsageDaily {
  date: string;
  signups: number;
  messages: number;
  posters: number;
}

interface UsageResponse {
  days: number;
  daily: UsageDaily[];
  totals: {
    signups: number;
    messages: number;
    dau: number;
    wau: number;
    totalUsers: number;
  };
}

interface FunnelCohort {
  date: string;
  signups: number;
  attachedAgent: number;
  sentMessage: number;
  returnedD1: number;
  returnedD7: number;
}

interface FunnelResponse {
  days: number;
  cohorts: FunnelCohort[];
  totals: FunnelCohort & {
    attachRatePct: number;
    messageRatePct: number;
    d1ReturnPct: number;
    d7ReturnPct: number;
  };
}

const RANGES = [7, 30, 90];

const errMessage = (err: unknown, fallback: string): string => {
  const e = err as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message || e?.message || fallback;
};

// Compact bar chart. Bars scale to the series max; a max of 0 renders an
// empty (but stable-height) chart, so zero-data instances degrade gracefully.
const Bars: React.FC<{ data: UsageDaily[]; field: 'signups' | 'messages'; label: string; unit: string }> = ({ data, field, label, unit }) => {
  const { t } = useTranslation();
  const W = 600;
  const H = 120;
  const max = Math.max(1, ...data.map((d) => d[field]));
  const bw = data.length ? W / data.length : W;
  return (
    <svg
      className="v2-admin-analytics__chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={t('adminAnalytics.charts.perDayAria', { label })}
    >
      {data.map((d, i) => {
        const h = Math.round((d[field] / max) * (H - 4));
        return (
          <rect
            key={d.date}
            x={i * bw + bw * 0.15}
            y={H - h}
            width={bw * 0.7}
            height={h}
            rx={1.5}
            className="v2-admin-analytics__bar"
          >
            <title>{t('adminAnalytics.charts.barTitle', { date: d.date, value: d[field], unit })}</title>
          </rect>
        );
      })}
    </svg>
  );
};

const V2AdminAnalytics: React.FC = () => {
  const { t } = useTranslation();
  const api = useV2Api();
  const [days, setDays] = useState(30);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [funnel, setFunnel] = useState<FunnelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [u, f] = await Promise.all([
          api.get<UsageResponse>(`/api/admin/analytics/usage?days=${days}`),
          api.get<FunnelResponse>(`/api/admin/analytics/funnel?days=${days}`),
        ]);
        if (!cancelled) {
          setUsage(u);
          setFunnel(f);
        }
      } catch (err) {
        if (!cancelled) setError(errMessage(err, t('adminAnalytics.errors.loadFailed')));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api, days]);

  const cards = usage ? [
    { key: 'dau', label: t('adminAnalytics.cards.dau.label'), value: usage.totals.dau, hint: t('adminAnalytics.cards.dau.hint') },
    { key: 'wau', label: t('adminAnalytics.cards.wau.label'), value: usage.totals.wau, hint: t('adminAnalytics.cards.wau.hint') },
    { key: 'signups', label: t('adminAnalytics.cards.signups.label', { days: usage.days }), value: usage.totals.signups, hint: t('adminAnalytics.cards.signups.hint') },
    { key: 'messages', label: t('adminAnalytics.cards.messages.label', { days: usage.days }), value: usage.totals.messages, hint: t('adminAnalytics.cards.messages.hint') },
    { key: 'total', label: t('adminAnalytics.cards.total.label'), value: usage.totals.totalUsers, hint: t('adminAnalytics.cards.total.hint') },
  ] : [];

  // Newest cohorts first; the table is the drill-down under the charts.
  const cohorts = funnel ? [...funnel.cohorts].reverse() : [];

  return (
    <div className="v2-admin-analytics">
      <div className="v2-admin-users__section-head">
        <div>
          <h2 className="v2-admin-users__section-title">{t('adminAnalytics.title')}</h2>
          <p className="v2-admin-users__section-sub">
            {t('adminAnalytics.subtitle')}
          </p>
        </div>
        <div className="v2-admin-analytics__head-actions">
          <div className="v2-admin-users__tabs" role="tablist" aria-label={t('adminAnalytics.timeRangeAria')}>
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={days === r}
                className={`v2-admin-users__tab${days === r ? ' v2-admin-users__tab--active' : ''}`}
                onClick={() => setDays(r)}
              >
                {t('adminAnalytics.rangeDays', { days: r })}
              </button>
            ))}
          </div>
          <Link to="/v2/admin/users" className="v2-admin-analytics__crosslink">{t('adminAnalytics.userAdminLink')}</Link>
        </div>
      </div>

      {error && <div className="v2-admin-users__error" role="alert">{error}</div>}

      {loading ? (
        <div className="v2-admin-users__loading"><span className="v2-spinner" /> {t('adminAnalytics.loading')}</div>
      ) : (
        <>
          <div className="v2-admin-analytics__cards">
            {cards.map((c) => (
              <div key={c.key} className="v2-admin-analytics__card" title={c.hint}>
                <div className="v2-admin-analytics__card-value">{c.value}</div>
                <div className="v2-admin-analytics__card-label">{c.label}</div>
              </div>
            ))}
          </div>

          {usage && (
            <div className="v2-admin-analytics__charts">
              <div className="v2-admin-analytics__chart-card">
                <div className="v2-admin-analytics__chart-title">{t('adminAnalytics.charts.signupsPerDay')}</div>
                <Bars data={usage.daily} field="signups" label={t('adminAnalytics.charts.signupsLabel')} unit={t('adminAnalytics.charts.signupsUnit')} />
              </div>
              <div className="v2-admin-analytics__chart-card">
                <div className="v2-admin-analytics__chart-title">{t('adminAnalytics.charts.messagesPerDay')}</div>
                <Bars data={usage.daily} field="messages" label={t('adminAnalytics.charts.messagesLabel')} unit={t('adminAnalytics.charts.messagesUnit')} />
              </div>
            </div>
          )}

          {funnel && (
            <section className="v2-admin-users__section">
              <div>
                <h2 className="v2-admin-users__section-title">{t('adminAnalytics.funnel.title')}</h2>
                <p className="v2-admin-users__section-sub">
                  {t('adminAnalytics.funnel.summary', {
                    signups: funnel.totals.signups,
                    days: funnel.days,
                    attachRate: funnel.totals.attachRatePct,
                    messageRate: funnel.totals.messageRatePct,
                    d1Rate: funnel.totals.d1ReturnPct,
                    d7Rate: funnel.totals.d7ReturnPct,
                  })}
                </p>
              </div>
              <div className="v2-admin-users__table-wrap">
                <table className="v2-admin-users__table">
                  <thead>
                    <tr>
                      <th>{t('adminAnalytics.funnel.table.cohort')}</th>
                      <th>{t('adminAnalytics.funnel.table.signups')}</th>
                      <th>{t('adminAnalytics.funnel.table.attachedAgent')}</th>
                      <th>{t('adminAnalytics.funnel.table.sentMessage')}</th>
                      <th>{t('adminAnalytics.funnel.table.returnedD1')}</th>
                      <th>{t('adminAnalytics.funnel.table.returnedD7')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cohorts.map((c) => (
                      <tr key={c.date} className={c.signups === 0 ? 'v2-admin-analytics__row--empty' : undefined}>
                        <td>{c.date}</td>
                        <td>{c.signups}</td>
                        <td>{c.attachedAgent}</td>
                        <td>{c.sentMessage}</td>
                        <td>{c.returnedD1}</td>
                        <td>{c.returnedD7}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
};

export default V2AdminAnalytics;
