import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { AgentConnection, connectionLabel } from '../utils/agentConnection';

interface Props {
  agentName: string;
  podId: string;
  runtimeType?: string;
  connection: AgentConnection;
}

// Owner/admin-only: the parent must obtain these props from an authenticated
// roster read after its server-gated Settings access check.
const V2AgentControlSection: React.FC<Props> = ({ agentName, podId, runtimeType, connection }) => {
  const { t } = useTranslation();
  const needsReconnect = connection.state === 'revoked' || connection.state === 'stale';
  return (
    <section className="v2-agent-settings__section" data-testid="agent-control-section">
      <div className="v2-agent-settings__section-head">
        <h2>{t('agentConnection.control')}</h2>
        {needsReconnect && (
          <Link className="v2-agent-settings__action"
            to={`/v2/agents/byo?pod=${encodeURIComponent(podId)}&name=${encodeURIComponent(agentName)}&reconnect=1${runtimeType === 'wrapper' ? '&mode=machine' : ''}`}>
            {t('agentConnection.reconnect')}
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
export const AgentControlLoader: React.FC<{ agentName: string; instanceId: string }> = ({ agentName, instanceId }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<(Props & { podId: string }) | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    setStatus(null);
    setUnavailable(false);
    const load = async () => {
      try {
        const manageable = await axios.get<{ installations?: Array<{ podId: string }> }>(
          `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings`,
          { params: { instanceId } },
        );
        const podId = manageable.data.installations?.[0]?.podId;
        if (!podId) throw new Error('No manageable installation');
        const roster = await axios.get<{ agents?: Array<{
          name: string; instanceId: string; runtime?: { runtimeType?: string }; connection?: AgentConnection;
        }> }>(`/api/registry/pods/${encodeURIComponent(podId)}/agents`);
        const match = roster.data.agents?.find((row) => row.name === agentName
          && row.instanceId === instanceId && row.connection);
        if (!match?.connection) throw new Error('No connection status');
        if (active) setStatus({ agentName, podId, runtimeType: match.runtime?.runtimeType,
          connection: match.connection });
      } catch {
        if (active) setUnavailable(true);
      }
    };
    void load();
    return () => { active = false; };
  }, [agentName, instanceId]);

  if (status) return <V2AgentControlSection {...status} />;
  return <section className="v2-agent-settings__section" data-testid="agent-control-section">
    <h2>{t('agentConnection.control')}</h2>
    <p role={unavailable ? 'alert' : 'status'}>
      {t(unavailable ? 'agentConnection.unavailable' : 'agentConnection.checking')}
    </p>
  </section>;
};
