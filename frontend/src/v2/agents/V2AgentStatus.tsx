import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatAgentTimestamp } from './formatAgentTimestamp';
import { AgentControlLoader } from '../components/V2AgentControlSection';
import type { RuntimeObservation } from '../components/V2RuntimeControls';

interface Props {
  agentName: string;
  instanceId: string;
  paused: boolean;
  builtIn: boolean;
  observation?: RuntimeObservation | null;
  run?: { startedAt: string; completedAt: string | null; status: string } | null;
  task?: { taskId: string; podId: string; podName: string } | null;
  refreshNonce: number;
  update: (patch: { status: string }) => Promise<unknown>;
  onConnectionState: Parameters<typeof AgentControlLoader>[0]['onConnectionState'];
}

const V2AgentStatus: React.FC<Props> = ({ agentName, instanceId, paused, builtIn,
  observation, run, task, refreshNonce, update, onConnectionState }) => {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const togglePause = async () => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await update({ status: paused ? 'active' : 'paused' }); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const lastTurn = observation?.lastTurnAt || run?.completedAt || run?.startedAt;
  return <AgentControlLoader agentName={agentName} instanceId={instanceId} refreshNonce={refreshNonce}
    onConnectionState={onConnectionState} render={(snapshot, unavailable) => {
      const connection = snapshot?.connection;
      const never = connection?.state === 'never';
      const off = connection?.state === 'stale' || connection?.state === 'revoked';
      const state = paused ? 'paused' : never ? 'notConnected' : off ? 'off'
        : task || observation?.turnRunning || run?.status === 'running' ? 'working' : 'ready';
      const reconnect = snapshot && `/v2/agents/byo?pod=${encodeURIComponent(snapshot.podId)}&name=${encodeURIComponent(agentName)}&instanceId=${encodeURIComponent(instanceId)}&reconnect=1${snapshot.runtimeType === 'wrapper' ? '&mode=machine' : ''}`;
      return <section className="v2-agent-settings__section" aria-labelledby="agent-status-heading">
        <h2 id="agent-status-heading">{t('agentSettings.rev3.status')}</h2>
        <div className="v2-agent-status">
          <span className={`v2-agent-status__dot${off || never || paused ? ' is-off' : ''}`} aria-hidden="true" />
          <div>
            <strong>{snapshot ? t(`agentSettings.rev3.${state}`) : t(unavailable ? 'agentConnection.unavailable' : 'agentConnection.checking')}
              {task && <> · <Link to={`/v2/pods/${task.podId}`}>{task.taskId}</Link></>}
            </strong>
            <span className="v2-agent-status__last">{lastTurn ? t('agentSettings.rev3.lastTurn', { date: formatAgentTimestamp(lastTurn, i18n.language) }) : t('agentSettings.rev3.lastTurnUnknown')}</span>
            <p>{t(`agentSettings.rev3.${builtIn ? 'builtInStatus' : never ? 'connectHint' : off ? 'offHint' : 'pauseHint'}`)}</p>
          </div>
          {(never || connection?.state === 'revoked') && reconnect ? <Link className="v2-agent-settings__action" to={reconnect}>{t(never ? 'agentSettings.rev3.connect' : 'agentConnection.reconnect')}</Link>
            : snapshot && <button type="button" disabled={busy} onClick={() => { void togglePause(); }}>
              {t(`agentSettings.rev3.${paused ? 'resume' : 'pause'}`)}
            </button>}
        </div>
        {error && <p role="alert">{t('agentSettings.updateError')}</p>}
      </section>;
    }} />;
};

export default V2AgentStatus;
