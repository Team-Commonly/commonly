import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { machineDisplayName } from '../utils/machineLabel';
import { useV2Api } from '../hooks/useV2Api';
import V2AgentProviderKey from './V2AgentProviderKey';
import V2AgentSettingsIcon from '../agents/V2AgentSettingsIcon';
import ConnectorLogo, { connectorName } from '../connectors/ConnectorLogo';
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

const grantEnded = (grant: AgentGrant): boolean => Boolean(grant.revokedAt) || new Date(grant.expiresAt).getTime() <= Date.now();

const V2AgentRuntimeGrants: React.FC<Props> = ({
  name, instanceId, runtime, onSaveRuntime,
}) => {
  const { t, i18n } = useTranslation();
  const api = useV2Api();
  const [grants, setGrants] = useState<AgentGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [revokeError, setRevokeError] = useState('');
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
    setLoadError('');
    try {
      const next = await api.get<AgentGrantsResponse>(
        `/api/registry/agents/${encodeURIComponent(name)}/instances/${encodeURIComponent(instanceId)}/grants`,
      );
      setGrants(next.grants || []);
    } catch {
      setLoadError(t('agentManage.grants.loadError', { defaultValue: 'Could not load connector grants.' }));
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
    setRevokeError('');
    try {
      await api.post(`/api/grants/${encodeURIComponent(grantId)}/revoke`);
      setConfirmGrantId(null);
      setGrants((current) => current.map((grant) => (
        grant.grantId === grantId ? { ...grant, revokedAt: new Date().toISOString() } : grant
      )));
      await load();
    } catch {
      setRevokeError(t('agentManage.grants.revokeError', { defaultValue: 'Could not revoke the grant.' }));
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

  const machineName = (id: string | null) => placement?.activeMachines.find((machine) => machine.machineId === id)?.name || id;
  const canMove = Boolean(placement && (placement.boundMachineRevoked || !placement.boundMachineId));
  const machineState = placement && (placement.boundMachineRevoked ? <span role="status">{t('agentManage.runtime.machineRevoked')}</span>
    : placement.boundMachineId ? <><span className="dot" aria-hidden="true" />{t('agentManage.runtime.currentMachine', { name: machineName(placement.boundMachineId) })}</>
      : placement.requestedMachineId ? <span role="status">{t('agentManage.runtime.machineRequested', { name: machineName(placement.requestedMachineId) })}</span>
        : null);
  const alertRow = (text: string, tone?: 'muted', action?: React.ReactNode) => <div className={`lrow v2-agent-settings-page__alert${tone ? ` v2-agent-settings-page__alert--${tone}` : ''}`}>
    <span className="lb" role="alert"><V2AgentSettingsIcon name="alert" />{text}</span>
    {action && <span className="ac">{action}</span>}
  </div>;
  const activeGrants = grants.filter((grant) => !grantEnded(grant)).length;
  const endedGrants = grants.length - activeGrants;

  return (
    <>
      <section className="v2-agent-settings-page__group" aria-labelledby="agent-runtime-heading">
        <h2 id="agent-runtime-heading" className="gtitle"><V2AgentSettingsIcon name="cpu" />{t('agentManage.controls.title')}</h2>
        <div className="list">
          {details.mode === 'daemon' && placement && (canMove ? (
            <details className="disc" open data-testid="agent-machine-placement">
              <summary>
                <span className="lb"><V2AgentSettingsIcon name="device" />{t('agentManage.runtime.machine')}</span>
                <span className="vl">{machineState}</span>
                <V2AgentSettingsIcon name="chev" className="chev" />
              </summary>
              <div className="dbody">
                {placement.activeMachines.length > 0 ? <div className="v2-agent-settings-page__move">
                  <label className="mu" htmlFor="agent-runtime-machine">{t('agentManage.runtime.moveLabel')}</label>
                  <span className="sel">
                    <select id="agent-runtime-machine" value={machineChoice} onChange={(event) => setMachineChoice(event.target.value)}>
                      {placement.activeMachines.map((machine) => <option key={machine.machineId} value={machine.machineId}>{machineDisplayName(machine, placement.activeMachines, t, i18n.language)}</option>)}
                    </select>
                    <V2AgentSettingsIcon name="chev" />
                  </span>
                  <button type="button" className="b b-s b-sm" disabled={!machineChoice || moving} onClick={() => { void moveAgent(); }}>
                    {moving ? t('agentManage.runtime.moving') : t('agentManage.runtime.move')}
                  </button>
                </div> : <p className="v2-agent-settings-page__live">{t('agentManage.runtime.noActiveMachine')} <code>{daemonSetupCommand()}</code></p>}
              </div>
            </details>
          ) : (
            <div className="lrow" data-testid="agent-machine-placement">
              <span className="lb"><V2AgentSettingsIcon name="device" />{t('agentManage.runtime.machine')}</span>
              <span className="vl">{machineState}</span>
              <span className="ac" />
            </div>
          ))}
          {placementError && alertRow(placementError)}
          <V2RuntimeControls runtime={runtime} onSave={onSaveRuntime} />
        </div>
        <V2AgentProviderKey key={`${name}/${instanceId}`} name={name} instanceId={instanceId} editable={Boolean(onSaveRuntime && runtime.managed)} capability={runtime.ownKeyCapability} harness={details.adapter || runtime.adapter || ''} />
      </section>
      <section className="v2-agent-settings-page__group" aria-labelledby="agent-grants-heading">
        <div className="gtitle"><V2AgentSettingsIcon name="plug" />
          <h2 id="agent-grants-heading">{t('agentManage.grants.title', { defaultValue: 'Connector grants' })}</h2>
          {grants.length > 0 && <span className="v2-agent-settings-page__count">
            {[t('agentManage.grants.activeCount', { count: activeGrants }),
              endedGrants > 0 && t('agentManage.grants.endedCount', { count: endedGrants })].filter(Boolean).join(' · ')}
          </span>}
        </div>
        {loadError && <div className="list">
          {alertRow(loadError, 'muted', <button type="button" className="b b-s b-sm" disabled={loading} onClick={() => { void load(); }}>{t('agentManage.grants.retry')}</button>)}
        </div>}
        {loading && !grants.length && <div className="list"><div className="lrow v2-agent-settings-page__plain">
          <span className="vl" role="status">{t('agentManage.grants.loading', { defaultValue: 'Loading grants…' })}</span>
        </div></div>}
        {!loading && !loadError && grants.length === 0 && <div className="list"><div className="lrow v2-agent-settings-page__plain">
          <span className="vl">{t('agentManage.grants.empty', { defaultValue: 'This agent has no connector grants.' })}</span>
        </div></div>}
        {(grants.length > 0 || revokeError) && <div className="list">
          {revokeError && alertRow(revokeError)}
          {grants.map((grant) => {
            const ended = grantEnded(grant);
            const connector = grant.connector || grant.tools[0]?.split('.')[0] || '';
            return (
              <div key={grant.grantId} className={`lrow v2-agent-settings-page__grant${ended ? ' is-ended' : ''}`}>
                <span className="lg">{connector ? <ConnectorLogo type={connector} size={28} /> : null}</span>
                <span className="v2-agent-settings-page__grantname">
                  <strong title={grant.tools.join(', ')}>{connector ? connectorName(connector) : t('agentManage.grants.tool', { defaultValue: 'Tool' })}</strong>
                  <span className="mo">{grant.podName || t('agentManage.grants.direct', { defaultValue: 'Direct to this agent' })} · {t('agentManage.grants.by', { defaultValue: 'Granted by' })} {grant.grantedBy || t('agentManage.grants.unknown', { defaultValue: 'unknown' })} · {dateLabel(grant.createdAt)}</span>
                </span>
                <span className="ac">
                  <span className="mo">{ended ? t('agentManage.grants.ended', { defaultValue: 'Ended' }) : t('agentManage.grants.ends', { defaultValue: 'Ends' })} {dateLabel(grant.revokedAt || grant.expiresAt)}</span>
                  {!ended && grant.canRevoke && (confirmGrantId === grant.grantId ? (
                    <span className="v2-agent-settings-page__confirm">
                      <button type="button" className="b b-p b-sm" disabled={busy} onClick={() => { void revoke(grant.grantId); }}>{t('agentManage.grants.confirmRevoke', { defaultValue: 'Yes, revoke it' })}</button>
                      <button type="button" className="b b-g b-sm" disabled={busy} onClick={() => setConfirmGrantId(null)}>{t('agentManage.grants.cancel', { defaultValue: 'Cancel' })}</button>
                    </span>
                  ) : (
                    <button type="button" className="b b-g b-sm" disabled={busy} onClick={() => setConfirmGrantId(grant.grantId)}>{t('agentManage.grants.revoke', { defaultValue: 'Revoke' })}</button>
                  ))}
                </span>
              </div>
            );
          })}
        </div>}
      </section>
    </>
  );
};

export default V2AgentRuntimeGrants;
