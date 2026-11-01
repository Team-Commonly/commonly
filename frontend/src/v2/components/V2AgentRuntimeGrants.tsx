import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
  /** Told when the body holds something to act on, so a closed disclosure around it can open. */
  onNeedsAttention?: (needs: boolean) => void;
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

// The body of the How it runs disclosure: where it runs, the runtime controls and the own-key entry.
const V2AgentRuntimeBody: React.FC<Props> = ({
  name, instanceId, runtime, onSaveRuntime, onNeedsAttention,
}) => {
  const { t, i18n } = useTranslation();
  const api = useV2Api();
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

  useEffect(() => {
    if (runtime.runtimeType !== 'wrapper') return;
    setPlacement(null);
    setPlacementError('');
    void loadPlacement().catch((error) => setPlacementError(placementFailure(error, 'agentManage.runtime.placementError')));
  }, [runtime.runtimeType, loadPlacement, t]);

  const details = useMemo(() => describeRuntime(runtime), [runtime]);
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
  const needsAttention = Boolean(placementError) || (details.mode === 'daemon' && canMove);
  useEffect(() => { onNeedsAttention?.(needsAttention); }, [needsAttention, onNeedsAttention]);
  const machineState = placement && <>
    {placement.boundMachineRevoked && <span role="status">{t('agentManage.runtime.machineRevoked')}</span>}
    {!placement.boundMachineRevoked && placement.boundMachineId && <span><span className="dot" aria-hidden="true" />{t('agentManage.runtime.currentMachine', { name: machineName(placement.boundMachineId) })}</span>}
    {placement.requestedMachineId && !placement.boundMachineId && <span role="status">{t('agentManage.runtime.machineRequested', { name: machineName(placement.requestedMachineId) })}</span>}
  </>;
  const alertRow = (text: string, tone?: 'muted', action?: React.ReactNode) => <div className={`lrow v2-agent-settings-page__alert${tone ? ` v2-agent-settings-page__alert--${tone}` : ''}`}>
    <span className="lb" role="alert"><V2AgentSettingsIcon name="alert" />{text}</span>
    {action && <span className="ac">{action}</span>}
  </div>;
  return (
    <section className="v2-agent-settings-page__runs" aria-label={t('agentManage.controls.title')}>
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
  );
};

interface ConnectorsProps { name: string; instanceId: string }

