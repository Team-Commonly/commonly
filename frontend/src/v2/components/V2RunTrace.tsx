import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useV2Api } from '../hooks/useV2Api';
import './V2RunTrace.css';

export interface RunTrace {
  id: string; podId: string; agentName: string; instanceId: string; status: string;
  trigger: string; startedAt: string; completedAt?: string; totalTokens: number;
  errorKind?: string; traceTruncated: boolean; omittedTurns: number; omittedToolCalls: number;
  turns: Array<{
    turnIndex: number; model: string; elapsedMs: number; totalTokens?: number;
    toolCalls: Array<{
      name: string; elapsedMs: number; callId?: string; outcome: string;
      trail?: { grantId: string; credentialOwnerId: string | null; outcome: string } | null;
    }>;
  }>;
}

const V2RunTrace: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { podId, runId } = useParams<{ podId: string; runId: string }>();
  const api = useV2Api();
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    let live = true;
    setTrace(null); setError('');
    api.get<{ run: RunTrace }>(`/api/pods/${encodeURIComponent(podId || '')}/runs/${encodeURIComponent(runId || '')}`)
      .then(({ run }) => { if (live) setTrace(run); })
      .catch((err: { response?: { status?: number } }) => {
        if (live) setError(err.response?.status === 404
          ? t('runTrace.access') : t('runTrace.error'));
      });
    return () => { live = false; };
  }, [api, podId, runId, attempt, t]);

  const enumLabel = (group: 'status' | 'trigger', value: string) => t(`runTrace.${group}.${value}`, { defaultValue: value });
  const limitedKey = trace?.omittedTurns && trace?.omittedToolCalls ? 'limitedBoth'
    : trace?.omittedTurns ? 'limitedTurns' : trace?.omittedToolCalls ? 'limitedCalls' : 'limitedContent';

  return <section className="v2-run-trace" aria-labelledby="run-trace-title">
    <Link className="v2-run-trace__back" to={`/v2/pods/${encodeURIComponent(podId || '')}`}>{t('runTrace.back')}</Link>
    <h1 id="run-trace-title">{t('runTrace.title')}</h1>
    <p className="v2-run-trace__retention">{t('runTrace.retention')}</p>
    {!trace && !error && <p role="status">{t('runTrace.loading')}</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={retry}>{t('runTrace.retry')}</button></div>}
    {trace && <>
      <div className="v2-run-trace__summary">
        <strong>{trace.agentName}</strong><span>{enumLabel('status', trace.status)} · {enumLabel('trigger', trace.trigger)}</span>
        <span>{t('runTrace.counts', { turns: trace.turns.length, tokens: trace.totalTokens })}</span>
        <time dateTime={trace.startedAt}>{new Date(trace.startedAt).toLocaleString(i18n.resolvedLanguage)}</time>
        <code>{trace.id}</code>
        {trace.errorKind && <span>{t('runTrace.stopped', { kind: trace.errorKind })}</span>}
        {['queued', 'running'].includes(trace.status) && <p>{t('runTrace.running')} <button type="button" onClick={retry}>{t('runTrace.refresh')}</button></p>}
      </div>
      {trace.traceTruncated && <p role="status">{t(`runTrace.${limitedKey}`, { turns: trace.omittedTurns, calls: trace.omittedToolCalls })}</p>}
      {!trace.turns.length && <p>{t('runTrace.empty')}</p>}
      <ol className="v2-run-trace__turns">
        {trace.turns.map((turn) => <li key={turn.turnIndex}>
          <h2>{t('runTrace.turn', { number: turn.turnIndex + 1 })}</h2>
          <p className="v2-run-trace__meta">{turn.model} · {turn.elapsedMs} ms · {turn.totalTokens ?? '—'} {t('runTrace.tokens')}</p>
          {!turn.toolCalls.length && <p>{t('runTrace.noTools')}</p>}
          {turn.toolCalls.map((call, index) => <div className="v2-run-trace__call" key={`${call.callId || call.name}-${index}`}>
            <strong>{call.name}</strong><span>{call.outcome} · {call.elapsedMs} ms</span>
            {call.callId && <code>{t('runTrace.call', { id: call.callId })}</code>}
            {call.trail ? <dl>
              <dt>{t('runTrace.grant')}</dt><dd>{call.trail.grantId}</dd>
              <dt>{t('runTrace.owner')}</dt><dd>{call.trail.credentialOwnerId || t('runTrace.notRecorded')}</dd>
              <dt>{t('runTrace.outcome')}</dt><dd>{call.trail.outcome}</dd>
            </dl> : call.callId ? <p>{t('runTrace.unavailable')}</p> : <p>{t('runTrace.builtIn')}</p>}
          </div>)}
        </li>)}
      </ol>
    </>}
  </section>;
};
export default V2RunTrace;
