import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
    <section className="v2-aprofile__settings-section" data-testid="agent-control-section">
      <h2>{t('agentConnection.control')}</h2>
      <p>{connectionLabel(connection, t)}</p>
      {needsReconnect && (
        <Link className="v2-aprofile__btn v2-aprofile__btn--primary"
          to={`/v2/agents/byo?pod=${encodeURIComponent(podId)}&name=${encodeURIComponent(agentName)}&reconnect=1${runtimeType === 'wrapper' ? '&mode=machine' : ''}`}>
          {t('agentConnection.reconnect')}
        </Link>
      )}
    </section>
  );
};

export default V2AgentControlSection;