// The Identity & access list's Connectors row: the active-grant count, a link to
// the Connectors page (where grants are made), and a toggle for the grants list
// with its revoke flow.
export const V2AgentConnectorsRow: React.FC<ConnectorsProps> = ({ name, instanceId }) => {
  const { t } = useTranslation();
  const api = useV2Api();
  const [grants, setGrants] = useState<AgentGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // A 403 means this viewer may not see the grants; it is said plainly, not as a failure to retry.
  const [grantsPrivate, setGrantsPrivate] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmGrantId, setConfirmGrantId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setGrantsPrivate(false);
    try {
      const next = await api.get<AgentGrantsResponse>(
        `/api/registry/agents/${encodeURIComponent(name)}/instances/${encodeURIComponent(instanceId)}/grants`,
      );
      setGrants(next.grants || []);
    } catch (requestError) {
      if ((requestError as { response?: { status?: number } })?.response?.status === 403) setGrantsPrivate(true);
      else setLoadError(t('agentManage.grants.loadError', { defaultValue: 'Could not load connector grants.' }));
    } finally {
      setLoading(false);
    }
  }, [api, name, instanceId, t]);

  useEffect(() => { void load(); }, [load]);
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

  const alertRow = (text: string, tone?: 'muted', action?: React.ReactNode) => <div className={`lrow v2-agent-settings-page__alert${tone ? ` v2-agent-settings-page__alert--${tone}` : ''}`}>
    <span className="lb" role="alert"><V2AgentSettingsIcon name="alert" />{text}</span>
    {action && <span className="ac">{action}</span>}
  </div>;
  const activeGrants = grants.filter((grant) => !grantEnded(grant)).length;
  const endedGrants = grants.length - activeGrants;
  // A failed load or revoke, or a pending confirm, keeps the list open so its message and action stay in view.
  const panelOpen = open || Boolean(loadError || revokeError || confirmGrantId);
  const panelId = `agent-grants-${instanceId}`;
  const title = t('agentManage.grants.title', { defaultValue: 'Connector grants' });

  return (
    <>
      <div className="lrow">
        <span className="lb"><V2AgentSettingsIcon name="plug" />{t('agentSettings.connectors')}</span>
        <span className="vl">
          {grants.length > 0 ? [t('agentManage.grants.activeCount', { count: activeGrants }),
            endedGrants > 0 && t('agentManage.grants.endedCount', { count: endedGrants })].filter(Boolean).join(' · ')
            : grantsPrivate ? <span className="mu">{t('agentManage.grants.private')}</span>
              : !loadError && <span className="mu">{loading ? t('agentManage.grants.loading', { defaultValue: 'Loading grants…' }) : t('agentSettings.none')}</span>}
        </span>
        <span className="ac">
          <Link className="b b-g ib b-sm" to="/v2/connectors" title={t('agentSettings.grantConnector')} aria-label={t('agentSettings.grantConnector')}>
            <V2AgentSettingsIcon name="plus" />
          </Link>
          <button type="button" className="b b-g ib b-sm v2-agent-settings-page__toggle" title={title} aria-label={title}
            aria-expanded={panelOpen} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
            <V2AgentSettingsIcon name="chev" />
          </button>
        </span>
      </div>
      {panelOpen && <div id={panelId} role="region" aria-label={title} className="v2-agent-settings-page__panel">
          {loadError && alertRow(loadError, 'muted', <button type="button" className="b b-s b-sm" disabled={loading} onClick={() => { setOpen(true); void load(); }}>{t('agentManage.grants.retry')}</button>)}
          {loading && !grants.length && <div className="lrow v2-agent-settings-page__plain">
            <span className="vl" role="status">{t('agentManage.grants.loading', { defaultValue: 'Loading grants…' })}</span>
          </div>}
          {!loading && !loadError && !grantsPrivate && grants.length === 0 && <div className="lrow v2-agent-settings-page__plain">
            <span className="vl">{t('agentManage.grants.empty', { defaultValue: 'This agent has no connector grants.' })}</span>
          </div>}
          {(grants.length > 0 || revokeError) && <>
            {revokeError && alertRow(revokeError)}
            {grants.map((grant) => {
              const ended = grantEnded(grant);
              const connector = grant.connector || grant.tools[0]?.split('.')[0] || '';
              return (
                <div key={grant.grantId} className={`lrow v2-agent-settings-page__grant${ended ? ' is-ended' : ''}`}>
                  <span className="lg">{connector ? <ConnectorLogo type={connector} size={28} /> : null}</span>
                  <span className="v2-agent-settings-page__grantname">
                    <strong>{connector ? connectorName(connector) : t('agentManage.grants.tool', { defaultValue: 'Tool' })}</strong>
                    <span className="mo">{grant.podName || t('agentManage.grants.direct', { defaultValue: 'Direct to this agent' })} · {t('agentManage.grants.by', { defaultValue: 'Granted by' })} {grant.grantedBy || t('agentManage.grants.unknown', { defaultValue: 'unknown' })} · {dateLabel(grant.createdAt)}</span>
                    <span className="mo v2-agent-settings-page__tools">{grant.tools.join(', ')}</span>
                  </span>
                  <span className="ac">
                    <span className="mo">{ended ? t('agentManage.grants.ended', { defaultValue: 'Ended' }) : t('agentManage.grants.ends', { defaultValue: 'Ends' })} {dateLabel(grant.revokedAt || grant.expiresAt)}</span>
                    {!ended && grant.canRevoke && (confirmGrantId === grant.grantId ? (
                      <span className="v2-agent-settings-page__confirm">
                        <button type="button" className="b b-p b-sm" disabled={busy} onClick={() => { void revoke(grant.grantId); }}>{t('agentManage.grants.confirmRevoke', { defaultValue: 'Yes, revoke it' })}</button>
                        <button type="button" className="b b-g b-sm" disabled={busy} onClick={() => { setRevokeError(''); setConfirmGrantId(null); }}>{t('agentManage.grants.cancel', { defaultValue: 'Cancel' })}</button>
                      </span>
                    ) : (
                      <button type="button" className="b b-g b-sm" disabled={busy} onClick={() => { setRevokeError(''); setConfirmGrantId(grant.grantId); }}>{t('agentManage.grants.revoke', { defaultValue: 'Revoke' })}</button>
                    ))}
                  </span>
                </div>
              );
            })}
          </>}
      </div>}
    </>
  );
};

export default V2AgentRuntimeBody;
