import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../../utils/axiosConfig';
import V2PageHead from '../components/V2PageHead';
import './v2-agent-settings.css';

interface AgentAccess {
  displayName: string;
  pods: Array<{ id: string; name: string }>;
}

interface RuntimeKey {
  _id: string;
  label: string;
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
  const [access, setAccess] = useState<AgentAccess | null>(null);
  const [keys, setKeys] = useState<RuntimeKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'replace' | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oneTimeKey, setOneTimeKey] = useState<string | null>(null);

  const keyUrl = useCallback((podId: string) => (
    `/api/registry/pods/${encodeURIComponent(podId)}/agents/${encodeURIComponent(agentName)}/runtime-tokens`
  ), [agentName]);

  const loadKeys = useCallback(async () => {
    const response = await axios.get<RuntimeKey[]>('/api/credentials', {
      params: { agentName, instanceId },
    });
    setKeys(response.data || []);
  }, [agentName, instanceId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setAccess(null);
    setKeys([]);
    setError(null);
    setOneTimeKey(null);
    setPendingAction(null);
    const load = async () => {
      try {
        // This owner/admin endpoint gates the page and supplies an installed
        // pod for the existing pod-scoped token routes. Public profile data is
        // deliberately insufficient to render the Settings tab.
        const response = await axios.get<AgentAccess>(
          `/api/agent-memory/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`,
        );
        if (!active) return;
        const next = response.data;
        if (!next.pods?.length) throw new Error(t('agentSettings.noPod'));
        await loadKeys();
        if (active) setAccess(next);
      } catch (requestError) {
        if (active) setError(errorLabel(requestError, t('agentSettings.unavailable')));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [agentName, instanceId, loadKeys, t]);

  const replaceKey = async () => {
    if (!access || pendingAction !== 'replace' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await axios.post<{ token?: string }>(keyUrl(access.pods[0].id), {
        instanceId,
        label: 'Agent Settings replacement',
        force: true,
      });
      if (!response.data.token) throw new Error(t('agentSettings.missingReplacement'));
      setOneTimeKey(response.data.token);
      setPendingAction(null);
      await loadKeys();
    } catch (requestError) {
      setError(errorLabel(requestError, t('agentSettings.updateError')));
    } finally {
      setBusy(false);
    }
  };

  const revokeKey = async (tokenId: string) => {
    if (!access || pendingAction !== tokenId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await axios.delete(`/api/credentials/${encodeURIComponent(tokenId)}`, {
        params: { agentName, instanceId },
      });
      setPendingAction(null);
      setOneTimeKey(null);
      await loadKeys();
    } catch (requestError) {
      setError(errorLabel(requestError, t('agentSettings.updateError')));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="v2-agent-settings__state" role="status">{t('agentSettings.loading')}</div>;
  if (!access) return <div className="v2-agent-settings__state" role="alert">{error || t('agentSettings.unavailable')}</div>;

  return (
    <main className="v2-agent-settings">
      <V2PageHead title={access.displayName || agentName} actions={<Link to="/v2/agents">{t('agentSettings.yourTeam')}</Link>} />
      <nav className="v2-agent-settings__tabs" aria-label={t('agentSettings.tabs')}>
        <Link to={`/v2/agent/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`}>{t('agentSettings.profile')}</Link>
        <span aria-current="page">{t('agentSettings.settings')}</span>
      </nav>
      <section className="v2-agent-settings__section" aria-labelledby="agent-keys-title">
        <div className="v2-agent-settings__section-head">
          <h2 id="agent-keys-title">{t('agentSettings.key')}</h2>
          <button type="button" onClick={() => setPendingAction('replace')} disabled={busy}>
            {t('agentSettings.regenerate')}
          </button>
        </div>
        {error && <p role="alert" className="v2-agent-settings__error">{error}</p>}
        {pendingAction === 'replace' && (
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
        {keys.length === 0 ? <p className="v2-agent-settings__empty">{t('agentSettings.empty')}</p> : (
          <ul className="v2-agent-settings__keys">
            {keys.map((key) => (
              <li key={key._id} className="v2-agent-settings__key">
                <div className="v2-agent-settings__key-main">
                  <strong>{key.label || t('agentSettings.runtimeKey')}</strong>
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
            ))}
          </ul>
        )}
      </section>
    </main>
  );
};

export default V2AgentSettingsPage;
