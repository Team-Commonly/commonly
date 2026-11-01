import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import V2Avatar from '../components/V2Avatar';
import V2AgentRuntimeGrants, { Runtime } from '../components/V2AgentRuntimeGrants';
import { AgentControlLoader } from '../components/V2AgentControlSection';
import { AgentConnection } from '../utils/agentConnection';
import { useAgentSettings } from './useAgentSettings';
import V2AgentIdentitySection from './V2AgentIdentitySection';
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
  const [connectionState, setConnectionState] = useState<AgentConnection['state'] | null>(null);
  const [connectionRefreshNonce, setConnectionRefreshNonce] = useState(0);
  const identityKey = `${agentName}:${instanceId}:${podId || ''}`;
  const currentIdentity = useRef(identityKey);
  currentIdentity.current = identityKey;
  const disconnected = connectionState === 'revoked' || connectionState === 'stale';

  const onConnectionState = useCallback((state: AgentConnection['state'] | null) => {
    setConnectionState(state);
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
    setConnectionState(null);
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

  return (
    <main className="v2-agent-settings v2-agent-settings-page">
      <header className="ph">
        <V2Avatar name={access.displayName || agentName} size="lg" kind="agent" seed={`${agentName}:${instanceId}`} />
        <div className="ahead">
          <h1>{access.displayName || agentName}</h1>
          <div className="st">{t('agentProfile.hero.activeInPods', { count: access.pods.length })}</div>
        </div>
        <span className="sp" />
        <nav className="seg" aria-label={t('agentSettings.tabs')}>
          <Link to={`/v2/agent/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`}>{t('agentSettings.profile')}</Link>
          <Link to={`/v2/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}/memory`}>{t('agentSettings.memory', { defaultValue: 'Memory' })}</Link>
          <button type="button" aria-current="page">{t('agentSettings.settings')}</button>
        </nav>
      </header>
      <div className="pbody">
        <div className="v2-agent-settings-page__col">
          <V2AgentWakePods agentName={agentName} instanceId={instanceId} updatePod={updatePod} onRemoved={onRemoved} />
          <h2 className="gtitle">{t('agentSettings.identityAccess')}</h2>
          <div className="list">
            <AgentControlLoader agentName={agentName} instanceId={instanceId}
              refreshNonce={connectionRefreshNonce} onConnectionState={onConnectionState} />
            <div className="lrow">
              <span className="lb"><span className={`dot${keysForbidden || disconnected ? ' dot--off' : ''}`} aria-hidden="true" /><svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 9.2-9.2M17 6l3 3M15 8l2 2" /></svg>{t('agentSettings.key')}</span>
              <span className="vl">{keysForbidden ? t('agentSettings.keyUnavailable') : activeKeys.length ? t('agentSettings.keyActive') : t('agentSettings.noActiveKeys')}</span>
              <span className="ac">
                {keysForbidden ? null : installation?.runtime?.runtimeType === 'wrapper' ? (
                  <span>{t('agentSettings.wrapperReconnect')}</span>
                ) : !disconnected && (
                  <button type="button" className="b b-g b-sm" onClick={() => setPendingAction('replace')} disabled={busy}>
                    {t('agentSettings.regenerate')}
                  </button>
                )}
              </span>
            </div>
            <div className="v2-agent-settings-page__keypanel">
                {error && <p role="alert" className="v2-agent-settings__error">{error}</p>}
                {pendingAction === 'replace' && !keysForbidden && (
                  <div className="v2-agent-settings__confirm" data-testid="agent-key-replace-confirmation">
                    <p>{t('agentByo.rekey.warning', { name: access.displayName || agentName })}</p>
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
                    <button type="button" onClick={() => setOneTimeKey(null)}>{t('agentSettings.done')}</button>
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
            </div>
            <div className="lrow">
              <span className="lb"><svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" /></svg>{t('agentSettings.memory', { defaultValue: 'Memory' })}</span>
              <span className="vl" />
              <span className="ac">
                <Link className="b b-g ib b-sm" to={`/v2/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}/memory`}
                  aria-label={t('agentSettings.openMemory')}
                  title={t('agentSettings.openMemory')}>
                  <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                </Link>
              </span>
            </div>
          </div>
        {installation && <V2AgentIdentitySection key={`${agentName}:${instanceId}`} installation={installation} update={update} />}
        <V2AgentRuntimeGrants
          key={`runtime:${agentName}:${instanceId}`}
          name={agentName}
          instanceId={instanceId}
          runtime={runtime}
          onSaveRuntime={runtimeEditable ? async (changes) => {
            await updateRuntime(changes);
          } : undefined}
        />
        <V2AgentPolicy key={`policy:${agentName}:${instanceId}`} agentName={agentName} instanceId={instanceId}
          installation={installation} update={update} />
        <div className="v2-agent-settings__section">
          <V2AgentSkills podId={podId} podName={access?.pods.find((pod) => pod.id === podId)?.name || podId} agentName={agentName} instanceId={instanceId} />
        </div>
        </div>
      </div>
    </main>
  );
};

export default V2AgentSettingsPage;
