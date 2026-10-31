import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { machineDisplayName } from '../utils/machineLabel';
import { useV2Api } from '../hooks/useV2Api';
import './V2AgentRuntimeGrants.css';
import V2AgentProviderKey from './V2AgentProviderKey';
import V2RuntimeControls, { RuntimeSettings, RuntimeUpdate } from './V2RuntimeControls';
import { daemonSetupCommand } from '../utils/daemonSetupCommand';

export interface Runtime extends RuntimeSettings {}

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
  activeMachines: Array<{ machineId: string; name: string; createdAt?: string | null }>;
}

interface PlacementFailure {
  response?: { data?: { code?: string; blockers?: Array<{ podName: string; installerName: string }> } };
}

interface Props {
  name: string;
  instanceId: string;
  runtime: Runtime;
  onSaveRuntime?: (update: RuntimeUpdate) => Promise<void>;
}

const WALKED_ADAPTERS: Record<string, string> = {
  claude: 'Claude Code',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  dsh: 'DeepSeek Harness',
};

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
  name, instanceId, runtime, onSaveRuntime,
}) => {
  const { t, i18n } = useTranslation();
  const api = useV2Api();
  const [grants, setGrants] = useState<AgentGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [grantsError, setGrantsError] = useState('');
  const [busy, setBusy] = useState(false);
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

  const details = useMemo(() => describeRuntime(runtime), [runtime]);
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
        <h2 id="agent-runtime-heading">{t('agentManage.controls.title')}</h2>
        <V2RuntimeControls runtime={runtime} onSave={onSaveRuntime} />
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
                  {placement.activeMachines.map((machine) => <option key={machine.machineId} value={machine.machineId}>{machineDisplayName(machine, placement.activeMachines, t, i18n.language)}</option>)}
                </select>
                <button type="button" disabled={!machineChoice || moving} onClick={() => { void moveAgent(); }}>
                  {moving ? t('agentManage.runtime.moving') : t('agentManage.runtime.move')}
                </button>
              </> : <p>{t('agentManage.runtime.noActiveMachine')} <code>{daemonSetupCommand()}</code></p>
            )}
          </div>
        )}
        <V2AgentProviderKey key={`${name}/${instanceId}`} name={name} instanceId={instanceId} editable={Boolean(onSaveRuntime && runtime.managed)} capability={runtime.ownKeyCapability} harness={details.adapter || runtime.adapter || ''} />
        {placementError && <p role="alert">{placementError}</p>}
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
