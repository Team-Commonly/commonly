import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import './V2AgentRuntimeGrants.css';

export interface Runtime {
  runtimeType?: string;
  host?: 'cloud' | 'byo';
  adapter?: string;
  model?: string;
  effort?: string;
}

interface AgentGrant {
  grantId: string;
  tools: string[];
  connector: string | null;
  podName: string | null;
  grantedBy: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  canRevoke: boolean;
}

interface AgentGrantsResponse {
  grants: AgentGrant[];
}

interface Props {
  name: string;
  instanceId: string;
  runtime: Runtime;
  preferredModel?: string | null;
  onSaveRuntime?: (update: { model?: string; effort?: string }) => Promise<void>;
}

const WALKED_ADAPTERS: Record<string, string> = {
  claude: 'Claude Code',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  dsh: 'DeepSeek Harness',
};

export const describeRuntime = (runtime: Runtime): { mode: 'hosted' | 'daemon' | 'cli' | 'unknown'; adapter: string | null } => {
  const type = String(runtime.runtimeType || '').toLowerCase();
  const adapterKey = String(runtime.adapter || type).toLowerCase();
  const mode = type === 'wrapper' ? 'daemon'
    : type === 'hosted' || type === 'native' || type === 'internal' || runtime.host === 'cloud' ? 'hosted'
      : runtime.host === 'byo' && WALKED_ADAPTERS[adapterKey] ? 'cli' : 'unknown';
  return { mode, adapter: WALKED_ADAPTERS[adapterKey] || null };
};

const dateLabel = (value: string | null): string => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
};

