import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { useAuth } from '../../context/AuthContext';
import V2PageHead from './V2PageHead';
import V2Segmented from './V2Segmented';
import V2TeamViewSwitch from './V2TeamViewSwitch';
import './V2AgentHealthPage.css';

/**
 * Agent health (D115): /v2/agents/health. Frame: docs/design/artboards/d115/.
 * Reads GET /api/agents/health, which counts the agents in the viewer's own
 * pods and carries no message text, so nothing here can quote one.
 */

type Bucket = 'posted' | 'declined' | 'failed' | 'expired' | 'acknowledged' | 'inFlight';
type Buckets = Record<Bucket, number> & { total: number };
type Kind = 'mention' | 'heartbeat' | 'chat' | 'decision' | 'joined';

export interface AgentHealthRow {
  agentName: string;
  instanceId: string;
  displayName: string;
  pod: { id: string; name: string; type: string };
  installStatus: string;
  runtime: 'hosted' | 'byo' | 'other';
  asked: Buckets;
  heartbeats: Buckets;
  digests: number;
  kinds: Record<Kind, number>;
  otherKinds: Record<string, number>;
  runs: null | {
    total: number; succeeded: number; failed: number; interrupted: number; inFlight: number;
    empty: number; meteredTurns: number; totalTokens: number; sandboxSeconds: number;
    errorKinds: Record<string, number>;
  };
  liveness: null | { lastSeenAt: string | null; online: boolean; turnRunning: boolean; lastSpawnFailure: string | null };
  needsYou: string | null;
}

interface AgentHealthResponse {
  window: { hours: number; retentionHours: number; options: number[] };
  agents: AgentHealthRow[];
}

// The bar's order, left to right. Empty is a hosted run's own outcome (never a decline).
const SEGMENTS = ['posted', 'declined', 'empty', 'acknowledged', 'failed', 'expired', 'inFlight'] as const;
type Segment = typeof SEGMENTS[number];
const KINDS: Kind[] = ['mention', 'chat', 'decision', 'joined', 'heartbeat'];
const NEEDS_YOU_CODES = ['claude-signed-out', 'login', 'out-of-allowance', 'wont-start', 'codex-version', 'config'];

export const segmentCounts = (row: AgentHealthRow): Record<Segment, number> => ({
  posted: row.asked.posted,
  declined: row.asked.declined,
  empty: row.runs?.empty || 0,
  acknowledged: row.asked.acknowledged,
  failed: row.asked.failed,
  expired: row.asked.expired,
  inFlight: row.asked.inFlight,
});

