import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import V2Avatar from '../components/V2Avatar';
import V2AgentRuntimeBody, { Runtime, V2AgentConnectorsRow, describeRuntime } from '../components/V2AgentRuntimeGrants';
import { AgentControlLoader } from '../components/V2AgentControlSection';
import { AgentConnection, connectionLabel } from '../utils/agentConnection';
import { usePhone } from '../connectors/usePhone';
import { useOpensOnDemand } from '../hooks/useOpensOnDemand';
import { localizeRelativeTime } from '../utils/localizeRelativeTime';
import { useAgentSettings } from './useAgentSettings';
import { useTalkToAgent } from './useTalkToAgent';
import V2AgentNameRow from './V2AgentNameRow';
import V2AgentListingRow from './V2AgentListingRow';
import V2AgentSettingsIcon from './V2AgentSettingsIcon';
import V2AgentWakePods from './V2AgentWakePods';
import V2AgentPolicy from './V2AgentPolicy';
import V2AgentSkills from '../components/V2AgentSkills';
import './v2-agent-settings.css';
import './v2-agent-settings-surface.css';

interface RuntimeKey {
  _id: string;
  label: string;
  machineId?: string | null;
  machineName?: string;
  createdAt?: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  status: 'active' | 'revoked';
}

const dateLabel = (value: string | null | undefined, t: (key: string) => string): string => {
  if (!value) return t('agentSettings.never');
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t('agentSettings.unknown') : date.toLocaleString();
};

// The owner memory index the Memory tab reads; only its counts are used here.
interface MemoryIndex { sections?: Array<{ updatedAt?: string | null; notes?: unknown[] }> }

const errorLabel = (error: unknown, fallback: string): string => (
  (error as { response?: { data?: { error?: string } } })?.response?.data?.error
  || (error instanceof Error && error.message)
  || fallback
);

