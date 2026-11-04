import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useV2Api } from '../hooks/useV2Api';
import { agentKeyFor } from '../utils/agentKey';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import V2PageHead from './V2PageHead';
import './V2RunTrace.css';

export interface RunTrace {
  id: string; podId: string; agentName: string; instanceId: string; status: string;
  trigger: string; startedAt: string; completedAt?: string; totalTokens: number;
  errorKind?: string; traceTruncated: boolean; omittedTurns: number; omittedToolCalls: number;
  turns: Array<{
    turnIndex: number; model: string; servedModel?: string; fallbacks?: number;
    elapsedMs: number; totalTokens?: number;
    toolCalls: Array<{
      name: string; elapsedMs: number; callId?: string; outcome: string;
      trail?: { grantId?: string; credentialOwnerId?: string | null; outcome: string } | null;
    }>;
  }>;
}

interface RosterAgent { name?: string; agentName?: string; instanceId?: string; displayName?: string; profile?: { displayName?: string } }


const V2RunTrace: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { podId, runId } = useParams<{ podId: string; runId: string }>();
  const api = useV2Api();
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [roster, setRoster] = useState<RosterAgent[]>([]);
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
  // The pod roster only names the agent; the trace renders without it.
  useEffect(() => {
    let live = true;
    setRoster([]);
    api.get<{ agents?: RosterAgent[] }>(`/api/registry/pods/${encodeURIComponent(podId || '')}/agents`)
      .then((data) => {
        if (live && Array.isArray(data?.agents)) {
          setRoster(data.agents.filter((agent): agent is RosterAgent => Boolean(agent) && typeof agent === 'object'));
        }
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [api, podId]);

  const enumLabel = (group: 'status' | 'outcomes', value: string) => t(`runTrace.${group}.${value}`, { defaultValue: value });
  // Trigger values carry dots (task.assigned), so look them up in the object, not by key path.
  const triggerPhrase = (value: string) => {
    const phrases = t('runTrace.triggerPhrase', { returnObjects: true }) as unknown;
    const phrase = phrases && typeof phrases === 'object' ? (phrases as Record<string, unknown>)[value] : undefined;
    return typeof phrase === 'string' ? phrase : value;
  };
  const agentLabel = (run: RunTrace) => {
    // The same composite key the chat byline and inspector use (utils/agentKey).
    const key = agentKeyFor(run);
    const match = roster.find((agent) => agentKeyFor(agent) === key);
    return match?.displayName || match?.profile?.displayName || run.agentName;
  };
  const limitedKey = trace?.omittedTurns && trace?.omittedToolCalls ? 'limitedBoth'
    : trace?.omittedTurns ? 'limitedTurns' : trace?.omittedToolCalls ? 'limitedCalls' : 'limitedContent';

  return <section className="v2-run-trace" aria-labelledby="run-trace-title">
    {/* The shared page head bar, back as its lead key (as the board and memory draw it). */}
    <V2PageHead
      className="v2-feature__header v2-run-trace__head"
      titleClassName="v2-feature__title"
      titleId="run-trace-title"
      title={t('runTrace.title')}
      lead={(
        <Link
          className="v2p-b v2p-b-g v2p-ib v2-run-trace__back"
          to={`/v2/pods/${encodeURIComponent(podId || '')}`}
          aria-label={t('runTrace.back')}
          title={t('runTrace.back')}
        >
          <ArrowBackIcon fontSize="small" aria-hidden="true" />
        </Link>
      )}
    />
    <div className="v2-feature__scroll v2-run-trace__body">
    {!trace && !error && <p role="status">{t('runTrace.loading')}</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={retry}>{t('runTrace.retry')}</button></div>}
    {trace && <>
      <div className="v2-run-trace__summary">
        <strong>{agentLabel(trace)}</strong><span>{enumLabel('status', trace.status)} · {triggerPhrase(trace.trigger)}</span>
        <span>{t('runTrace.counts', {
          count: trace.turns.length,
          tokens: new Intl.NumberFormat(i18n.resolvedLanguage).format(trace.totalTokens),
        })}</span>
        <time dateTime={trace.startedAt}>{new Date(trace.startedAt).toLocaleString(i18n.resolvedLanguage)}</time>
        {trace.errorKind && <span>{t('runTrace.stopped', { kind: trace.errorKind })}</span>}
        {['queued', 'running'].includes(trace.status) && <p>{t('runTrace.running')} <button type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={retry}>{t('runTrace.refresh')}</button></p>}
      </div>
      {trace.traceTruncated && <p role="status">{t(`runTrace.${limitedKey}`, { turns: trace.omittedTurns, calls: trace.omittedToolCalls })}</p>}
      {!trace.turns.length && <p>{t('runTrace.empty')}</p>}
      <ol className="v2-run-trace__turns">
        {trace.turns.map((turn) => <li key={turn.turnIndex}>
          <h2>{t('runTrace.turn', { number: turn.turnIndex + 1 })}</h2>
          <p className="v2-run-trace__meta">{turn.servedModel && turn.servedModel !== turn.model
            ? t('runTrace.served', { requested: turn.model, served: turn.servedModel })
            : turn.model} · {turn.elapsedMs} ms · {turn.totalTokens ?? '—'} {t('runTrace.tokens')}</p>
          {!turn.toolCalls.length && <p>{t('runTrace.noTools')}</p>}
          {turn.toolCalls.map((call, index) => <div className="v2-run-trace__call" key={`${call.callId || call.name}-${index}`}>
            <strong>{call.name}</strong><span>{enumLabel('outcomes', call.outcome)} · {call.elapsedMs} ms</span>
            {call.callId && <code>{t('runTrace.call', { id: call.callId })}</code>}
            {call.trail ? <dl>
              {call.trail.grantId !== undefined && <><dt>{t('runTrace.grant')}</dt><dd>{call.trail.grantId}</dd></>}
              {call.trail.credentialOwnerId !== undefined && <><dt>{t('runTrace.owner')}</dt><dd>{call.trail.credentialOwnerId || t('runTrace.notRecorded')}</dd></>}
              <dt>{t('runTrace.outcome')}</dt><dd>{enumLabel('outcomes', call.trail.outcome)}</dd>
            </dl> : call.callId ? <p>{t('runTrace.unavailable')}</p> : <p>{t('runTrace.builtIn')}</p>}
          </div>)}
        </li>)}
      </ol>
      <footer className="v2-run-trace__foot">
        <p>{t('runTrace.retention')}</p>
        <code>{t('runTrace.runId', { id: trace.id })}</code>
      </footer>
    </>}
    </div>
  </section>;
};
export default V2RunTrace;
