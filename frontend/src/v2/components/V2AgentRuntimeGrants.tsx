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
  managed?: boolean;
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

interface Placement {
  boundMachineId: string | null;
  requestedMachineId: string | null;
  boundMachineRevoked: boolean;
  activeMachines: Array<{ machineId: string; name: string }>;
}

interface PlacementFailure {
  response?: { data?: { code?: string; blockers?: Array<{ podName: string; installerName: string }> } };
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
const DAEMON_SETUP_COMMAND = 'npm i -g @commonlyai/cli@latest && commonly login && commonly daemon register && commonly daemon install';

export const describeRuntime = (runtime: Runtime): { mode: 'native' | 'hosted' | 'daemon' | 'cli' | 'unknown'; adapter: string | null } => {
  const type = String(runtime.runtimeType || '').toLowerCase();
  const adapterKey = String(runtime.adapter || type).toLowerCase();
  const mode = type === 'wrapper' ? (runtime.managed === false ? 'cli' : 'daemon')
    : type === 'native' ? 'native'
      : type === 'hosted' || type === 'internal' || runtime.host === 'cloud' ? 'hosted'
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
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [machineChoice, setMachineChoice] = useState('');
  const [placementError, setPlacementError] = useState('');
  const [moving, setMoving] = useState(false);

  const placementFailure = (error: unknown, fallback: string): string => {
    const data = (error as PlacementFailure)?.response?.data;
    if (data?.code === 'another_installer') {
      const blockers = (data.blockers || []).map(({ podName, installerName }) => t('agentManage.runtime.blocker', { podName, installerName }))
        .join(t('agentManage.runtime.blockerSeparator'));
      return blockers ? t('agentManage.runtime.blockedBy', { blockers }) : t('agentManage.runtime.blockedGeneric');
    }
    const key: Record<string, string> = {
      owner_installation_missing: 'placementOwnerMissing', unknown_installer: 'placementUnknownInstaller',
      target_revoked: 'targetUnavailable', target_missing: 'targetUnavailable',
      binding_changed: 'placementChanged', agent_missing: 'placementError',
      in_process_agent_no_token: 'hostedCannotMove',
    };
    return data?.code && key[data.code] ? t(`agentManage.runtime.${key[data.code]}`) : t(fallback);
  };

  const loadPlacement = useCallback(async () => {
    const response = await api.get<Placement>('/api/agent-binding/placement', { params: { agentName: name, instanceId } });
    const next = { ...response, activeMachines: response.activeMachines || [] };
    setPlacement(next);
    setMachineChoice((current) => next.activeMachines.some((machine) => machine.machineId === current)
      ? current : next.activeMachines.find((machine) => machine.machineId !== next.boundMachineId)?.machineId || '');
    return next;
  }, [api, name, instanceId]);

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
  useEffect(() => {
    if (runtime.runtimeType !== 'wrapper') return;
    setPlacement(null);
    setPlacementError('');
    void loadPlacement().catch((error) => setPlacementError(placementFailure(error, 'agentManage.runtime.placementError')));
  }, [runtime.runtimeType, loadPlacement, t]);
  useEffect(() => setModelDraft(runtime.model || ''), [runtime.model]);
  useEffect(() => setEffortDraft(runtime.effort || ''), [runtime.effort]);

  const details = useMemo(() => describeRuntime(runtime), [runtime]);
  const modeLabel = {
    native: t('agentManage.runtime.native', { defaultValue: 'Native engine' }),
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

  const moveAgent = async () => {
    if (!placement || !machineChoice || moving) return;
    setMoving(true);
    setPlacementError('');
    try {
      // Recheck sole ownership and the target for immediate feedback. The
      // server move route checks again and updates the binding in one write.
      const current = await loadPlacement();
      if (current.boundMachineId !== placement.boundMachineId || (current.boundMachineId && !current.boundMachineRevoked)) {
        throw new Error(t('agentManage.runtime.placementChanged'));
      }
      if (!current.activeMachines.some((machine) => machine.machineId === machineChoice)) {
        throw new Error(t('agentManage.runtime.targetUnavailable'));
      }
      await api.post('/api/agent-binding/move', {
        agentName: name, instanceId, machineId: machineChoice, fromMachineId: current.boundMachineId,
      });
      await loadPlacement();
    } catch (error) {
      setPlacementError((error instanceof Error && !('response' in error) && error.message)
        || placementFailure(error, 'agentManage.runtime.moveError'));
      void loadPlacement().catch(() => {});
    } finally {
      setMoving(false);
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
        {details.mode === 'daemon' && placement && (
          <div className="v2-agent-runtime-grants__edit" data-testid="agent-machine-placement">
            {placement.boundMachineRevoked && <p role="status">{t('agentManage.runtime.machineRevoked')}</p>}
            {!placement.boundMachineRevoked && placement.boundMachineId && <p>{t('agentManage.runtime.currentMachine', {
              name: placement.activeMachines.find((machine) => machine.machineId === placement.boundMachineId)?.name || placement.boundMachineId,
            })}</p>}
            {placement.requestedMachineId && !placement.boundMachineId && <p role="status">{t('agentManage.runtime.machineRequested', {
              name: placement.activeMachines.find((machine) => machine.machineId === placement.requestedMachineId)?.name || placement.requestedMachineId,
            })}</p>}
            {(placement.boundMachineRevoked || !placement.boundMachineId) && (
              placement.activeMachines.length > 0 ? <>
                <label htmlFor="agent-runtime-machine">{t('agentManage.runtime.moveLabel')}</label>
                <select id="agent-runtime-machine" value={machineChoice} onChange={(event) => setMachineChoice(event.target.value)}>
                  {placement.activeMachines.map((machine) => <option key={machine.machineId} value={machine.machineId}>{machine.name}</option>)}
                </select>
                <button type="button" disabled={!machineChoice || moving} onClick={() => { void moveAgent(); }}>
                  {moving ? t('agentManage.runtime.moving') : t('agentManage.runtime.move')}
                </button>
              </> : <p>{t('agentManage.runtime.noActiveMachine')} <code>{DAEMON_SETUP_COMMAND}</code></p>
            )}
          </div>
        )}
        {placementError && <p role="alert">{placementError}</p>}
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
