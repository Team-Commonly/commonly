// Connectors — channel bridges, per Wren's connectors-v2 design spec rev 5
// (Connectors v2 pod, 2026-08-26). This ships the spec subset the deployed
// kernel supports today: platform tiles + tint tokens, dot-status with last
// activity, the relay-mode control (attention | mirror — the live
// relayAllAgentMessages flag), copy-command code treatment, SOON tiles, the
// ghost empty state, manage/disconnect, and 3s polling while a code is
// pending. The Commander card and per-pod gates (spec §2.0/§2.2) land with
// their kernel slices — per the spec's honesty rule, the page never renders a
// control the server does not enforce.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import { V2Pod } from '../hooks/useV2Pods';
import { PlatformGlyph } from '../icons/platforms';

interface ConnectorConfig {
  chatTitle?: string;
  connectCode?: string;
  connectCodeExpiresAt?: string;
  liveRelay?: boolean;
  relayAllAgentMessages?: boolean;
}

interface Connector {
  _id: string;
  // Installable-backed channel rows carry their parent binding. Older
  // integrations remain managed through the legacy route until migrated.
  installationId?: string;
  type: string;
  status: string;
  updatedAt?: string;
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

// Spec §2.3 — only Telegram is self-serve today; the rest render as SOON
// tiles (45% opacity, not buttons — no dead clicks).
const ADD_PLATFORMS: { type: string; enabled: boolean }[] = [
  { type: 'telegram', enabled: true },
  { type: 'slack', enabled: false },
  { type: 'discord', enabled: false },
  { type: 'whatsapp', enabled: false },
];

const BOT_HANDLE = process.env.REACT_APP_TELEGRAM_BOT_HANDLE || '';

// The route is keyed by the installable identity, which is the connector
// provider type in this Phase 1 projection. Do not pin this to Telegram: a
// future installable-backed provider must revoke its own parent.
export const installableLifecyclePath = (type: string): string => (
  `/api/installables/${encodeURIComponent(type)}/install`
);

const podName = (c: Connector): string => (
  typeof c.podId === 'object' && c.podId ? (c.podId.name || 'Untitled pod') : 'Untitled pod'
);

// Codes are 32 hex now (128-bit) — grouped in 4s, wrapping; legacy short
// codes flow through the same grouping (spec §2.3 step 2).
const groupCode = (code: string): string => (code.match(/.{1,4}/g) || [code]).join(' ');

const RECENT_MS = 10 * 60_000;

// Codes expire after 10 minutes server-side (#1297); a pending card past its
// expiry — or carrying a legacy code that never had one — offers a re-mint
// instead of a command that the webhook will refuse.
const codeIsLive = (c: Connector): boolean => Boolean(
  c.config?.connectCode
  && c.config?.connectCodeExpiresAt
  && new Date(c.config.connectCodeExpiresAt).getTime() > Date.now(),
);

const V2ConnectorsPage: React.FC = () => {
  const { t } = useTranslation();
  const api = useV2Api();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [pods, setPods] = useState<V2Pod[]>([]);
  const [newPodId, setNewPodId] = useState('');
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<Connector[]>('/api/integrations/user/all');
      setConnectors(Array.isArray(data) ? data : []);
      setError(null);
    } catch {
      setError(t('connectors.loadError', { defaultValue: 'Could not load connectors.' }));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => { load(); }, [load]);