export const roundTokens = (n: number): string => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`);

const isToday = (date: Date, now: Date) => date.toDateString() === now.toDateString();

const V2AgentHealthPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<AgentHealthResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const requested = params.get('window') || '';

  const entitled = useMemo(() => {
    const entitlements = (user as { entitlements?: { cloudAgents?: boolean } } | null)?.entitlements;
    return Boolean(entitlements?.cloudAgents) || user?.role === 'admin';
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    const token = localStorage.getItem('token');
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    axios.get<AgentHealthResponse>('/api/agents/health', { headers, params: requested ? { window: requested } : undefined })
      .then((res) => { if (!cancelled) setData(res.data); })
      // A failed read never draws zeros: it keeps no data and says so.
      .catch(() => { if (!cancelled) { setData(null); setFailed(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [requested, attempt]);

  const hours = data?.window.hours ?? 24;
  const spanLabel = useCallback((h: number) => (h % 24 === 0 && h > 24
    ? t('agentHealth.span.days', { count: h / 24 })
    : t('agentHealth.span.hours', { count: h })), [t]);

  const agents = data?.agents || [];
  const needsYouCount = agents.filter((row) => row.needsYou).length;
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' }), [i18n.language]);
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }), [i18n.language]);
  const now = new Date();

  const offlineSince = (row: AgentHealthRow): string => {
    const seen = row.liveness?.lastSeenAt ? new Date(row.liveness.lastSeenAt) : null;
    if (!seen) return t('agentHealth.status.offline');
    return t('agentHealth.status.offlineSince', {
      when: isToday(seen, now) ? timeFormat.format(seen) : dateFormat.format(seen),
    });
  };

  const sandbox = (seconds: number) => (seconds < 60
    ? t('agentHealth.cost.seconds', { count: Math.round(seconds) })
    : t('agentHealth.cost.minutes', { count: Math.round(seconds / 60) }));

  const kindLine = (row: AgentHealthRow) => {
    const parts = KINDS.filter((kind) => row.kinds[kind] > 0)
      .map((kind) => t(`agentHealth.kinds.${kind}`, { count: row.kinds[kind] }));
    const others = Object.entries(row.otherKinds).map(([type, count]) => (
      <React.Fragment key={type}>{count} <code>{type}</code></React.Fragment>
    ));
    const digests = row.digests > 0 ? [t('agentHealth.kinds.digest', { count: row.digests })] : [];
    const all: React.ReactNode[] = [...parts, ...others, ...digests];
    return all.map((part, index) => (
      // eslint-disable-next-line react/no-array-index-key
      <React.Fragment key={index}>{index > 0 ? ' · ' : ''}{part}</React.Fragment>
    ));
  };

  const windowControl = data ? (
    <V2Segmented<string>
      size="sm"
      className="v2-health__window"
      ariaLabel={t('agentHealth.windowAria')}
      value={String(hours)}
      onChange={(value) => setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('window', `${value}h`);
        return next;
      }, { replace: true })}
      options={data.window.options.map((h) => ({ value: String(h), label: spanLabel(h) }))}
    />
  ) : null;

  const head = (
    <V2PageHead
      className="v2-feature__header v2-page-head--wrap v2-team__head v2-health__head"
      titleClassName="v2-feature__title v2-team__title"
      title={t('yourTeam.title')}
      aside={<V2TeamViewSwitch value="health" />}
      actions={(
        <>
          <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => navigate('/v2/agents/byo')}>
            {t('yourTeam.actions.bringYourOwn')}
          </button>
          <button
            type="button"
            className="v2p-b v2p-b-p v2p-b-sm"
            onClick={() => navigate(entitled ? '/v2/agents/byo?mode=hosted' : '/v2/agents')}
          >
            {t('yourTeam.actions.hire')}
          </button>
        </>
      )}
    />
  );

  let body: React.ReactNode;
  if (loading && !data) {
    body = <p className="v2-health__muted" role="status">{t('agentHealth.loading')}</p>;
  } else if (failed) {
    body = (
      <div className="v2-health__notice" role="alert">
        <strong>{t('agentHealth.error.title')}</strong>
        <p>{t('agentHealth.error.body')}</p>
        <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => setAttempt((n) => n + 1)}>
          {t('agentHealth.error.retry')}
        </button>
      </div>
    );
  } else if (!agents.length) {
    body = (
      <>
      {windowControl && <div className="v2-health__toolbar v2-health__toolbar--end">{windowControl}</div>}
      <div className="v2-health__notice">
        <strong>{t('agentHealth.empty.title')}</strong>
        <p>{t('agentHealth.empty.body')}</p>
        <button
          type="button"
          className="v2p-b v2p-b-p v2p-b-sm"
          onClick={() => navigate(entitled ? '/v2/agents/byo?mode=hosted' : '/v2/agents')}
        >
          {t('yourTeam.actions.hire')}
        </button>
      </div>
      </>
    );
  } else {
    const shown = SEGMENTS.filter((segment) => agents.some((row) => segmentCounts(row)[segment] > 0));
    body = (
      <>
        <div className="v2-health__toolbar">
          <p className="v2-health__scope">
            {t('agentHealth.scope', { count: agents.length })}
            {needsYouCount > 0 && <> · {t('agentHealth.needsYouCount', { count: needsYouCount })}</>}
          </p>
          {windowControl}
        </div>
        {shown.length > 0 && (
          <ul className="v2-health__legend" aria-label={t('agentHealth.legendAria')}>
            {shown.map((segment) => (
              <li key={segment}><i className={`v2-health__key v2-health__seg--${segment}`} aria-hidden="true" />{t(`agentHealth.legend.${segment}`)}</li>
            ))}
          </ul>
        )}
        <table className="v2-health__table">
          <thead>
            <tr>
              <th scope="col">{t('agentHealth.columns.agent')}</th>
              <th scope="col">{t('agentHealth.columns.asked')}</th>
              <th scope="col">{t('agentHealth.columns.heartbeats')}</th>
              <th scope="col">{t('agentHealth.columns.kinds')}</th>
              <th scope="col">{t('agentHealth.columns.cost')}</th>
              <th scope="col">{t('agentHealth.columns.status')}</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((row) => {
              const counts = segmentCounts(row);
              const barTotal = SEGMENTS.reduce((sum, segment) => sum + counts[segment], 0);
              const href = `/v2/agents/${encodeURIComponent(row.agentName)}/${encodeURIComponent(row.instanceId)}`;
              const quiet = row.asked.total === 0 && row.heartbeats.total === 0 && row.digests === 0;
              const offline = row.liveness ? !row.liveness.online : false;
              const subs = (['declined', 'empty', 'acknowledged', 'failed', 'expired', 'inFlight'] as Segment[])
                .filter((segment) => counts[segment] > 0)
                .map((segment) => t(`agentHealth.counts.${segment}`, { count: counts[segment] }));
              const runtimeLabel = row.runtime === 'byo' ? t('yourTeam.card.where.local')
                : row.runtime === 'hosted' ? t('agentHealth.runtime.hosted') : null;
              const needsCode = row.needsYou && NEEDS_YOU_CODES.includes(row.needsYou) ? row.needsYou : null;
              return (
                <tr key={`${row.agentName}/${row.instanceId}/${row.pod.id}`} className="v2-health__row">
                  <td className="v2-health__agent">
                    <div className="v2-health__who">
                      <button type="button" className="v2-health__name" onClick={() => navigate(href)}>
                        {row.displayName}
                      </button>
                      <span className="v2-health__pod">{row.pod.name}</span>
                      {runtimeLabel && <span className="v2-health__chip">{runtimeLabel}</span>}
                    </div>
                  </td>
                  {quiet ? (
                    <td className="v2-health__quiet" colSpan={4}>
                      {t('agentHealth.noWakes', { span: spanLabel(hours) })}
                    </td>
                  ) : (
                    <>
                      <td className="v2-health__asked">
                        <span className="v2-health__num">
                          {t('agentHealth.askedLine', { posted: counts.posted, total: row.asked.total })}
                        </span>
                        {barTotal > 0 && (
                          <span className="v2-health__bar" aria-hidden="true">
                            {SEGMENTS.filter((segment) => counts[segment] > 0).map((segment) => (
                              <i
                                key={segment}
                                className={`v2-health__seg--${segment}`}
                                style={{ width: `${(counts[segment] / barTotal) * 100}%` }}
                              />
                            ))}
                          </span>
                        )}
                        {subs.length > 0 && <span className="v2-health__sub">{subs.join(' · ')}</span>}
                      </td>
                      <td className={`v2-health__beats${row.heartbeats.total > 0 ? '' : ' v2-health__beats--none'}`}>
                        {row.heartbeats.total > 0 ? (
                          <>
                            <span className="v2-health__num v2-health__wide">{row.heartbeats.total}</span>
                            {/* Phones hide the column heads, so the count names itself there. */}
                            <span className="v2-health__num v2-health__narrow">
                              {t('agentHealth.kinds.heartbeat', { count: row.heartbeats.total })}
                            </span>
                            <span className="v2-health__sub">{t('agentHealth.counts.posted', { count: row.heartbeats.posted })}</span>
                          </>
                        ) : <span className="v2-health__muted">–</span>}
                      </td>
                      <td className="v2-health__kinds"><span className="v2-health__sub">{kindLine(row)}</span></td>
                      <td className="v2-health__cost">
                        {row.runtime === 'byo' ? (
                          <span className="v2-health__sub">{t('agentHealth.cost.onYourAccount')}</span>
                        ) : row.runs ? (
                          <>
                            <span className="v2-health__num">{t('agentHealth.cost.turns', { count: row.runs.meteredTurns })}</span>
                            <span className="v2-health__sub">
                              {t('agentHealth.cost.tokens', { value: roundTokens(row.runs.totalTokens) })}
                              {row.runs.sandboxSeconds > 0 && <> · {sandbox(row.runs.sandboxSeconds)}</>}
                            </span>
                          </>
                        ) : <span className="v2-health__muted">–</span>}
                      </td>
                    </>
                  )}
                  <td className="v2-health__status">
                    {needsCode ? (
                      <span className="v2-health__badge v2-health__badge--needs">
                        {t('agentHealth.status.needsYou')} · {t(`agentHealth.failure.${needsCode}`)}
                      </span>
                    ) : offline ? (
                      <span className="v2-health__badge v2-health__badge--offline">{offlineSince(row)}</span>
                    ) : (
                      <span className="v2-health__muted">{t(`agentHealth.install.${row.installStatus}`, { defaultValue: t('agentHealth.install.active') })}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </>
    );
  }

  return (
    <div className="v2-team v2-health">
      {head}
      <div className="v2-feature__scroll v2-team__body v2-health__body">{body}</div>
    </div>
  );
};

export default V2AgentHealthPage;
