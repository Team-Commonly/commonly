// Connectors — the v2 surface for channel bridges (Telegram today; Slack and
// Discord rows render read-only from the same catalog when they exist).
//
// The page is pure wiring over routes that already exist:
//   GET  /api/integrations/user/all   — my integrations, pod populated
//   POST /api/integrations            — telegram create auto-mints connectCode
//   PATCH /api/integrations/:id       — config merge (liveRelay persists since
//                                       the Integration schema declared it)
//
// Live relay is the demoed "channel = attention surface" mode: inbound chat
// messages post into the pod as the linked user and wake mentioned agents;
// outbound agent messages cross back only through the escalation gate.

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import { V2Pod } from '../hooks/useV2Pods';

interface ConnectorConfig {
  chatTitle?: string;
  connectCode?: string;
  liveRelay?: boolean;
}

interface Connector {
  _id: string;
  type: string;
  status: string;
  config?: ConnectorConfig;
  podId?: { _id: string; name?: string } | string | null;
}

const TYPE_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  groupme: 'GroupMe',
  x: 'X',
  instagram: 'Instagram',
};

const BOT_HANDLE = process.env.REACT_APP_TELEGRAM_BOT_HANDLE || '';

const podName = (c: Connector): string => (
  typeof c.podId === 'object' && c.podId ? (c.podId.name || 'Untitled pod') : 'Untitled pod'
);

const V2ConnectorsPage: React.FC = () => {
  const { t } = useTranslation();
  const api = useV2Api();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [pods, setPods] = useState<V2Pod[]>([]);
  const [newPodId, setNewPodId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<Connector[]>('/api/integrations/user/all');
      setConnectors(Array.isArray(data) ? data : []);
    } catch {
      setError(t('connectors.loadError', { defaultValue: 'Could not load connectors.' }));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<V2Pod[]>('/api/pods');
        // Same guard as the BYO picker: never offer public/community pods as a
        // bridge target — a channel bridge into a public room is an open relay.
        const eligible = (Array.isArray(data) ? data : []).filter(
          (p) => !['community', 'showcase'].includes((p as { type?: string }).type || ''),
        );
        if (!cancelled) {
          setPods(eligible);
          setNewPodId((prev) => prev || eligible[0]?._id || '');
        }
      } catch { /* pod picker just stays empty */ }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const createTelegram = async () => {
    if (!newPodId || creating) return;
    setCreating(true);
    setError(null);
    try {
      await api.post('/api/integrations', { podId: newPodId, type: 'telegram', config: {} });
      await load();
    } catch {
      setError(t('connectors.createError', { defaultValue: 'Could not create the connector.' }));
    } finally {
      setCreating(false);
    }
  };

  const toggleLiveRelay = async (c: Connector) => {
    if (busyId) return;
    setBusyId(c._id);
    setError(null);
    const next = !c.config?.liveRelay;
    try {
      // linkedUserId is deliberately NOT sent: the server derives the bridge's
      // attribution identity from the authenticated caller when liveRelay flips
      // on, and rejects any client-supplied value (impersonation guard).
      await api.patch(`/api/integrations/${c._id}`, {
        config: { liveRelay: next },
      });
      await load();
    } catch {
      setError(t('connectors.toggleError', { defaultValue: 'Could not update live relay.' }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="v2-connectors">
      <section className="v2-connectors__list" aria-label="Your connectors">
        {loading && (
          <div className="v2-connectors__empty">{t('connectors.loading', { defaultValue: 'Loading connectors…' })}</div>
        )}
        {!loading && connectors.length === 0 && (
          <div className="v2-connectors__empty">
            {t('connectors.empty', { defaultValue: 'No connectors yet. Link a channel below — your pod gets a voice where your team already talks.' })}
          </div>
        )}
        {connectors.map((c) => (
          <article key={c._id} className="v2-connectors__card">
            <div className="v2-connectors__card-head">
              <span className="v2-connectors__type">{TYPE_LABELS[c.type] || c.type}</span>
              <span className={`v2-connectors__status v2-connectors__status--${c.status === 'connected' ? 'connected' : 'pending'}`}>
                {c.status === 'connected'
                  ? t('connectors.connected', { defaultValue: 'Connected' })
                  : t('connectors.pending', { defaultValue: 'Waiting for the channel' })}
              </span>
            </div>
            <div className="v2-connectors__meta">
              <span>{podName(c)}</span>
              {c.config?.chatTitle && <span className="v2-connectors__chat">↔ {c.config.chatTitle}</span>}
            </div>
            {c.status !== 'connected' && c.type === 'telegram' && c.config?.connectCode && (
              <div className="v2-connectors__enable">
                {t('connectors.enableHint', { defaultValue: 'Open a private chat with the Commonly bot' })}
                {BOT_HANDLE ? ` (@${BOT_HANDLE.replace(/^@/, '')})` : ''}
                {t('connectors.enableHintSend', { defaultValue: ' and send:' })}
                <code>/commonly-enable {c.config.connectCode}</code>
              </div>
            )}
            {c.type === 'telegram' && c.status === 'connected' && (
              <label className="v2-connectors__relay">
                <input
                  type="checkbox"
                  checked={Boolean(c.config?.liveRelay)}
                  disabled={busyId === c._id}
                  onChange={() => toggleLiveRelay(c)}
                />
                <span>
                  <strong>{t('connectors.liveRelay', { defaultValue: 'Live relay' })}</strong>
                  {' — '}
                  {t('connectors.liveRelayHint', { defaultValue: 'chat messages post into the pod and wake mentioned agents; agent escalations reach the channel.' })}
                </span>
              </label>
            )}
          </article>
        ))}
      </section>

      <section className="v2-connectors__new" aria-label="Connect a channel">
        <h2>{t('connectors.newTitle', { defaultValue: 'Connect a channel' })}</h2>
        <div className="v2-connectors__new-row">
          <select
            className="v2-byo__input v2-connectors__select"
            value={newPodId}
            onChange={(e) => setNewPodId(e.target.value)}
            aria-label={t('connectors.podPicker', { defaultValue: 'Pod to bridge' })}
          >
            {pods.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
          <button
            type="button"
            className="v2-connectors__create"
            disabled={!newPodId || creating}
            onClick={createTelegram}
          >
            {creating
              ? t('connectors.creating', { defaultValue: 'Creating…' })
              : t('connectors.createTelegram', { defaultValue: 'New Telegram connector' })}
          </button>
        </div>
        <p className="v2-connectors__foot">
          {t('connectors.footnote', { defaultValue: 'You get a one-time code to send to the bot. More platforms are on the way.' })}
        </p>
      </section>

      {error && <div className="v2-connectors__error" role="alert">{error}</div>}
    </div>
  );
};

export default V2ConnectorsPage;
