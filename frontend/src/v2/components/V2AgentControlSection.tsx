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
}

// Owner/admin-only: the parent must obtain these props from an authenticated
// roster read after its server-gated Settings access check.
const V2AgentControlSection: React.FC<Props> = ({ agentName, instanceId, podId, runtimeType, connection }) => {
  const { t } = useTranslation();
  const needsReconnect = connection.state === 'revoked' || connection.state === 'stale';
  const canRegenerateMachineKey = runtimeType === 'wrapper' && connection.state === 'connected';
  return (
    <section className="v2-agent-settings__section" data-testid="agent-control-section">
      <div className="v2-agent-settings__section-head">
        <h2>{t('agentConnection.control')}</h2>
        {(needsReconnect || canRegenerateMachineKey) && (
          <Link className="v2-agent-settings__action"
            to={`/v2/agents/byo?pod=${encodeURIComponent(podId)}&name=${encodeURIComponent(agentName)}&instanceId=${encodeURIComponent(instanceId)}&reconnect=1${runtimeType === 'wrapper' ? '&mode=machine' : ''}`}>
            {t(needsReconnect ? 'agentConnection.reconnect' : 'agentSettings.regenerate')}
          </Link>
        )}
      </div>
      <p>{connectionLabel(connection, t)}</p>
    </section>
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
  onConnectionState?: (state: AgentConnection['state'] | null) => void;
}> = ({ agentName, instanceId, refreshNonce, onConnectionState }) => {
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
          name: string; instanceId: string; runtime?: { runtimeType?: string }; connection?: AgentConnection;
        }> }>(`/api/registry/pods/${encodeURIComponent(podId)}/agents`);
        const match = roster.data.agents?.find((row) => row.name === agentName
          && row.instanceId === instanceId && row.connection);
        if (!match?.connection) throw new Error('No connection status');
        if (active && currentRequest === requestId) {
          setStatus({ agentName, instanceId, podId, runtimeType: match.runtime?.runtimeType,
            connection: match.connection });
          setUnavailable(false);
          onConnectionState?.(match.connection.state);
        }
      } catch {
        if (active && currentRequest === requestId) {
          setStatus(null);
          setUnavailable(true);
          onConnectionState?.(null);
        }
      }
    };
    void load();
    const interval = window.setInterval(() => { void load(); }, 30_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [agentName, instanceId, refreshNonce, onConnectionState]);

  if (status) return <V2AgentControlSection {...status} />;
  return <section className="v2-agent-settings__section" data-testid="agent-control-section">
    <h2>{t('agentConnection.control')}</h2>
    <p role={unavailable ? 'alert' : 'status'}>
      {t(unavailable ? 'agentConnection.unavailable' : 'agentConnection.checking')}
    </p>
  </section>;
};
