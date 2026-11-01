import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import { AgentPodWakePatch } from './useAgentSettings';

interface InstallationSettings {
  podId: string;
  podName: string;
  status: string;
  wakeOnMessage: boolean;
  humanOnly: boolean;
  boardWake: boolean;
  heartbeatEnabled: boolean;
  heartbeatMinutes: number;
}

// Message wake is one choice of three, shown together: the human-only
// filter used to appear only after "Wake on messages" was ticked (D173).
const MESSAGE_WAKE_CHOICES = ['mentions', 'human', 'all'] as const;
type MessageWakeChoice = typeof MESSAGE_WAKE_CHOICES[number];
const MESSAGE_WAKE_SETTINGS: Record<MessageWakeChoice, Pick<InstallationSettings, 'wakeOnMessage' | 'humanOnly'>> = {
  mentions: { wakeOnMessage: false, humanOnly: false },
  human: { wakeOnMessage: true, humanOnly: true },
  all: { wakeOnMessage: true, humanOnly: false },
};
const messageWakeChoice = (entry: InstallationSettings): MessageWakeChoice => {
  if (!entry.wakeOnMessage) return 'mentions';
  return entry.humanOnly ? 'human' : 'all';
};

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
  const [podCount, setPodCount] = useState(0);
  const [turnCap, setTurnCap] = useState<number | null>(null);
  const [draftMinutes, setDraftMinutes] = useState<Record<string, number>>({});
  // A pod whose heartbeat select is set to Off, until its Save applies it.
  const [draftOff, setDraftOff] = useState<Record<string, boolean>>({});
  const [openPods, setOpenPods] = useState<Record<string, boolean>>({});
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const query = `instanceId=${encodeURIComponent(instanceId)}`;
  const base = `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings`;
  const identity = `${agentName}:${instanceId}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  // Per-pod save state; see save() below.
  const committedRef = useRef<Record<string, InstallationSettings>>({});
  const queuedRef = useRef<Record<string, InstallationSettings | undefined>>({});
  const sendingRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    let active = true;
    setLoading(true);
    setInstallations([]);
    setBusyPod(null);
    setError(null);
    setDraftMinutes({});
    setDraftOff({});
    committedRef.current = {};
    queuedRef.current = {};
    sendingRef.current = {};
    const load = async () => {
      try {
        const settingsResult = await axios.get<{
          installations: InstallationSettings[]; activePodCount: number; podCount: number; turnCap?: number;
        }>(`${base}?${query}`);
        if (!active) return;
        const rows = Array.isArray(settingsResult.data.installations) ? settingsResult.data.installations : [];
        setInstallations(rows);
        committedRef.current = Object.fromEntries(rows.map((row) => [row.podId, row]));
        setActivePodCount(settingsResult.data.activePodCount ?? rows.filter((row) => row.status === 'active').length);
        setPodCount(settingsResult.data.podCount ?? rows.length);
        setDraftMinutes(Object.fromEntries(rows.map((row) => [row.podId, row.heartbeatMinutes])));
        setTurnCap(settingsResult.data.turnCap ?? null);
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

  // Saves per pod go out one at a time, newest pick last. The message-wake
  // radios stay enabled while a save is in flight (disabling them dropped
  // keyboard focus to the page), so a second pick queues behind the first
  // rather than racing it to the server. A failure rolls the row back to the
  // last settings the server accepted, never to an unsaved pick.

  const save = async (entry: InstallationSettings, changes: Partial<InstallationSettings>) => {
    const requestedIdentity = identity;
    const { podId } = entry;
    const next = { ...entry, ...changes };
    // An agent switch replaces these objects. Hold the ones this save started
    // with, so a loop still in flight for the old agent never writes into the
    // new agent's queue.
    const committed = committedRef.current;
    const queued = queuedRef.current;
    const sending = sendingRef.current;
    if (!committed[podId]) committed[podId] = entry;
    queued[podId] = next;
    setBusyPod(podId);
    setError(null);
    // Show the pick at once, so the next arrow key moves on from it.
    setInstallations((current) => current.map((item) => item.podId === podId ? next : item));
    if (sending[podId]) return;
    sending[podId] = true;
    try {
      while (queued[podId]) {
        const target = queued[podId] as InstallationSettings;
        queued[podId] = undefined;
        try {
          // eslint-disable-next-line no-await-in-loop
          await updatePod(podId, {
            wakeOnMessage: target.wakeOnMessage,
            boardWake: target.boardWake,
            humanOnly: target.humanOnly,
            heartbeatEnabled: target.heartbeatEnabled,
            heartbeatMinutes: target.heartbeatMinutes,
          });
          committed[podId] = target;
        } catch (requestError) {
          queued[podId] = undefined;
          if (identityRef.current === requestedIdentity) {
            const saved = committed[podId];
            setInstallations((current) => current.map((item) => item.podId === podId ? saved : item));
            setError((requestError as { response?: { status?: number } })?.response?.status === 403
              ? t('agentSettings.forbidden') : t('agentSettings.saveError'));
          }
        }
      }
    } finally {
      sending[podId] = false;
      if (identityRef.current === requestedIdentity) setBusyPod(null);
    }
  };

  const remove = async (entry: InstallationSettings) => {
    // eslint-disable-next-line no-alert
    const willRevokeKeys = activePodCount <= (entry.status === 'active' ? 1 : 0);
    const confirmKey = podCount === 1 ? 'agentSettings.removeLastConfirm'
      : willRevokeKeys ? 'agentSettings.removeDisconnectConfirm' : 'agentSettings.removeConfirm';
    if (!window.confirm(t(confirmKey,
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
        setPodCount((count) => Math.max(0, count - 1));
        if (entry.status === 'active') setActivePodCount((count) => Math.max(0, count - 1));
        onRemoved?.(entry.podId, podCount === 1);
      }
    } catch (requestError) {
      if (identityRef.current === requestedIdentity) setError((requestError as { response?: { status?: number } })?.response?.status === 403
        ? t('agentSettings.forbidden') : t('agentSettings.removeError'));
    } finally {
      if (identityRef.current === requestedIdentity) setBusyPod(null);
    }
  };

  // Sum of the draft heartbeat turns, so the header previews the cap as the select changes.
  const turnsUsed = installations.reduce((total, entry) => {
    const off = draftOff[entry.podId] ?? !entry.heartbeatEnabled;
    const minutes = draftMinutes[entry.podId] ?? entry.heartbeatMinutes;
    return off ? total : total + Math.ceil(1440 / minutes);
  }, 0);
  const overCap = turnCap !== null && turnsUsed > turnCap;

  if (loading || loadedIdentity !== identity) {
    return <div className="v2-agent-wake-pods__loading">{t('agentProfile.loading')}</div>;
  }

  return (
    <div className="v2-agent-wake-pods">
      {error && <p className="v2-agent-wake-pods__error" role="alert">{error}</p>}
      <h2 className="gtitle">
        <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }} aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>
        {t('agentSettings.wakeTitle')}
        <span className="info" tabIndex={0} aria-label={t('agentSettings.mentionsAlwaysWake')}>
          <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
          <span className="tip" role="tooltip">{t('agentSettings.mentionsAlwaysWake')}</span>
        </span>
        <span className="v2-agent-wake-pods__cap">
          {turnCap === null
            ? t('agentSettings.turnsUsedNoCap', { used: turnsUsed })
            : t('agentSettings.turnsUsed', { used: turnsUsed, cap: turnCap })}
        </span>
      </h2>
      {overCap && <p className="v2-agent-wake-pods__hint">{t('agentSettings.overCap')}</p>}
      <div className="list">
        {installations.length ? (
          <table className="wt">
            <thead>
              <tr>
                <th scope="col">{t('agentSettings.podsTitle')}</th>
                <th scope="col">{t('agentSettings.colMessages')}</th>
                <th scope="col">{t('agentSettings.colBoard')}</th>
                <th scope="col">{t('agentSettings.colHeartbeat')}</th>
                <th scope="col"><span className="v2-agent-wake-pods__sr">{t('agentSettings.remove')}</span></th>
              </tr>
            </thead>
            <tbody>
              {installations.map((entry) => (
                <tr className="v2-agent-wake-pods__pod" key={entry.podId} data-open={openPods[entry.podId] ? 'true' : undefined}>
                  <td>
                    <Link to={`/v2/pods/${entry.podId}`}>{entry.podName}</Link>
                    <span className="v2-agent-wake-pods__mode">{t(`agentSettings.messageWakeShort_${messageWakeChoice(entry)}`)}</span>
                    <button type="button" className="v2-agent-wake-pods__fold" aria-expanded={!!openPods[entry.podId]}
                      aria-label={entry.podName}
                      onClick={() => setOpenPods((current) => ({ ...current, [entry.podId]: !current[entry.podId] }))}>
                      <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                    </button>
                  </td>
                  <td data-label={t('agentSettings.colMessages')}>
                    <div className="seg seg--sm v2-agent-wake-pods__segment" role="group" aria-busy={busyPod === entry.podId}
                      aria-label={t('agentSettings.messageWake')}>
                      {MESSAGE_WAKE_CHOICES.map((choice) => (
                        <label className="v2-agent-wake-pods__option" key={choice}>
                          <input type="radio" name={`message-wake-${entry.podId}`} value={choice}
                            aria-label={t(`agentSettings.messageWake_${choice}`)}
                            checked={messageWakeChoice(entry) === choice}
                            onChange={() => { void save(entry, MESSAGE_WAKE_SETTINGS[choice]); }} />
                          <span aria-hidden="true">{t(`agentSettings.messageWakeShort_${choice}`)}</span>
                        </label>
                      ))}
                    </div>
                  </td>
                  <td data-label={t('agentSettings.colBoard')}>
                    <label className="v2-agent-wake-pods__toggle">
                      <input type="checkbox" checked={entry.boardWake} disabled={busyPod === entry.podId}
                        onChange={(event) => { void save(entry, { boardWake: event.target.checked }); }} />
                      <span className={`tg${entry.boardWake ? ' on' : ''}`} aria-hidden="true" />
                      <span className="v2-agent-wake-pods__sr">{t('agentSettings.boardWake')}</span>
                    </label>
                  </td>
                  <td data-label={t('agentSettings.colHeartbeat')}>
                    {(() => {
                      const off = draftOff[entry.podId] ?? !entry.heartbeatEnabled;
                      const minutes = draftMinutes[entry.podId] ?? entry.heartbeatMinutes;
                      const dirty = off === entry.heartbeatEnabled || (!off && minutes !== entry.heartbeatMinutes);
                      return (
                        <>
                          <label className="sel v2-agent-wake-pods__interval">
                            <span className="v2-agent-wake-pods__sr">{t('agentSettings.heartbeat')}</span>
                            <select value={off ? 'off' : String(minutes)} disabled={busyPod === entry.podId}
                              onChange={(event) => {
                                const { value } = event.target;
                                setDraftOff((current) => ({ ...current, [entry.podId]: value === 'off' }));
                                if (value !== 'off') setDraftMinutes((current) => ({ ...current, [entry.podId]: Number(value) }));
                              }}>
                              <option value="off">{t('agentSettings.heartbeatOff')}</option>
                              {[...new Set([15, 30, 60, 120, 360, 720, 1440, entry.heartbeatMinutes])]
                                .sort((a, b) => a - b).map((value) => (
                                  <option value={value} key={value}>{t('agentSettings.everyMinutes', { count: value })}</option>
                                ))}
                            </select>
                          </label>
                          {dirty && <button type="button" className="b b-g b-sm" disabled={busyPod === entry.podId}
                            onClick={() => { void save(entry, { heartbeatEnabled: !off, heartbeatMinutes: minutes }); }}>
                            {t('agentSettings.saveInterval')}
                          </button>}
                        </>
                      );
                    })()}
                  </td>
                  <td>
                    <button type="button" className="b b-g ib b-sm" title={t('agentSettings.remove')}
                      aria-label={t('agentSettings.remove')} disabled={busyPod === entry.podId}
                      onClick={() => { void remove(entry); }}>
                      <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" /></svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="v2-agent-wake-pods__empty">{t('agentSettings.noPods')}</p>}
      </div>
    </div>
  );
};

export default V2AgentWakePods;
