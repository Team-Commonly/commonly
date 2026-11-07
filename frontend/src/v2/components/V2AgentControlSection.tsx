import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { AgentConnection, connectionLabel } from '../utils/agentConnection';

interface Props {
  agentName: string;
  instanceId: string;
  podId: string;
  runtimeType?: string;
  connection: AgentConnection;
  /** What makes a never-connected agent run. The server sends it to the installer only. */
  fixCommand?: string;
  /** Settings reports the connection in its head, so the row renders only when it offers an action. */
  actionsOnly?: boolean;
}

// Owner/admin-only: the parent must obtain these props from an authenticated
// roster read after its server-gated Settings access check.
const V2AgentControlSection: React.FC<Props> = ({ agentName, instanceId, podId, runtimeType, connection, fixCommand, actionsOnly }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const needsReconnect = connection.state === 'revoked' || connection.state === 'stale';
  const canRegenerateMachineKey = runtimeType === 'wrapper' && connection.state === 'connected';
  const toRun = connection.state === 'never' ? fixCommand : undefined;
  // A webhook gets a sentence, because it has no command to copy.
  const copyable = Boolean(toRun?.startsWith('commonly agent run '));
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(toRun as string);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  // A connected wrapper keeps the row: its machine-key regeneration lives here.
  if (actionsOnly && !needsReconnect && !canRegenerateMachineKey && !toRun) return null;
  return (
    <div className="lrow" data-testid="agent-control-section">
      <span className="lb">{t('agentSettings.connection')}</span>
      <span className="vl">
        {toRun ? (copyable ? <code data-testid="agent-connect-command">{toRun}</code> : toRun) : connectionLabel(connection, t)}
      </span>
      <span className="ac">
        {copyable && (
          <button type="button" className="b b-g b-sm" onClick={() => { void copyCommand(); }}>
            {t(copied ? 'common.copied' : 'common.copy')}
          </button>
        )}
        {(needsReconnect || canRegenerateMachineKey) && (
          <Link className="b b-g b-sm"
            to={`/v2/agents/byo?pod=${encodeURIComponent(podId)}&name=${encodeURIComponent(agentName)}&instanceId=${encodeURIComponent(instanceId)}&reconnect=1${runtimeType === 'wrapper' ? '&mode=machine' : ''}`}>
            {t(needsReconnect ? 'agentConnection.reconnect' : 'agentSettings.regenerate')}
          </Link>
        )}
      </span>
    </div>
  );
};

export default V2AgentControlSection;

// Settings mounts after its server-gated access read. Resolve a writable pod
// rather than assuming the first pod in the public-facing activity list is
// this viewer's installation.
export const AgentControlLoader: React.FC<{
  agentName: string;
  instanceId: string;
  refreshNonce?: number;
  onConnectionState?: (state: AgentConnection['state'] | null, connection?: AgentConnection | null) => void;
  actionsOnly?: boolean;
}> = ({ agentName, instanceId, refreshNonce, onConnectionState, actionsOnly }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<(Props & { podId: string }) | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setStatus(null);
    setUnavailable(false);
  }, [agentName, instanceId]);

  useEffect(() => {
    let active = true;
    let requestId = 0;
    const load = async () => {
      const currentRequest = ++requestId;
      try {
        const manageable = await axios.get<{ writablePodId?: string | null }>(
          `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings`,
          { params: { instanceId } },
        );
        const podId = manageable.data.writablePodId;
        if (!podId) throw new Error('No manageable installation');
        const roster = await axios.get<{ agents?: Array<{
          name: string; instanceId: string; runtime?: { runtimeType?: string }; connection?: AgentConnection; fixCommand?: string;
        }> }>(`/api/registry/pods/${encodeURIComponent(podId)}/agents`);
        const match = roster.data.agents?.find((row) => row.name === agentName
          && row.instanceId === instanceId && row.connection);
        if (!match?.connection) throw new Error('No connection status');
        if (active && currentRequest === requestId) {
          setStatus({ agentName, instanceId, podId, runtimeType: match.runtime?.runtimeType,
            connection: match.connection, fixCommand: match.fixCommand });
          setUnavailable(false);
          onConnectionState?.(match.connection.state, match.connection);
        }
      } catch {
        if (active && currentRequest === requestId) {
          setStatus(null);
          setUnavailable(true);
          onConnectionState?.(null, null);
        }
      }
    };
    void load();
    const interval = window.setInterval(() => { void load(); }, 30_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [agentName, instanceId, refreshNonce, onConnectionState]);

  if (status) return <V2AgentControlSection {...status} actionsOnly={actionsOnly} />;
  // While the first read is in flight there is nothing to report yet.
  if (actionsOnly && !unavailable) return null;
  return <div className="lrow" data-testid="agent-control-section">
    <span className="lb">{t('agentSettings.connection')}</span>
    <span className="vl" role={unavailable ? 'alert' : 'status'}>
      {t(unavailable ? 'agentConnection.unavailable' : 'agentConnection.checking')}
    </span>
    <span className="ac" />
  </div>;
};
