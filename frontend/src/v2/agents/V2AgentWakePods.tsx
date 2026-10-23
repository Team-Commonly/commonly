import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import './v2-agent-wake-pods.css';

interface InstallationSettings {
  podId: string;
  podName: string;
  wakeOnMessage: boolean;
  boardWake: boolean;
  heartbeatMinutes: number;
}

const V2AgentWakePods: React.FC<{
  agentName: string;
  instanceId: string;
  onRemoved?: (podId: string) => void;
}> = ({ agentName, instanceId, onRemoved }) => {
  const { t } = useTranslation();
  const [installations, setInstallations] = useState<InstallationSettings[]>([]);
  const [busyPod, setBusyPod] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const query = `instanceId=${encodeURIComponent(instanceId)}`;
  const base = `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings`;

  const load = useCallback(async () => {
    try {
      const response = await axios.get<{ installations: InstallationSettings[] }>(`${base}?${query}`);
      setInstallations(Array.isArray(response.data.installations) ? response.data.installations : []);
      setError(null);
    } catch {
      setError(t('agentSettings.loadError'));
    } finally {
      setLoading(false);
    }
  }, [base, query, t]);

  useEffect(() => { void load(); }, [load]);

  const save = async (entry: InstallationSettings, changes: Partial<InstallationSettings>) => {
    setBusyPod(entry.podId);
    setError(null);
    try {
      const next = { ...entry, ...changes };
      await axios.patch(`${base}/pods/${encodeURIComponent(entry.podId)}?${query}`, {
        wakeOnMessage: next.wakeOnMessage,
        boardWake: next.boardWake,
        heartbeatMinutes: next.heartbeatMinutes,
      });
      setInstallations((current) => current.map((item) => item.podId === entry.podId ? next : item));
    } catch {
      setError(t('agentSettings.saveError'));
    } finally {
      setBusyPod(null);
    }
  };

  const remove = async (entry: InstallationSettings) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('agentSettings.removeConfirm', { podName: entry.podName }))) return;
    setBusyPod(entry.podId);
    setError(null);
    try {
      await axios.delete(
        `/api/registry/agents/${encodeURIComponent(agentName)}/pods/${encodeURIComponent(entry.podId)}?${query}`,
      );
      setInstallations((current) => current.filter((item) => item.podId !== entry.podId));
      onRemoved?.(entry.podId);
    } catch {
      setError(t('agentSettings.removeError'));
    } finally {
      setBusyPod(null);
    }
  };

  if (loading) return <div className="v2-agent-wake-pods__loading">{t('agentProfile.loading')}</div>;

  return (
    <div className="v2-agent-wake-pods">
      {error && <p className="v2-agent-wake-pods__error" role="alert">{error}</p>}
      <section className="v2-agent-wake-pods__section" aria-labelledby="agent-wake-title">
        <h2 id="agent-wake-title">{t('agentSettings.wakeTitle')}</h2>
        {installations.map((entry) => (
          <div className="v2-agent-wake-pods__pod" key={entry.podId}>
            <Link to={`/v2/pods/${entry.podId}`}>{entry.podName}</Link>
            <label className="v2-agent-wake-pods__row">
              <span>{t('agentSettings.wakeOnMessage')}</span>
              <input type="checkbox" checked={entry.wakeOnMessage} disabled={busyPod === entry.podId}
                onChange={(event) => { void save(entry, { wakeOnMessage: event.target.checked }); }} />
            </label>
            <label className="v2-agent-wake-pods__row">
              <span>{t('agentSettings.boardWake')}</span>
              <input type="checkbox" checked={entry.boardWake} disabled={busyPod === entry.podId}
                onChange={(event) => { void save(entry, { boardWake: event.target.checked }); }} />
            </label>
            <label className="v2-agent-wake-pods__row">
              <span>{t('agentSettings.heartbeat')}</span>
              <select value={entry.heartbeatMinutes} disabled={busyPod === entry.podId}
                onChange={(event) => { void save(entry, { heartbeatMinutes: Number(event.target.value) }); }}>
                {[...new Set([15, 30, 60, 120, 360, 720, 1440, entry.heartbeatMinutes])]
                  .sort((a, b) => a - b).map((minutes) => (
                    <option value={minutes} key={minutes}>{t('agentSettings.everyMinutes', { count: minutes })}</option>
                  ))}
              </select>
            </label>
          </div>
        ))}
      </section>
      <section className="v2-agent-wake-pods__section" aria-labelledby="agent-pods-title">
        <h2 id="agent-pods-title">{t('agentSettings.podsTitle')}</h2>
        {installations.length ? installations.map((entry) => (
          <div className="v2-agent-wake-pods__pod-row" key={entry.podId}>
            <Link to={`/v2/pods/${entry.podId}`}>{entry.podName}</Link>
            <button type="button" disabled={busyPod === entry.podId} onClick={() => { void remove(entry); }}>
              {t('agentSettings.remove')}
            </button>
          </div>
        )) : <p className="v2-agent-wake-pods__empty">{t('agentSettings.noPods')}</p>}
      </section>
    </div>
  );
};

export default V2AgentWakePods;