  // Spec §2.3 step 3: poll while any code is pending; stop when it connects.
  const hasPending = connectors.some((c) => c.status !== 'connected' && codeIsLive(c));
  useEffect(() => {
    if (hasPending && !pollRef.current) {
      pollRef.current = setInterval(load, 3000);
    }
    if (!hasPending && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [hasPending, load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<V2Pod[]>('/api/pods');
        // Open-relay guard: never offer public/community pods as bridge targets.
        const eligible = (Array.isArray(data) ? data : []).filter(
          (p) => !['community', 'showcase'].includes((p as { type?: string }).type || ''),
        );
        if (!cancelled) {
          setPods(eligible);
          setNewPodId((prev) => prev || eligible[0]?._id || '');
        }
      } catch { /* picker stays empty */ }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const createTelegram = async () => {
    if (!newPodId || creating) return;
    setCreating(true);
    setError(null);
    try {
      await api.post('/api/installables/telegram/install', { podId: newPodId });
      setAdding(false);
      await load();
    } catch {
      setError(t('connectors.createError', { defaultValue: 'Could not create the connector.' }));
    } finally {
      setCreating(false);
    }
  };

  const patchConfig = async (c: Connector, config: Record<string, unknown>, errKey: string, errDefault: string) => {
    if (busyId) return;
    setBusyId(c._id);
    setError(null);
    try {
      await api.patch(`/api/integrations/${c._id}`, { config });
      await load();
    } catch {
      setError(t(errKey, { defaultValue: errDefault }));
    } finally {
      setBusyId(null);
    }
  };

  const regenerateCode = async (c: Connector) => {
    if (busyId) return;
    setBusyId(c._id);
    setError(null);
    try {
      await api.post(`/api/integrations/${c._id}/connect-code`, {});
      await load();
    } catch {
      setError(t('connectors.codeError', { defaultValue: 'Could not create a new code.' }));
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (c: Connector) => {
    setBusyId(c._id);
    try {
      if (c.installationId) {
        await api.del(installableLifecyclePath(c.type));
      } else {
        // The installable verb owns lifecycle for new Telegram bindings. Keep
        // older direct integrations disconnectable while their migration is
        // still an explicit, separate change.
        await api.patch(`/api/integrations/${c._id}`, { isActive: false });
      }
      setConfirmDisconnect(null);
      setManageId(null);
      await load();
    } catch {
      setError(t('connectors.disconnectError', { defaultValue: 'Could not disconnect.' }));
    } finally {
      setBusyId(null);
    }
  };

  const copyCommand = async (code: string) => {
    const cmd = `/commonly-enable ${code}`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(code);
      setTimeout(() => setCopied(null), 2000);
    } catch { /* clipboard unavailable — the code is selectable */ }
  };

  const statusLine = (c: Connector): { dot: string; pulse: boolean; text: string } => {
    if (c.status === 'error') {
      return { dot: 'danger', pulse: false, text: t('connectors.statusError', { defaultValue: 'Connection error — reconnect' }) };
    }
    if (c.status !== 'connected') {
      return { dot: 'warning', pulse: false, text: t('connectors.pending', { defaultValue: 'Waiting for the channel' }) };
    }
    const recent = c.updatedAt && (Date.now() - new Date(c.updatedAt).getTime()) < RECENT_MS;
    if (c.config?.liveRelay) {
      return recent
        ? { dot: 'success', pulse: true, text: t('connectors.statusLive', { defaultValue: 'Live · Active in the last few minutes' }) }
        : { dot: 'success', pulse: false, text: t('connectors.statusIdle', { defaultValue: 'Live · Quiet lately' }) };
    }
    return { dot: 'success', pulse: false, text: t('connectors.statusConnected', { defaultValue: 'Connected · Relay off' }) };
  };

  const renderCard = (c: Connector) => {
    const st = statusLine(c);
    const isTelegram = c.type === 'telegram';
    const connected = c.status === 'connected';
    const mirror = c.config?.relayAllAgentMessages === true;
    return (
      <article key={c._id} className={`v2-connector v2-connector--${c.type}`}>
        <div className="v2-connector__row">
          <span className={`v2-connector__tile v2-connector__tile--${c.type}`} aria-hidden="true">
            <PlatformGlyph type={c.type} />
          </span>
          <div className="v2-connector__body">
            <div className="v2-connector__title">
              <strong>{TYPE_LABELS[c.type] || c.type}</strong>
              <span className="v2-connector__meta">{podName(c)}{c.config?.chatTitle ? ` · ${c.config.chatTitle}` : ''}</span>
            </div>
            <div className="v2-connector__status">
              <span className={`v2-connector__dot v2-connector__dot--${st.dot}${st.pulse ? ' v2-connector__dot--pulse' : ''}`} />
              {st.text}
            </div>
          </div>
          {connected && isTelegram && (
            <button
              type="button"
              className="v2-connector__manage"
              onClick={() => { setManageId(manageId === c._id ? null : c._id); setConfirmDisconnect(null); }}
            >
              {t('connectors.manage', { defaultValue: 'Manage' })}
            </button>
          )}
        </div>

        {connected && isTelegram && (
          <div className="v2-connector__controls">
            <label className="v2-connector__relay">
              <input
                type="checkbox"
                checked={Boolean(c.config?.liveRelay)}
                disabled={busyId === c._id}
                onChange={() => patchConfig(c, { liveRelay: !c.config?.liveRelay }, 'connectors.toggleError', 'Could not update live relay.')}
              />
              <span>{t('connectors.liveRelay', { defaultValue: 'Relay' })}</span>
            </label>
            {c.config?.liveRelay && (
              <div className="v2-connector__mode" role="group" aria-label={t('connectors.mode', { defaultValue: 'Relay mode' })}>
                <button
                  type="button"
                  className={`v2-connector__mode-opt${!mirror ? ' v2-connector__mode-opt--on' : ''}`}
                  disabled={busyId === c._id || !mirror}
                  onClick={() => patchConfig(c, { relayAllAgentMessages: false }, 'connectors.modeError', 'Could not switch mode.')}
                >
                  {t('connectors.modeAttention', { defaultValue: 'Attention' })}
                </button>
                <button
                  type="button"
                  className={`v2-connector__mode-opt${mirror ? ' v2-connector__mode-opt--on' : ''}`}
                  disabled={busyId === c._id || mirror}
                  onClick={() => patchConfig(c, { relayAllAgentMessages: true }, 'connectors.modeError', 'Could not switch mode.')}
                >
                  {t('connectors.modeMirror', { defaultValue: 'Mirror' })}
                </button>
              </div>
            )}
            <span className="v2-connector__mode-hint">
              {c.config?.liveRelay
                ? (mirror
                  ? t('connectors.mirrorHint', { defaultValue: 'Every agent message reaches the channel.' })
                  : t('connectors.attentionHint', { defaultValue: 'Only escalations and the lead agent reach the channel.' }))
                : t('connectors.relayOffHint', { defaultValue: 'Messages stay in the pod.' })}
            </span>
          </div>
        )}

        {manageId === c._id && connected && (
          <div className="v2-connector__manage-panel">
            {confirmDisconnect === c._id ? (
              <button type="button" className="v2-connector__danger" disabled={busyId === c._id} onClick={() => disconnect(c)}>
                {t('connectors.disconnectConfirm', { defaultValue: 'Really disconnect — the channel goes quiet' })}
              </button>
            ) : (
              <button type="button" className="v2-connector__danger" onClick={() => setConfirmDisconnect(c._id)}>
                {t('connectors.disconnect', { defaultValue: 'Disconnect' })}
              </button>
            )}
          </div>
        )}

        {!connected && isTelegram && !codeIsLive(c) && (
          <div className="v2-connector__code-step">
            <div className="v2-connector__code-hint">
              {t('connectors.codeExpired', { defaultValue: 'The enable code expired.' })}
            </div>
            <button type="button" className="v2-connector__copy" disabled={busyId === c._id} onClick={() => regenerateCode(c)}>
              {t('connectors.newCode', { defaultValue: 'New code' })}
            </button>
          </div>
        )}

        {!connected && isTelegram && codeIsLive(c) && (
          <div className="v2-connector__code-step">
            <div className="v2-connector__code-hint">
              {t('connectors.enableHint', { defaultValue: 'Open a private chat with the Commonly bot' })}
              {BOT_HANDLE ? ` (@${BOT_HANDLE.replace(/^@/, '')})` : ''}
              {t('connectors.enableHintSend', { defaultValue: ' and send:' })}
            </div>
            <button type="button" className="v2-connector__copy" onClick={() => copyCommand(c.config?.connectCode || '')}>
              {copied === c.config?.connectCode
                ? t('connectors.copied', { defaultValue: 'Copied' })
                : t('connectors.copyCommand', { defaultValue: 'Copy command' })}
            </button>
            <code className="v2-connector__code">{groupCode(c.config?.connectCode || '')}</code>
          </div>
        )}
      </article>
    );
  };

  const addTiles = (
    <div className="v2-connector-add__tiles">
      {ADD_PLATFORMS.map((p) => (p.enabled ? (
        <button key={p.type} type="button" className="v2-connector-add__tile" onClick={() => setAdding(true)}>
          <span className={`v2-connector__tile v2-connector__tile--${p.type}`}><PlatformGlyph type={p.type} /></span>
          <span>{TYPE_LABELS[p.type]}</span>
        </button>
      ) : (
        <span key={p.type} className="v2-connector-add__tile v2-connector-add__tile--soon">
          <span className={`v2-connector__tile v2-connector__tile--${p.type}`}><PlatformGlyph type={p.type} /></span>
          <span>{TYPE_LABELS[p.type]}</span>
          <span className="v2-connector-add__soon">SOON</span>
        </span>
      )))}
    </div>
  );

  return (
    <div className="v2-connectors">
      {loading && <div className="v2-connectors__loading">{t('connectors.loading', { defaultValue: 'Loading connectors…' })}</div>}

      {!loading && connectors.length > 0 && (
        <section aria-label={t('connectors.channels', { defaultValue: 'Your channels' })}>
          <h2 className="v2-connectors__section">{t('connectors.channels', { defaultValue: 'Your channels' })}</h2>
          <div className="v2-connectors__list">{connectors.map(renderCard)}</div>
        </section>
      )}

      {!loading && connectors.length === 0 && (
        // Spec §2.4: the ghost card IS the add flow's pick state.
        <div className="v2-connector v2-connector--ghost">
          <p className="v2-connectors__empty-line">
            {t('connectors.empty', { defaultValue: 'Link a channel — every pod you’re in gets a voice where you already talk.' })}
          </p>
          {addTiles}
        </div>
      )}

      {!loading && connectors.length > 0 && (
        <section aria-label={t('connectors.add', { defaultValue: 'Add a channel' })}>
          <h2 className="v2-connectors__section">{t('connectors.add', { defaultValue: 'Add a channel' })}</h2>
          {addTiles}
        </section>
      )}

      {adding && (
        <div className="v2-connector v2-connector--add-form">
          <div className="v2-connectors__new-row">
            <select
              className="v2-byo__input v2-connectors__select"
              value={newPodId}
              onChange={(e) => setNewPodId(e.target.value)}
              aria-label={t('connectors.podPicker', { defaultValue: 'Pod to bridge' })}
            >
              {pods.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
            <button type="button" className="v2-connectors__create" disabled={!newPodId || creating} onClick={createTelegram}>
              {creating
                ? t('connectors.creating', { defaultValue: 'Creating…' })
                : t('connectors.createTelegram', { defaultValue: 'New Telegram connector' })}
            </button>
          </div>
          <p className="v2-connectors__foot">
            {t('connectors.footnote', { defaultValue: 'You get a one-time code to send to the bot. More platforms are on the way.' })}
          </p>
        </div>
      )}

      {error && <div className="v2-connectors__error" role="alert">{error}</div>}
    </div>
  );
};

export default V2ConnectorsPage;
