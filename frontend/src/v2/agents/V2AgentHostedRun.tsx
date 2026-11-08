import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { hostedCapNotice } from '../components/hostedCapNotice';
import V2AgentSettingsIcon from './V2AgentSettingsIcon';

interface HostedStatus {
  runtime?: { engine?: string; ready?: boolean; provisionedAt?: unknown; lastPollAt?: number | null };
}
type RunState = 'unknown' | 'running' | 'stopped' | 'starting' | 'slow';

// A last poll alone proves nothing: a turn that ends after a stop writes one
// back. provisionedAt is the record that the agent was started.
const readRunState = ({ runtime }: HostedStatus): RunState => {
  if (runtime?.ready || (runtime?.provisionedAt && runtime?.lastPollAt)) return 'running';
  return runtime?.provisionedAt ? 'slow' : 'stopped';
};
const START_POLLS = 15;
const START_POLL_MS = 4000;

interface Props {
  agentName: string;
  displayName: string;
  instanceId: string;
  onChanged: () => void;
}

// /api/hosted/status answers only the agent's owner, so anyone else's read
// fails and this renders nothing. Stopping keeps the agent's identity and
// pods. Only the native engine keeps everything else: the other engine
// deletes its stored conversation, so the confirm line says so.
const V2AgentHostedRun: React.FC<Props> = ({ agentName, displayName, instanceId, onChanged }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<RunState>('unknown');
  const [native, setNative] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identity = useRef(0);
  const body = { agentName, instanceId };
  const statusUrl = `/api/hosted/status?agentName=${encodeURIComponent(agentName)}&instanceId=${encodeURIComponent(instanceId)}`;

  useEffect(() => {
    identity.current += 1;
    const request = identity.current;
    setState('unknown');
    setConfirming(false);
    setBusy(false);
    setError(null);
    axios.get<HostedStatus>(statusUrl).then(({ data }) => {
      if (identity.current !== request) return;
      setNative(data.runtime?.engine === 'native');
      setState(readRunState(data));
    }).catch(() => { /* Not this viewer's hosted agent. */ });
    return () => { identity.current += 1; };
  }, [statusUrl]);

  const stop = async () => {
    const request = identity.current;
    setBusy(true);
    setError(null);
    try {
      await axios.post('/api/hosted/deprovision', body);
      if (identity.current !== request) return;
      setConfirming(false);
      setState('stopped');
      onChanged();
    } catch {
      if (identity.current === request) setError(t('agentSettings.hostedRun.stopError', { name: displayName }));
    } finally {
      if (identity.current === request) setBusy(false);
    }
  };

  const start = async () => {
    const request = identity.current;
    const current = () => identity.current === request;
    setBusy(true);
    setError(null);
    try {
      await axios.post('/api/hosted/provision', body);
      if (!current()) return;
      setState('starting');
      // An accepted provision doesn't prove the runtime is up.
      for (let attempt = 0; attempt < START_POLLS; attempt += 1) {
        try {
          const { data } = await axios.get<HostedStatus>(statusUrl);
          if (!current()) return;
          if (readRunState(data) === 'running') {
            setState('running');
            onChanged();
            return;
          }
        } catch {
          if (!current()) return;
        }
        if (attempt < START_POLLS - 1) await new Promise((resolve) => { window.setTimeout(resolve, START_POLL_MS); });
        if (!current()) return;
      }
      setState('slow');
    } catch (requestError) {
      if (!current()) return;
      const data = (requestError as { response?: { data?: { code?: string; cap?: number; holders?: Array<{ agentName?: string; displayName?: string }> } } }).response?.data;
      setError(data?.code === 'hosted_cap_reached' ? hostedCapNotice(t, data) : t('agentSettings.hostedRun.startError', { name: displayName }));
    } finally {
      if (current()) setBusy(false);
    }
  };

  if (state === 'unknown') return null;
  // One row of the Identity & access list. While a stop is being confirmed, its
  // line takes the full width under the row, so it reads at phone width too.
  return (
    <div className={`lrow v2-agent-hosted-run${confirming ? ' v2-agent-hosted-run--confirming' : ''}`} data-testid="agent-hosted-run">
      <span className="lb"><V2AgentSettingsIcon name="play" />{t('agentSettings.hostedRun.label')}</span>
      <span className="vl v2-agent-hosted-run__state" role="status">
        {confirming
          ? t(`agentSettings.hostedRun.${native ? 'confirm' : 'confirmClears'}`, { name: displayName })
          : t(`agentSettings.hostedRun.${state}`)}
      </span>
      <span className="ac">
        {state === 'running' && !confirming && (
          <button type="button" className="b b-g b-sm" onClick={() => setConfirming(true)}>{t('agentSettings.hostedRun.stop')}</button>
        )}
        {confirming && <>
          <button type="button" className="b b-p b-sm" disabled={busy} onClick={() => { void stop(); }}>{t('agentSettings.hostedRun.stopConfirm')}</button>
          <button type="button" className="b b-g b-sm" disabled={busy} onClick={() => setConfirming(false)}>{t('agentSettings.hostedRun.keep')}</button>
        </>}
        {(state === 'stopped' || state === 'slow') && (
          <button type="button" className="b b-p b-sm" disabled={busy} onClick={() => { void start(); }}>{t('agentSettings.hostedRun.start')}</button>
        )}
      </span>
      {error && <p className="v2-agent-hosted-run__error" role="alert">{error}</p>}
    </div>
  );
};

export default V2AgentHostedRun;