const V2AgentRuntimeGrants: React.FC<Props> = ({
  name, instanceId, runtime, preferredModel = null, onSaveRuntime,
}) => {
  const { t } = useTranslation();
  const api = useV2Api();
  const [grants, setGrants] = useState<AgentGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [runtimeError, setRuntimeError] = useState('');
  const [grantsError, setGrantsError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modelDraft, setModelDraft] = useState(runtime.model || '');
  const [effortDraft, setEffortDraft] = useState(runtime.effort || '');
  const [confirmGrantId, setConfirmGrantId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setGrantsError('');
    try {
      const next = await api.get<AgentGrantsResponse>(
        `/api/registry/agents/${encodeURIComponent(name)}/instances/${encodeURIComponent(instanceId)}/grants`,
      );
      setGrants(next.grants || []);
    } catch {
      setGrantsError(t('agentManage.grants.loadError', { defaultValue: 'Could not load connector grants.' }));
    } finally {
      setLoading(false);
    }
  }, [api, name, instanceId, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => setModelDraft(runtime.model || ''), [runtime.model]);
  useEffect(() => setEffortDraft(runtime.effort || ''), [runtime.effort]);

  const details = useMemo(() => describeRuntime(runtime), [runtime]);
  const modeLabel = {
    hosted: t('agentManage.runtime.hosted', { defaultValue: 'Hosted' }),
    daemon: t('agentManage.runtime.daemon', { defaultValue: 'On a computer, via the daemon' }),
    cli: t('agentManage.runtime.cli', { defaultValue: 'Single CLI' }),
    unknown: t('agentManage.runtime.unknown', { defaultValue: 'Runtime details unavailable' }),
  }[details.mode];
  const model = runtime.model || preferredModel || null;
  // The daemon reads the environment model on its next assignment and restarts
  // the child when it changes. A single CLI chooses its own model locally.
  const mayEditRuntime = Boolean(onSaveRuntime && details.mode === 'daemon' && details.adapter);
  const modelChanged = Boolean(modelDraft.trim() && modelDraft.trim() !== (runtime.model || ''));
  const effortChanged = effortDraft.trim() !== (runtime.effort || '');

  const saveRuntime = async () => {
    if (!onSaveRuntime || !mayEditRuntime) return;
    setBusy(true);
    setRuntimeError('');
    try {
      await onSaveRuntime({
        ...(modelChanged ? { model: modelDraft.trim() } : {}),
        ...(effortChanged ? { effort: effortDraft.trim() } : {}),
      });
    } catch {
      setRuntimeError(t('agentManage.runtime.saveError', { defaultValue: 'Could not save the model.' }));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grantId: string) => {
    setBusy(true);
    setGrantsError('');
    try {
      await api.post(`/api/grants/${encodeURIComponent(grantId)}/revoke`);
      setConfirmGrantId(null);
      setGrants((current) => current.map((grant) => (
        grant.grantId === grantId ? { ...grant, revokedAt: new Date().toISOString() } : grant
      )));
      await load();
    } catch {
      setGrantsError(t('agentManage.grants.revokeError', { defaultValue: 'Could not revoke the grant.' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v2-agent-runtime-grants">
      <section className="v2-agent-settings__section" aria-labelledby="agent-runtime-heading">
        <h2 id="agent-runtime-heading">{t('agentManage.runtime.title', { defaultValue: 'Runtime' })}</h2>
        <dl className="v2-agent-runtime-grants__facts">
          <div><dt>{t('agentManage.runtime.how', { defaultValue: 'How it runs' })}</dt><dd>{modeLabel}</dd></div>
          {details.adapter && <div><dt>{t('agentManage.runtime.adapter', { defaultValue: 'Adapter' })}</dt><dd>{details.adapter}</dd></div>}
          <div><dt>{t('agentManage.runtime.model', { defaultValue: 'Model' })}</dt><dd>{model || t('agentManage.runtime.modelUnknown', { defaultValue: 'Set by the runtime' })}</dd></div>
          {runtime.effort && <div><dt>{t('agentManage.runtime.effort', { defaultValue: 'Effort' })}</dt><dd>{runtime.effort}</dd></div>}
        </dl>
        {mayEditRuntime && (
          <div className="v2-agent-runtime-grants__edit">
            <label htmlFor="agent-runtime-model">{t('agentManage.runtime.changeModel', { defaultValue: 'Model' })}</label>
            <input id="agent-runtime-model" value={modelDraft} onChange={(event) => setModelDraft(event.target.value)} />
            <label htmlFor="agent-runtime-effort">{t('agentManage.runtime.changeEffort', { defaultValue: 'Effort' })}</label>
            <select id="agent-runtime-effort" value={effortDraft} onChange={(event) => setEffortDraft(event.target.value)}>
              <option value="">{t('agentManage.runtime.effortUnset', { defaultValue: 'Choose effort' })}</option>
              {['low', 'medium', 'high', 'xhigh', 'max'].map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
            <button type="button" disabled={busy || (!modelChanged && !effortChanged)} onClick={() => { void saveRuntime(); }}>
              {t('agentManage.runtime.save', { defaultValue: 'Save runtime' })}
            </button>
          </div>
        )}
        {runtimeError && <p role="alert">{runtimeError}</p>}
      </section>
      <section className="v2-agent-settings__section" aria-labelledby="agent-grants-heading">
        <h2 id="agent-grants-heading">{t('agentManage.grants.title', { defaultValue: 'Connector grants' })}</h2>
        {grantsError && <p role="alert">{grantsError}</p>}
        {loading && <p role="status">{t('agentManage.grants.loading', { defaultValue: 'Loading grants…' })}</p>}
        {!loading && !grantsError && grants.length === 0 && <p>{t('agentManage.grants.empty', { defaultValue: 'This agent has no connector grants.' })}</p>}
        <ul className="v2-agent-runtime-grants__list">
          {grants.map((grant) => {
            const ended = Boolean(grant.revokedAt) || new Date(grant.expiresAt).getTime() <= Date.now();
            return (
              <li key={grant.grantId}>
                <div>
                  <strong>{grant.connector || grant.tools[0]?.split('.')[0] || t('agentManage.grants.tool', { defaultValue: 'Tool' })}</strong>
                  <span>{grant.tools.join(', ')}</span>
                </div>
                <p>{grant.podName || t('agentManage.grants.direct', { defaultValue: 'Direct to this agent' })} · {t('agentManage.grants.by', { defaultValue: 'Granted by' })} {grant.grantedBy || t('agentManage.grants.unknown', { defaultValue: 'unknown' })} · {dateLabel(grant.createdAt)}</p>
                <p>{ended ? t('agentManage.grants.ended', { defaultValue: 'Ended' }) : t('agentManage.grants.ends', { defaultValue: 'Ends' })} {dateLabel(grant.revokedAt || grant.expiresAt)}</p>
                {!ended && grant.canRevoke && (confirmGrantId === grant.grantId ? (
                  <div className="v2-agent-runtime-grants__actions">
                    <button type="button" disabled={busy} onClick={() => { void revoke(grant.grantId); }}>{t('agentManage.grants.confirmRevoke', { defaultValue: 'Yes, revoke it' })}</button>
                    <button type="button" disabled={busy} onClick={() => setConfirmGrantId(null)}>{t('agentManage.grants.cancel', { defaultValue: 'Cancel' })}</button>
                  </div>
                ) : (
                  <button type="button" disabled={busy} onClick={() => setConfirmGrantId(grant.grantId)}>{t('agentManage.grants.revoke', { defaultValue: 'Revoke' })}</button>
                ))}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
};

export default V2AgentRuntimeGrants;