const V2AgentSettingsPage: React.FC = () => {
  const { t } = useTranslation();
  const { agentName = '', instanceId = '' } = useParams<{ agentName: string; instanceId: string }>();
  const { access, installation, podId, ownKeyCapability, runtimeControls, runtimeObservation, runtimeInventory, processConnected, runtimeEditable, runtimeManaged, loading,
    error: loadError, refresh, update, updatePod, updateRuntime } = useAgentSettings(agentName, instanceId);
  const [removedLast, setRemovedLast] = useState(false);
  const [keys, setKeys] = useState<RuntimeKey[]>([]);
  const [keysReadyFor, setKeysReadyFor] = useState<string | null>(null);
  const [keysForbidden, setKeysForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'replace' | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oneTimeKey, setOneTimeKey] = useState<string | null>(null);
  const [connection, setConnection] = useState<AgentConnection | null>(null);
  const connectionState = connection?.state ?? null;
  // The key panel opens by itself for anything the owner must see or answer; a failed skills read opens
  // its panel, where the error is. Either way the row's toggle keeps working.
  const [keyOpen, setKeyOpen] = useOpensOnDemand(oneTimeKey, pendingAction, error);
  const keyToggleRef = useRef<HTMLButtonElement>(null);
  // Set by Done; the toggle is disabled until the key clears, so focus moves after that render.
  const refocusKeyToggle = useRef(false);
  useEffect(() => {
    if (oneTimeKey || !refocusKeyToggle.current) return;
    refocusKeyToggle.current = false;
    keyToggleRef.current?.focus();
  }, [oneTimeKey]);
  // undefined while the skills panel loads, null if its read failed.
  const [skillCount, setSkillCount] = useState<number | null | undefined>(undefined);
  const [skillsOpen, setSkillsOpen] = useOpensOnDemand(skillCount === null);
  const [runsNeedAttention, setRunsNeedAttention] = useState(false);
  const runsRef = useRef<HTMLDetailsElement>(null);
  // Open How it runs when its body starts needing action, and leave closing to the person,
  // so a fix (a successful move) doesn't snap shut over its own confirmation.
  useEffect(() => {
    if (runsNeedAttention && runsRef.current) runsRef.current.open = true;
  }, [runsNeedAttention]);
  const [memory, setMemory] = useState<{ notes: number; updatedAt: string | null } | null>(null);
  const navigate = useNavigate();
  // The same width the page's one-line phone rows start at.
  const phone = usePhone('(max-width: 600px)');
  const { talkTo, opening: openingRoom, failed: roomFailed } = useTalkToAgent(agentName, instanceId);
  const [connectionRefreshNonce, setConnectionRefreshNonce] = useState(0);
  const identityKey = `${agentName}:${instanceId}:${podId || ''}`;
  const currentIdentity = useRef(identityKey);
  currentIdentity.current = identityKey;
  const disconnected = connectionState === 'revoked' || connectionState === 'stale';

  const onConnectionState = useCallback((state: AgentConnection['state'] | null, next?: AgentConnection | null) => {
    setConnection(next ?? null);
    if (state === 'revoked' || state === 'stale') setPendingAction(null);
  }, []);

  const keyUrl = useCallback((podId: string) => (
    `/api/registry/pods/${encodeURIComponent(podId)}/agents/${encodeURIComponent(agentName)}/runtime-tokens`
  ), [agentName]);

  const fetchKeys = useCallback(async () => {
    const response = await axios.get<RuntimeKey[]>('/api/credentials', {
      params: { agentName, instanceId },
    });
    return response.data || [];
  }, [agentName, instanceId]);

  useEffect(() => {
    let active = true;
    setKeys([]);
    setKeysReadyFor(null);
    setKeysForbidden(false);
    setError(null);
    setOneTimeKey(null);
    setPendingAction(null);
    setBusy(false);
    setConnection(null);
    setKeyOpen(false);
    setSkillsOpen(false);
    setSkillCount(undefined);
    setRunsNeedAttention(false);
    if (access && podId) {
      void fetchKeys().then((rows) => {
        if (active) {
          setKeys(rows);
          setKeysReadyFor(identityKey);
        }
      }).catch((requestError) => {
        if (!active) return;
        if ((requestError as { response?: { status?: number } })?.response?.status === 403) {
          setKeysForbidden(true);
          setKeysReadyFor(identityKey);
        } else {
          setError(errorLabel(requestError, t('agentSettings.unavailable')));
        }
      });
    }
    return () => { active = false; };
  }, [access, podId, fetchKeys, identityKey, t]);

  // A key used or revoked from outside this page only shows up when the list
  // is re-read. Poll while the tab is visible, and re-read on focus.
  useEffect(() => {
    if (!access || !podId) return undefined;
    let active = true;
    let pending = false;
    const refreshKeys = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const rows = await fetchKeys();
        if (active) setKeys(rows);
      } catch {
        // Keep the last list; the next tick or focus retries.
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(refreshKeys, 15_000);
    window.addEventListener('focus', refreshKeys);
    document.addEventListener('visibilitychange', refreshKeys);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshKeys);
      document.removeEventListener('visibilitychange', refreshKeys);
    };
  }, [access, podId, fetchKeys]);

  // The Memory row's summary, from the same owner/admin index the Memory tab reads.
  // A viewer without identity-wide key access is not the owner, so it is not asked.
  const memoryReady = keysReadyFor === identityKey && !keysForbidden;
  useEffect(() => {
    setMemory(null);
    if (!memoryReady) return undefined;
    let active = true;
    void axios.get<MemoryIndex>(`/api/agent-memory/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId || 'default')}`)
      .then(({ data }) => {
        if (!active || !Array.isArray(data?.sections)) return;
        const notes = data.sections.reduce((count, section) => count + (Array.isArray(section.notes) ? section.notes.length : 0), 0);
        const updatedAt = data.sections.map((section) => section.updatedAt).filter((value): value is string => Boolean(value)).sort().pop() ?? null;
        setMemory({ notes, updatedAt });
      })
      .catch(() => { /* A refused or failed read leaves the row without a summary. */ });
    return () => { active = false; };
  }, [memoryReady, agentName, instanceId]);

  const replaceKey = async () => {
    if (!access || !podId || pendingAction !== 'replace' || busy || installation?.runtime?.runtimeType === 'wrapper') return;
    const requestIdentity = identityKey;
    setBusy(true);
    setError(null);
    try {
      const response = await axios.post<{ token?: string }>(keyUrl(podId), {
        instanceId,
        label: 'Agent Settings replacement',
        force: true,
      });
      if (currentIdentity.current !== requestIdentity) return;
      if (!response.data.token) throw new Error(t('agentSettings.missingReplacement'));
      setOneTimeKey(response.data.token);
      setPendingAction(null);
      const rows = await fetchKeys();
      if (currentIdentity.current === requestIdentity) {
        setKeys(rows);
        setConnectionRefreshNonce((nonce) => nonce + 1);
      }
    } catch (requestError) {
      if (currentIdentity.current === requestIdentity) setError(errorLabel(requestError, t('agentSettings.updateError')));
    } finally {
      if (currentIdentity.current === requestIdentity) setBusy(false);
    }
  };

  const revokeKey = async (tokenId: string) => {
    if (!access || pendingAction !== tokenId || busy) return;
    const requestIdentity = identityKey;
    setBusy(true);
    setError(null);
    try {
      await axios.delete(`/api/credentials/${encodeURIComponent(tokenId)}`, {
        params: { agentName, instanceId },
      });
      if (currentIdentity.current !== requestIdentity) return;
      setPendingAction(null);
      setOneTimeKey(null);
      const rows = await fetchKeys();
      if (currentIdentity.current === requestIdentity) {
        setKeys(rows);
        setConnectionRefreshNonce((nonce) => nonce + 1);
      }
    } catch (requestError) {
      if (currentIdentity.current === requestIdentity) setError(errorLabel(requestError, t('agentSettings.updateError')));
    } finally {
      if (currentIdentity.current === requestIdentity) setBusy(false);
    }
  };

  const onRemoved = (_podId: string, wasLastPod: boolean) => {
    if (!access) return;
    setKeys([]);
    setPendingAction(null);
    setOneTimeKey(null);
    if (wasLastPod) setRemovedLast(true);
    else void refresh().catch((requestError) => setError(errorLabel(requestError, t('agentSettings.unavailable'))));
  };

  if (loading) return <div className="v2-agent-settings__state" role="status">{t('agentSettings.loading')}</div>;
  if (removedLast) return <div className="v2-agent-settings__state" role="status">{t('agentSettings.noPod')}</div>;
  if (!access || !podId) return <div className="v2-agent-settings__state" role="alert">
    {error || errorLabel(loadError, t('agentSettings.unavailable'))}
  </div>;
  if (keysReadyFor !== identityKey) return <div className="v2-agent-settings__state" role={error ? 'alert' : 'status'}>
    {error || t('agentSettings.loading')}
  </div>;

  const environment = installation?.config?.environment;
  const controls = environment && typeof environment === 'object' && !Array.isArray(environment)
    ? environment as Record<string, unknown> : {};
  const runtime: Runtime = {
    runtimeType: installation?.runtime?.runtimeType,
    ...(installation?.runtime?.host === 'cloud' || installation?.runtime?.host === 'byo'
      ? { host: installation.runtime.host } : {}),
    adapter: installation?.runtime?.adapter,
    model: installation?.runtime?.model,
    effort: installation?.runtime?.effort,
    ...(typeof controls.adapter === 'string' ? { adapter: controls.adapter } : {}),
    ...(typeof controls.model === 'string' ? { model: controls.model } : {}),
    ...(typeof controls.effort === 'string' ? { effort: controls.effort } : {}),
    ...runtimeControls,
    observation: runtimeObservation, inventory: runtimeInventory, processConnected, ownKeyCapability,
    ...(runtimeManaged !== undefined ? { managed: runtimeManaged } : {}),
  };
  const activeKeys = keys.filter((key) => key.status === 'active');
  const revokedKeys = keys.filter((key) => key.status === 'revoked');
  const keyLabel = (key: RuntimeKey): string => {
    const defaultLabel = !key.label || key.label === 'Runtime token' || key.label === 'Agent Settings replacement';
    const kind = runtime.runtimeType === 'wrapper' ? t('agentSettings.cliKey') : t('agentSettings.runtimeKey');
    const detail = key.machineId ? key.machineName : (defaultLabel ? null : key.label);
    return detail ? `${kind} · ${detail}` : kind;
  };
  const renderKey = (key: RuntimeKey) => (
    <li key={key._id} className="v2-agent-settings__key">
      <div className="v2-agent-settings__key-main">
        <strong>{keyLabel(key)}</strong>
        <span>{key.status === 'revoked' ? t('agentSettings.revoked') : t('agentSettings.active')}</span>
      </div>
      <div className="v2-agent-settings__key-meta">
        <span>{t('agentSettings.created', { date: dateLabel(key.createdAt, t) })}</span>
        <span>{t('agentSettings.lastUsed', { date: dateLabel(key.lastUsedAt, t) })}</span>
        {key.status === 'revoked' && <span>{t('agentSettings.revokedAt', { date: dateLabel(key.revokedAt, t) })}</span>}
      </div>
      {key.status === 'active' && pendingAction === key._id && (
        <div className="v2-agent-settings__confirm">
          <p>{t('agentSettings.revokeWarning')}</p>
          <div className="v2-agent-settings__actions">
            <button type="button" disabled={busy} onClick={() => revokeKey(key._id)}>{t('agentSettings.revokeKey')}</button>
            <button type="button" disabled={busy} onClick={() => setPendingAction(null)}>{t('agentSettings.keepKey')}</button>
          </div>
        </div>
      )}
      {key.status === 'active' && pendingAction !== key._id && (
        <button type="button" className="v2-agent-settings__quiet" disabled={busy} onClick={() => setPendingAction(key._id)}>
          {t('agentSettings.revoke')}
        </button>
      )}
    </li>
  );

  const displayName = access.displayName || agentName;
  const newestUse = activeKeys.map((key) => key.lastUsedAt).filter((value): value is string => Boolean(value)).sort().pop();
  const runtimeDetails = describeRuntime(runtime);
  const runtimeSummary = [runtimeDetails.adapter || runtime.adapter || runtime.runtimeType, runtime.model].filter(Boolean).join(' · ');
  const processState = runtime.processConnected === true ? 'connected' : runtime.processConnected === false ? 'disconnected' : 'notReported';
  const memoryHref = `/v2/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}/memory`;
  const talkLabel = t('agentProfile.hero.talkTo', { name: displayName });
  const talkButton = (
    <button type="button" className="b b-s ib" title={talkLabel} aria-label={talkLabel} disabled={openingRoom} onClick={() => { void talkTo(); }}>
      <V2AgentSettingsIcon name="chat" />
    </button>
  );
  const status = (
    <div className="st">
      {connection && <span className={`dot${disconnected ? ' dot--off' : connection.state === 'connected' ? '' : ' dot--idle'}`} aria-hidden="true" />}
      {[connection && connectionLabel(connection, t), t('agentSettings.podCount', { count: access.pods.length })].filter(Boolean).join(' · ')}
    </div>
  );
  const tabs = (
    <nav className={`seg${phone ? ' seg--full' : ''}`} aria-label={t('agentSettings.tabs')}>
      <Link to={`/v2/agent/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`}>{t('agentSettings.profile')}</Link>
      <Link to={memoryHref}>{t('agentSettings.memory', { defaultValue: 'Memory' })}</Link>
      <button type="button" aria-current="page">{t('agentSettings.settings')}</button>
    </nav>
  );

  return (
    <main className="v2-agent-settings v2-agent-settings-page">
      {phone ? (
        <header className="mtop">
          <button type="button" className="b b-g ib" title={t('agentSettings.yourTeam')} aria-label={t('agentSettings.yourTeam')} onClick={() => navigate('/v2/agents')}>
            <V2AgentSettingsIcon name="back" />
          </button>
          <V2Avatar name={displayName} size="sm" kind="agent" seed={`${agentName}:${instanceId}`} />
          <h1 className="tt2">{displayName}</h1>
          {talkButton}
        </header>
      ) : (
        <header className="ph">
          <V2Avatar name={displayName} size="lg" kind="agent" seed={`${agentName}:${instanceId}`} />
          <div className="ahead">
            <h1>{displayName}</h1>
            {status}
          </div>
          <span className="sp" />
          {tabs}
          <span className="sp" />
          {talkButton}
        </header>
      )}
      <div className="pbody">
        <div className="v2-agent-settings-page__col">
          {phone && <>{tabs}<div className="v2-agent-settings-page__phonestatus">{status}</div></>}
          {roomFailed && <p role="alert" className="v2-agent-settings__error">{t('agentProfile.hero.openRoomFailed')}</p>}
          <V2AgentWakePods agentName={agentName} instanceId={instanceId} updatePod={updatePod} onRemoved={onRemoved} />
          <section className="v2-agent-settings-page__group" aria-labelledby="agent-identity-access">
            <h2 id="agent-identity-access" className="gtitle"><V2AgentSettingsIcon name="id" />{t('agentSettings.identityAccess')}</h2>
            <div className="list">
              {installation && <V2AgentNameRow key={`name:${agentName}:${instanceId}`} installation={installation} update={update} />}
              <div className="lrow">
                <span className="lb"><V2AgentSettingsIcon name="key" />{t('agentSettings.runtimeKey')}</span>
                <span className="vl">
                  {keysForbidden ? t('agentSettings.keyUnavailable') : <>
                    <span className={`dot${disconnected || !activeKeys.length ? ' dot--off' : ''}`} aria-hidden="true" />
                    {activeKeys.length ? t('agentSettings.keyActive') : t('agentSettings.noActiveKeys')}
                    {newestUse && <span className="mo">{t('agentSettings.keyUsed', { when: localizeRelativeTime(newestUse, t, { pastEvent: true }) })}</span>}
                  </>}
                </span>
                <span className="ac">
                  {!keysForbidden && (
                    <button type="button" className="b b-g ib b-sm" title={t('agentSettings.keyActions')} aria-label={t('agentSettings.keyActions')}
                      ref={keyToggleRef} aria-expanded={keyOpen} aria-controls="agent-key-panel"
                      // A key shown only once can't be folded away; Done is the way out of it.
                      disabled={Boolean(oneTimeKey)} onClick={() => setKeyOpen((value) => !value)}>
                      <V2AgentSettingsIcon name="more" />
                    </button>
                  )}
                </span>
              </div>
              {keyOpen && <div id="agent-key-panel" className="v2-agent-settings-page__keypanel">
                {error && <p role="alert" className="v2-agent-settings__error">{error}</p>}
                {!keysForbidden && (installation?.runtime?.runtimeType === 'wrapper' ? (
                  <p className="v2-agent-settings-page__live">{t('agentSettings.wrapperReconnect')}</p>
                ) : !disconnected && (
                  <div className="v2-agent-settings-page__actions">
                    <button type="button" className="b b-s b-sm" onClick={() => setPendingAction('replace')} disabled={busy}>
                      {t('agentSettings.regenerate')}
                    </button>
                  </div>
                ))}
                {pendingAction === 'replace' && !keysForbidden && (
                  <div className="v2-agent-settings__confirm" data-testid="agent-key-replace-confirmation">
                    <p>{t('agentByo.rekey.warning', { name: displayName })}</p>
                    <div className="v2-agent-settings__actions">
                      <button type="button" disabled={busy} onClick={replaceKey}>{t('agentByo.rekey.replace')}</button>
                      <button type="button" disabled={busy} onClick={() => setPendingAction(null)}>{t('agentByo.rekey.cancel')}</button>
                    </div>
                  </div>
                )}
                {oneTimeKey && (
                  <div className="v2-agent-settings__reveal">
                    <strong>{t('agentSettings.copyNow')}</strong>
                    <code data-testid="agent-one-time-key">{oneTimeKey}</code>
                    <button type="button" onClick={() => {
                      // The key is gone once dismissed, so the panel closes and focus returns to its toggle.
                      refocusKeyToggle.current = true;
                      setOneTimeKey(null);
                      setKeyOpen(false);
                    }}>{t('agentSettings.done')}</button>
                  </div>
                )}
                {!keysForbidden && (
                  <>
                    {activeKeys.length ? <ul className="v2-agent-settings__keys">{activeKeys.map(renderKey)}</ul>
                      : null}
                    {revokedKeys.length > 0 && <details className="v2-agent-settings__revoked-keys">
                      <summary>{t('agentSettings.revokedCount', { count: revokedKeys.length })}</summary>
                      <ul className="v2-agent-settings__keys">{revokedKeys.map(renderKey)}</ul>
                    </details>}
                  </>
                )}
              </div>}
              <AgentControlLoader agentName={agentName} instanceId={instanceId} hideWhenConnected
                refreshNonce={connectionRefreshNonce} onConnectionState={onConnectionState} />
              <V2AgentListingRow key={`listing:${agentName}:${instanceId}`} agentName={installation?.name || agentName} instanceId={installation?.instanceId || instanceId} />
              <V2AgentConnectorsRow key={`grants:${agentName}:${instanceId}`} name={agentName} instanceId={instanceId} />
              <div className="lrow">
                <span className="lb"><V2AgentSettingsIcon name="brain" />{t('agentSettings.memory', { defaultValue: 'Memory' })}</span>
                <span className="vl">
                  {memory && <>
                    {t('agentSettings.memoryNotes', { count: memory.notes })}
                    {memory.updatedAt && <span className="mo">{t('agentSettings.memorySaved', { when: localizeRelativeTime(memory.updatedAt, t, { pastEvent: true }) })}</span>}
                  </>}
                </span>
                <span className="ac">
                  <Link className="b b-g ib b-sm" to={memoryHref} aria-label={t('agentSettings.openMemory')} title={t('agentSettings.openMemory')}>
                    <V2AgentSettingsIcon name="chevr" />
                  </Link>
                </span>
              </div>
              <div className="lrow">
                <span className="lb"><V2AgentSettingsIcon name="grid" />{t('agentSkills.title')}</span>
                <span className="vl">
                  {typeof skillCount === 'number' && (skillCount > 0
                    ? t('agentSettings.skillCount', { count: skillCount })
                    : <span className="mu">{t('agentSettings.none')}</span>)}
                </span>
                <span className="ac">
                  <button type="button" className="b b-g ib b-sm v2-agent-settings-page__toggle" title={t('agentSkills.title')} aria-label={t('agentSkills.title')}
                    aria-expanded={skillsOpen} aria-controls="agent-skills-panel" onClick={() => setSkillsOpen((value) => !value)}>
                    <V2AgentSettingsIcon name="chev" />
                  </button>
                </span>
              </div>
              {/* Mounted while closed, so the row can count what the panel loads. */}
              <div id="agent-skills-panel" className="v2-agent-settings-page__panel v2-agent-settings-page__panel--pad" hidden={!skillsOpen}>
                <V2AgentSkills podId={podId} podName={access.pods.find((pod) => pod.id === podId)?.name || podId}
                  agentName={agentName} instanceId={instanceId} onCount={setSkillCount} />
              </div>
              {/* Opens by itself when the machine placement needs a move or failed. */}
              <details className="disc" data-testid="agent-how-it-runs" ref={runsRef}>
                <summary>
                  <span className="lb"><V2AgentSettingsIcon name="cpu" />{t('agentManage.controls.title')}</span>
                  <span className="vl">{runtimeSummary || t('agentManage.controls.notReported')}
                    <span className="mo">{t(`agentManage.controls.${processState}`)}</span>
                  </span>
                  <V2AgentSettingsIcon name="chev" className="chev" />
                </summary>
                <div className="dbody v2-agent-settings-page__runsbody">
                  <V2AgentRuntimeBody
                    key={`runtime:${agentName}:${instanceId}`}
                    name={agentName}
                    instanceId={instanceId}
                    runtime={runtime}
                    onNeedsAttention={setRunsNeedAttention}
                    onSaveRuntime={runtimeEditable ? async (changes) => {
                      await updateRuntime(changes);
                    } : undefined}
                  />
                  <V2AgentPolicy key={`policy:${agentName}:${instanceId}`} agentName={agentName} instanceId={instanceId}
                    installation={installation} update={update} />
                </div>
              </details>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
};

export default V2AgentSettingsPage;
