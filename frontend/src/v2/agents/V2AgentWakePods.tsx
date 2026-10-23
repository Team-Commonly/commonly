import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { AgentPodWakePatch } from './useAgentSettings';
import './v2-agent-wake-pods.css';

interface InstallationSettings {
  podId: string;
  podName: string;
  wakeOnMessage: boolean;
  humanOnly: boolean;
  boardWake: boolean;
  heartbeatEnabled: boolean;
  heartbeatMinutes: number;
}

const V2AgentWakePods: React.FC<{
  agentName: string;
  instanceId: string;
  updatePod: (podId: string, patch: AgentPodWakePatch) => Promise<unknown>;
  onRemoved?: (podId: string, wasLastPod: boolean) => void;
}> = ({ agentName, instanceId, updatePod, onRemoved }) => {
  const { t } = useTranslation();
  const [installations, setInstallations] = useState<InstallationSettings[]>([]);
  const [busyPod, setBusyPod] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activePodCount, setActivePodCount] = useState(0);
  const [turnCap, setTurnCap] = useState<number | null>(null);
  const [draftMinutes, setDraftMinutes] = useState<Record<string, number>>({});
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const query = `instanceId=${encodeURIComponent(instanceId)}`;
  const base = `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings`;
  const identity = `${agentName}:${instanceId}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setInstallations([]);
    setBusyPod(null);
    setError(null);
    setDraftMinutes({});
    const load = async () => {
      try {
        const [settingsResult, capResult] = await Promise.allSettled([
          axios.get<{ installations: InstallationSettings[]; activePodCount: number }>(`${base}?${query}`),
          axios.get<{ caps?: { turnsPerDay?: number } }>('/api/hosted/availability'),
        ]);
        if (!active) return;
        if (settingsResult.status === 'rejected') throw settingsResult.reason;
        const rows = Array.isArray(settingsResult.value.data.installations) ? settingsResult.value.data.installations : [];
        setInstallations(rows);
        setActivePodCount(settingsResult.value.data.activePodCount ?? rows.length);
        setDraftMinutes(Object.fromEntries(rows.map((row) => [row.podId, row.heartbeatMinutes])));
        setTurnCap(capResult.status === 'fulfilled' ? capResult.value.data.caps?.turnsPerDay ?? null : null);
      } catch (requestError) {
        if (active) setError((requestError as { response?: { status?: number } })?.response?.status === 403
          ? t('agentSettings.forbidden') : t('agentSettings.loadError'));
      } finally {
        if (active) {
          setLoadedIdentity(identity);
          setLoading(false);
        }
      }
    };
    void load();
    return () => { active = false; };
  }, [base, query, identity, t]);

  const save = async (entry: InstallationSettings, changes: Partial<InstallationSettings>) => {
    const requestedIdentity = identity;
    setBusyPod(entry.podId);
    setError(null);
    try {
      const next = { ...entry, ...changes };
      await updatePod(entry.podId, {
        wakeOnMessage: next.wakeOnMessage,
        boardWake: next.boardWake,
        humanOnly: next.humanOnly,
        heartbeatEnabled: next.heartbeatEnabled,
        heartbeatMinutes: next.heartbeatMinutes,
      });
      if (identityRef.current === requestedIdentity) {
        setInstallations((current) => current.map((item) => item.podId === entry.podId ? next : item));
      }
    } catch (requestError) {
      if (identityRef.current === requestedIdentity) setError((requestError as { response?: { status?: number } })?.response?.status === 403
        ? t('agentSettings.forbidden') : t('agentSettings.saveError'));
    } finally {
      if (identityRef.current === requestedIdentity) setBusyPod(null);
    }
  };

  const remove = async (entry: InstallationSettings) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t(activePodCount === 1 ? 'agentSettings.removeLastConfirm' : 'agentSettings.removeConfirm',
      { podName: entry.podName }))) return;
    const requestedIdentity = identity;
    setBusyPod(entry.podId);
    setError(null);
    try {
      await axios.delete(
        `/api/registry/agents/${encodeURIComponent(agentName)}/pods/${encodeURIComponent(entry.podId)}?${query}`,
      );
      if (identityRef.current === requestedIdentity) {
        setInstallations((current) => current.filter((item) => item.podId !== entry.podId));
        setActivePodCount((count) => Math.max(0, count - 1));
        onRemoved?.(entry.podId, activePodCount === 1);
      }
    } catch (requestError) {
      if (identityRef.current === requestedIdentity) setError((requestError as { response?: { status?: number } })?.response?.status === 403
        ? t('agentSettings.forbidden') : t('agentSettings.removeError'));
    } finally {
      if (identityRef.current === requestedIdentity) setBusyPod(null);
    }
  };

  if (loading || loadedIdentity !== identity) {
    return <div className="v2-agent-wake-pods__loading">{t('agentProfile.loading')}</div>;
  }

  return (
    <div className="v2-agent-wake-pods">
      {error && <p className="v2-agent-wake-pods__error" role="alert">{error}</p>}
      <section className="v2-agent-wake-pods__section" aria-labelledby="agent-wake-title">
        <h2 id="agent-wake-title">{t('agentSettings.wakeTitle')}</h2>
        <p className="v2-agent-wake-pods__hint">{t('agentSettings.mentionsAlwaysWake')}</p>
        {installations.map((entry) => (
          <div className="v2-agent-wake-pods__pod" key={entry.podId}>
            <Link to={`/v2/pods/${entry.podId}`}>{entry.podName}</Link>
            <label className="v2-agent-wake-pods__row">
              <span>{t('agentSettings.wakeOnMessage')}</span>
              <input type="checkbox" checked={entry.wakeOnMessage} disabled={busyPod === entry.podId}
                onChange={(event) => { void save(entry, { wakeOnMessage: event.target.checked }); }} />
            </label>
            {entry.wakeOnMessage && <label className="v2-agent-wake-pods__row v2-agent-wake-pods__subrow">
              <span>{t('agentSettings.humanOnly')}</span>
              <input type="checkbox" checked={entry.humanOnly} disabled={busyPod === entry.podId}
                onChange={(event) => { void save(entry, { humanOnly: event.target.checked }); }} />
            </label>}
            <label className="v2-agent-wake-pods__row">
              <span>{t('agentSettings.boardWake')}</span>
              <input type="checkbox" checked={entry.boardWake} disabled={busyPod === entry.podId}
                onChange={(event) => { void save(entry, { boardWake: event.target.checked }); }} />
            </label>
            <label className="v2-agent-wake-pods__row">
              <span>{t('agentSettings.heartbeat')}</span>
              <input type="checkbox" checked={entry.heartbeatEnabled} disabled={busyPod === entry.podId}
                onChange={(event) => { void save(entry, { heartbeatEnabled: event.target.checked,
                  heartbeatMinutes: draftMinutes[entry.podId] ?? entry.heartbeatMinutes }); }} />
            </label>
            <label className="v2-agent-wake-pods__row v2-agent-wake-pods__subrow">
              <span>{t('agentSettings.heartbeatInterval')}</span>
              <select value={draftMinutes[entry.podId] ?? entry.heartbeatMinutes} disabled={busyPod === entry.podId}
                onChange={(event) => { setDraftMinutes((current) => ({ ...current,
                  [entry.podId]: Number(event.target.value) })); }}>
                {[...new Set([15, 30, 60, 120, 360, 720, 1440, entry.heartbeatMinutes])]
                  .sort((a, b) => a - b).map((minutes) => (
                    <option value={minutes} key={minutes}>{t('agentSettings.everyMinutes', { count: minutes })}</option>
                  ))}
              </select>
            </label>
            <p className="v2-agent-wake-pods__hint">
              {turnCap === null
                ? t('agentSettings.capUnavailable', {
                  count: Math.ceil(1440 / (draftMinutes[entry.podId] ?? entry.heartbeatMinutes)),
                })
                : t('agentSettings.turnsPerDay', {
                  count: Math.ceil(1440 / (draftMinutes[entry.podId] ?? entry.heartbeatMinutes)), cap: turnCap,
                })}
              {turnCap !== null && Math.ceil(1440 / (draftMinutes[entry.podId] ?? entry.heartbeatMinutes)) > turnCap
                && ` ${t('agentSettings.overCap')}`}
            </p>
            {entry.heartbeatEnabled && draftMinutes[entry.podId] !== entry.heartbeatMinutes
              && <button type="button" disabled={busyPod === entry.podId}
                onClick={() => { void save(entry, { heartbeatMinutes: draftMinutes[entry.podId] }); }}>
                {t('agentSettings.saveInterval')}
              </button>}
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
