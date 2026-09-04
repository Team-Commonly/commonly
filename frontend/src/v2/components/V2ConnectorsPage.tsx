// Connectors — the Signal Coverage artboard's channel list. It deliberately
// renders only controls the Phase 1 connector service already enforces.

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
  pendingBind?: {
    teamName?: string;
    slackUserName?: string;
    expiresAt?: string;
  };
}

interface Connector {
  _id: string;
  installationId?: string;
  type: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  config?: ConnectorConfig;
  podId?: { _id: string; name?: string } | string | null;
}

interface InstallResponse {
  status?: 'active' | 'installing' | 'activating' | 'uninstalling';
  boundPodId?: string;
}

interface InstallErrorResponse {
  code?: string;
  boundPodId?: string;
}

interface SlackAuthorizeResponse {
  authorizeUrl?: string;
}

type ConnectorAction = 'manage' | 'show-code' | 'new-code' | 'authorize' | 'confirm';

interface ConnectorRow {
  action: ConnectorAction | null;
  actionLabel?: string;
  detail: string;
  dot: 'live' | 'idle' | 'pending' | 'empty';
  line: string;
  pulse: boolean;
  when: string;
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

// The catalog route from TASK-009 will make readiness server-owned. Until it
// lands, this is intentionally limited to the two providers this page can use.
const ADD_PLATFORMS = [
  { type: 'telegram', enabled: true },
  { type: 'slack', enabled: true },
];
const UNAVAILABLE_PLATFORM_LABELS = ['Discord', 'WhatsApp'];

const BOT_HANDLE = process.env.REACT_APP_TELEGRAM_BOT_HANDLE || '';
const RECENT_MS = 10 * 60_000;

export const installableLifecyclePath = (type: string): string => (
  `/api/installables/${encodeURIComponent(type)}/install`
);

const installErrorResponse = (error: unknown): { status?: number; data?: InstallErrorResponse } => (
  (error as { response?: { status?: number; data?: InstallErrorResponse } })?.response || {}
);

const podName = (connector: Connector): string => (
  typeof connector.podId === 'object' && connector.podId ? (connector.podId.name || 'Untitled pod') : 'Untitled pod'
);

const boundPodName = (boundPodId: string | undefined, connectors: Connector[], pods: V2Pod[]): string => {
  const existing = connectors.find((connector) => {
    const podId = typeof connector.podId === 'object' ? connector.podId?._id : connector.podId;
    return String(podId) === String(boundPodId);
  });
  const boundPod = pods.find((pod) => String(pod._id) === String(boundPodId));
  return existing ? podName(existing) : (boundPod?.name || 'another pod');
};

const groupCode = (code: string): string => (code.match(/.{1,4}/g) || [code]).join(' ');

const codeIsLive = (connector: Connector): boolean => Boolean(
  connector.config?.connectCode
  && connector.config?.connectCodeExpiresAt
  && new Date(connector.config.connectCodeExpiresAt).getTime() > Date.now(),
);

const relativeTime = (date?: string): string => {
  const timestamp = date ? new Date(date).getTime() : NaN;
  if (!Number.isFinite(timestamp)) return 'just now';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const V2ConnectorsPage: React.FC = () => {
  const { t } = useTranslation();
  const api = useV2Api();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [pods, setPods] = useState<V2Pod[]>([]);
  const [newPodId, setNewPodId] = useState('');
  const [addingType, setAddingType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slackCallbackError, setSlackCallbackError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const adding = addingType !== null;

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

  useEffect(() => { void load(); }, [load]);

  // The Slack callback resolves in its own tab. Consume its opaque result and
  // leave no state or error code in the browser URL.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const slackState = query.get('slack');
    if (slackState !== 'pending' && slackState !== 'error') return;
    if (slackState === 'pending') {
      void load();
    } else {
      setSlackCallbackError(t('connectors.slackCallbackError', {
        defaultValue: 'Slack authorization didn’t complete — try again.',
      }));
    }
    query.delete('slack');
    query.delete('code');
    const remaining = query.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${remaining ? `?${remaining}` : ''}${window.location.hash}`,
    );
  }, [load, t]);

  const hasPending = connectors.some((connector) => connector.status !== 'connected' && (
    (connector.type === 'telegram' && codeIsLive(connector))
    || (connector.type === 'slack' && (codeIsLive(connector) || Boolean(connector.config?.pendingBind)))
  ));
  useEffect(() => {
    if (hasPending && !pollRef.current) pollRef.current = setInterval(load, 3000);
    if (!hasPending && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [hasPending, load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get<V2Pod[]>('/api/pods');
        const eligible = (Array.isArray(data) ? data : []).filter(
          (pod) => !['community', 'showcase'].includes((pod as { type?: string }).type || ''),
        );
        if (!cancelled) {
          setPods(eligible);
          setNewPodId((current) => current || eligible[0]?._id || '');
        }
      } catch {
        // The picker stays empty when no eligible pod can be read.
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const createConnector = async () => {
    if (!newPodId || !addingType || creating) return;
    const type = addingType;
    const typeLabel = TYPE_LABELS[type] || type;
    const installInProgressMessage = (boundPodId?: string): string => (
      boundPodId
        ? t('connectors.installInProgressForPod', {
          defaultValue: 'Still setting up for {{pod}} — try again in a moment.',
          pod: boundPodName(boundPodId, connectors, pods),
        })
        : t('connectors.installInProgress', { defaultValue: 'Still setting up — try again in a moment.' })
    );
    setCreating(true);
    setError(null);
    try {
      const result = await api.post<InstallResponse>(installableLifecyclePath(type), { podId: newPodId });
      if (result.status && result.status !== 'active') {
        setError(installInProgressMessage(result.boundPodId));
        return;
      }
      setAddingType(null);
      await load();
    } catch (requestError) {
      const response = installErrorResponse(requestError);
      if (response.status === 409 && response.data?.code === 'install_in_progress') {
        setError(installInProgressMessage(response.data.boundPodId));
      } else if (response.status === 409 && response.data?.code === 'already_installed') {
        setError(t('connectors.alreadyBound', {
          defaultValue: 'Your {{connector}} channel is bound to {{pod}}. Disconnect it to bind a different pod.',
          connector: typeLabel,
          pod: boundPodName(response.data.boundPodId, connectors, pods),
        }));
      } else {
        setError(t('connectors.createError', { defaultValue: 'Could not create the connector.' }));
      }
    } finally {
      setCreating(false);
    }
  };

  const patchConfig = async (connector: Connector, config: Record<string, unknown>, errorKey: string, errorDefault: string) => {
    if (busyId) return;
    setBusyId(connector._id);
    setError(null);
    try {
      await api.patch(`/api/integrations/${connector._id}`, { config });
      await load();
    } catch {
      setError(t(errorKey, { defaultValue: errorDefault }));
    } finally {
      setBusyId(null);
    }
  };

  const regenerateCode = async (connector: Connector) => {
    if (busyId) return;
    setBusyId(connector._id);
    setError(null);
    try {
      await api.post(`/api/integrations/${connector._id}/connect-code`, {});
      await load();
    } catch {
      setError(t('connectors.codeError', { defaultValue: 'Could not create a new code.' }));
    } finally {
      setBusyId(null);
    }
  };

  const authorizeSlack = async (connector: Connector) => {
    if (busyId) return;
    const authorizationWindow = window.open('', '_blank');
    setBusyId(connector._id);
    setError(null);
    try {
      const result = await api.post<SlackAuthorizeResponse>(
        '/api/installables/slack/authorize-url',
        {},
        { withCredentials: true },
      );
      if (!result.authorizeUrl) throw new Error('Slack authorization URL was missing');
      if (authorizationWindow) {
        authorizationWindow.opener = null;
        authorizationWindow.location.assign(result.authorizeUrl);
      } else {
        window.location.assign(result.authorizeUrl);
      }
    } catch {
      authorizationWindow?.close();
      setError(t('connectors.slackAuthorizeError', {
        defaultValue: 'Could not begin Slack authorization. Try again in a moment.',
      }));
    } finally {
      setBusyId(null);
    }
  };

  const resolveSlackBind = async (connector: Connector, action: 'confirm' | 'reject') => {
    if (busyId) return;
    setBusyId(connector._id);
    setError(null);
    try {
      await api.post(`/api/installables/slack/${action}`, {});
      await load();
    } catch {
      setError(t('connectors.slackBindError', {
        defaultValue: 'Could not update the Slack connection. Try again in a moment.',
      }));
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (connector: Connector) => {
    setBusyId(connector._id);
    try {
      if (connector.installationId) {
        await api.del(installableLifecyclePath(connector.type));
      } else {
        await api.patch(`/api/integrations/${connector._id}`, { isActive: false });
      }
      setConfirmDisconnect(null);
      setSelectedId(null);
      await load();
    } catch {
      setError(t('connectors.disconnectError', { defaultValue: 'Could not disconnect.' }));
    } finally {
      setBusyId(null);
    }
  };

  const copyCommand = async (code: string) => {
    const command = `/commonly-enable ${code}`;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(code);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard access is optional; the command remains selectable.
    }
  };

  const rowFor = (connector: Connector): ConnectorRow => {
    const started = `started ${relativeTime(connector.createdAt)}`;
    const isTelegram = connector.type === 'telegram';
    const isSlack = connector.type === 'slack';

    if (connector.status === 'error') {
      return {
        action: isTelegram ? 'new-code' : isSlack ? 'authorize' : null,
        actionLabel: isTelegram ? t('connectors.newCode', { defaultValue: 'New code' }) : t('connectors.slackAuthorize', { defaultValue: 'Authorize in Slack' }),
        detail: t('connectors.errorReconnect', { defaultValue: 'reconnect to resume' }),
        dot: 'empty',
        line: t('connectors.errorLine', { defaultValue: 'The connection dropped.' }),
        pulse: false,
        when: `since ${relativeTime(connector.updatedAt || connector.createdAt)}`,
      };
    }

    if (connector.status === 'connected') {
      const relay = Boolean(connector.config?.liveRelay);
      const mirror = connector.config?.relayAllAgentMessages === true;
      const recent = connector.updatedAt && (Date.now() - new Date(connector.updatedAt).getTime()) < RECENT_MS;
      return {
        action: (isTelegram || isSlack) ? 'manage' : null,
        actionLabel: t('connectors.manage', { defaultValue: 'Manage' }),
        detail: relay
          ? (mirror
            ? t('connectors.rowMirror', { defaultValue: 'every agent line reaches the channel' })
            : t('connectors.rowAttention', { defaultValue: 'attention mode · escalations reach the channel' }))
          : t('connectors.rowRelayOff', { defaultValue: 'relay off · messages stay in the pod' }),
        dot: relay ? 'live' : 'idle',
        line: `${connector.config?.chatTitle || TYPE_LABELS[connector.type] || connector.type} · linked to ${podName(connector)}`,
        pulse: relay && Boolean(recent),
        when: `added ${relativeTime(connector.createdAt)}`,
      };
    }

    if (isTelegram && codeIsLive(connector)) {
      return {
        action: 'show-code',
        actionLabel: t('connectors.showCode', { defaultValue: 'Show code' }),
        detail: t('connectors.codeExpires', { defaultValue: 'code expires soon' }),
        dot: 'pending',
        line: t('connectors.waitingTelegram', { defaultValue: 'Waiting for one message in your Telegram chat.' }),
        pulse: true,
        when: started,
      };
    }

    if (isTelegram) {
      return {
        action: 'new-code',
        actionLabel: t('connectors.newCode', { defaultValue: 'New code' }),
        detail: t('connectors.nothingSent', { defaultValue: 'nothing was sent' }),
        dot: 'empty',
        line: t('connectors.codeExpired', { defaultValue: 'The enable code expired.' }),
        pulse: false,
        when: started,
      };
    }

    if (isSlack && connector.config?.pendingBind) {
      const workspace = connector.config.pendingBind.teamName || 'This Slack workspace';
      const user = connector.config.pendingBind.slackUserName ? `@${connector.config.pendingBind.slackUserName}` : 'your Slack user';
      return {
        action: 'confirm',
        actionLabel: t('connectors.slackConfirm', { defaultValue: 'Confirm' }),
        detail: t('connectors.slackConfirmDetail', { defaultValue: 'waiting for you to confirm' }),
        dot: 'pending',
        line: t('connectors.slackConfirmRow', { defaultValue: '{{workspace}} says {{user}} connected — is that you?', workspace, user }),
        pulse: true,
        when: `Slack answered ${relativeTime(connector.updatedAt || connector.createdAt)}`,
      };
    }

    if (isSlack) {
      return {
        action: 'authorize',
        actionLabel: t('connectors.slackAuthorize', { defaultValue: 'Authorize in Slack' }),
        detail: t('connectors.slackAuthorizeDetail', { defaultValue: 'one click in Slack' }),
        dot: 'empty',
        line: t('connectors.slackAuthorizeHint', { defaultValue: 'Authorize Commonly in your Slack workspace to connect your DM.' }),
        pulse: false,
        when: started,
      };
    }

    return {
      action: null,
      detail: t('connectors.pending', { defaultValue: 'Waiting for the channel' }),
      dot: 'empty',
      line: `${TYPE_LABELS[connector.type] || connector.type} is waiting to connect.`,
      pulse: false,
      when: started,
    };
  };

  const selectedConnector = connectors.find((connector) => connector._id === selectedId)
    || connectors.find((connector) => {
      const action = rowFor(connector).action;
      return action !== null && action !== 'manage';
    })
    || connectors[0]
    || null;

  const selectConnector = (connector: Connector) => {
    setSelectedId(connector._id);
    setConfirmDisconnect(null);
  };

  const runAction = (connector: Connector, action: ConnectorAction) => {
    selectConnector(connector);
    if (action === 'new-code') return regenerateCode(connector);
    if (action === 'authorize') return authorizeSlack(connector);
    if (action === 'confirm') return resolveSlackBind(connector, 'confirm');
    return undefined;
  };

  const renderRow = (connector: Connector) => {
    const row = rowFor(connector);
    const selected = selectedConnector?._id === connector._id;
    const isManage = row.action === 'manage';
    return (
      <article key={connector._id} className={`v2-connector-row${selected ? ' v2-connector-row--selected' : ''}`}>
        <button
          type="button"
          className="v2-connector-row__selection"
          aria-pressed={selected}
          aria-label={t('connectors.viewChannel', { defaultValue: 'View {{channel}}', channel: TYPE_LABELS[connector.type] || connector.type })}
          onClick={() => selectConnector(connector)}
        >
          <span className="v2-connector-row__name">
            <span className={`v2-connector-row__dot v2-connector-row__dot--${row.dot}${row.pulse ? ' v2-connector-row__dot--pulse' : ''}`} aria-hidden="true" />
            <span className="v2-connector-row__glyph" aria-hidden="true"><PlatformGlyph type={connector.type} /></span>
            <span>{TYPE_LABELS[connector.type] || connector.type}</span>
          </span>
          <span className="v2-connector-row__details">
            <strong>{row.line}</strong>
            <span className="v2-connector-row__detail">{row.detail}</span>
          </span>
          <span className="v2-connector-row__when">{row.when}</span>
        </button>
        {row.action && (
          <button
            type="button"
            className={`v2-connector-row__action${isManage ? ' v2-connector-row__action--secondary' : ''}`}
            disabled={busyId === connector._id && !isManage}
            onClick={() => { void runAction(connector, row.action as ConnectorAction); }}
          >
            {busyId === connector._id && row.action === 'authorize'
              ? t('connectors.slackAuthorizing', { defaultValue: 'Opening Slack…' })
              : row.actionLabel}
          </button>
        )}
      </article>
    );
  };

  const renderAside = (connector: Connector) => {
    const isTelegram = connector.type === 'telegram';
    const isSlack = connector.type === 'slack';
    const connected = connector.status === 'connected';
    const supportsRelayControls = isTelegram || isSlack;
    const mirror = connector.config?.relayAllAgentMessages === true;
    const row = rowFor(connector);
    const pendingBind = connector.config?.pendingBind;

    return (
      <aside className="v2-connectors__aside" aria-label={t('connectors.channelDetails', { defaultValue: 'Channel details' })}>
        {!connected && (
          <section className="v2-connector-aside__step">
            <p className="v2-connector-aside__eyebrow">{t('connectors.nextStep', { defaultValue: 'Next step' })}</p>
            {isTelegram && codeIsLive(connector) && (
              <>
                <p>
                  {t('connectors.enableHint', { defaultValue: 'Open a private chat with the Commonly bot' })}
                  {BOT_HANDLE ? ` (@${BOT_HANDLE.replace(/^@/, '')})` : ''}
                  {t('connectors.enableHintSend', { defaultValue: ' and send:' })}
                </p>
                <div className="v2-connector-code">
                  <code>/commonly-enable {groupCode(connector.config?.connectCode || '')}</code>
                  <button type="button" className="v2-connector-code__copy" onClick={() => copyCommand(connector.config?.connectCode || '')}>
                    {copied === connector.config?.connectCode
                      ? t('connectors.copied', { defaultValue: 'Copied' })
                      : t('connectors.copyCommand', { defaultValue: 'Copy command' })}
                  </button>
                </div>
              </>
            )}
            {isTelegram && connector.status !== 'error' && !codeIsLive(connector) && (
              <>
                <p>{row.line}</p>
                <button type="button" className="v2-connector-aside__primary" disabled={busyId === connector._id} onClick={() => { void regenerateCode(connector); }}>
                  {t('connectors.newCode', { defaultValue: 'New code' })}
                </button>
              </>
            )}
            {isSlack && pendingBind && (
              <>
                <p>{t('connectors.slackConfirmHint', {
                  defaultValue: '{{workspace}} wants to connect as {{user}}.',
                  workspace: pendingBind.teamName || 'This Slack workspace',
                  user: pendingBind.slackUserName ? `@${pendingBind.slackUserName}` : 'your Slack user',
                })}</p>
                <div className="v2-connector-aside__actions">
                  <button type="button" className="v2-connector-aside__primary" disabled={busyId === connector._id} onClick={() => { void resolveSlackBind(connector, 'confirm'); }}>
                    {t('connectors.slackConfirm', { defaultValue: 'Confirm connection' })}
                  </button>
                  <button type="button" className="v2-connector-aside__secondary" disabled={busyId === connector._id} onClick={() => { void resolveSlackBind(connector, 'reject'); }}>
                    {t('connectors.slackReject', { defaultValue: 'This is not me' })}
                  </button>
                </div>
              </>
            )}
            {isSlack && !pendingBind && connector.status !== 'error' && (
              <>
                <p>{row.line}</p>
                <button type="button" className="v2-connector-aside__primary" disabled={busyId === connector._id} onClick={() => { void authorizeSlack(connector); }}>
                  {t('connectors.slackAuthorize', { defaultValue: 'Authorize in Slack' })}
                </button>
              </>
            )}
            {connector.status === 'error' && (
              <>
                <p>{row.line}</p>
                {row.action && (
                  <button type="button" className="v2-connector-aside__primary" disabled={busyId === connector._id} onClick={() => { void runAction(connector, row.action as ConnectorAction); }}>
                    {row.actionLabel}
                  </button>
                )}
              </>
            )}
          </section>
        )}

        {supportsRelayControls && (
          <section className="v2-connector-aside__card">
            <h2>{t('connectors.channelSees', { defaultValue: 'What the channel sees' })}</h2>
            <p>
              {connector.config?.liveRelay
                ? (mirror
                  ? t('connectors.mirrorHint', { defaultValue: 'Every agent message reaches the channel.' })
                  : t('connectors.attentionHint', { defaultValue: 'Only escalations and the lead agent reach the channel.' }))
                : t('connectors.relayOffHint', { defaultValue: 'Messages stay in the pod.' })}
            </p>
            {connected && (
              <div className="v2-connector-aside__controls">
                <label className="v2-connector-aside__relay">
                  <input
                    type="checkbox"
                    checked={Boolean(connector.config?.liveRelay)}
                    disabled={busyId === connector._id}
                    onChange={() => patchConfig(connector, { liveRelay: !connector.config?.liveRelay }, 'connectors.toggleError', 'Could not update live relay.')}
                  />
                  <span>{t('connectors.liveRelay', { defaultValue: 'Relay' })}</span>
                </label>
                {connector.config?.liveRelay && (
                  <div className="v2-connector-aside__mode" role="group" aria-label={t('connectors.mode', { defaultValue: 'Relay mode' })}>
                    <button
                      type="button"
                      className={!mirror ? 'v2-connector-aside__mode-opt v2-connector-aside__mode-opt--on' : 'v2-connector-aside__mode-opt'}
                      disabled={busyId === connector._id || !mirror}
                      onClick={() => patchConfig(connector, { relayAllAgentMessages: false }, 'connectors.modeError', 'Could not switch mode.')}
                    >
                      {t('connectors.modeAttention', { defaultValue: 'Attention' })}
                    </button>
                    <button
                      type="button"
                      className={mirror ? 'v2-connector-aside__mode-opt v2-connector-aside__mode-opt--on' : 'v2-connector-aside__mode-opt'}
                      disabled={busyId === connector._id || mirror}
                      onClick={() => patchConfig(connector, { relayAllAgentMessages: true }, 'connectors.modeError', 'Could not switch mode.')}
                    >
                      {t('connectors.modeMirror', { defaultValue: 'Mirror' })}
                    </button>
                  </div>
                )}
              </div>
            )}
            {confirmDisconnect === connector._id ? (
              <button type="button" className="v2-connector-aside__primary" disabled={busyId === connector._id} onClick={() => { void disconnect(connector); }}>
                {t('connectors.disconnectConfirm', { defaultValue: 'Really disconnect — the channel goes quiet' })}
              </button>
            ) : (
              <button type="button" className="v2-connector-aside__secondary" onClick={() => setConfirmDisconnect(connector._id)}>
                {t('connectors.disconnect', { defaultValue: 'Disconnect' })}
              </button>
            )}
          </section>
        )}
      </aside>
    );
  };

  const hasInstallation = (type: string): boolean => connectors.some(
    (connector) => connector.type === type && Boolean(connector.installationId),
  );
  const availableProviders = ADD_PLATFORMS.filter((provider) => provider.enabled && !hasInstallation(provider.type));
  const renderAddForm = (aside = false) => (
    <div className={`v2-connectors__new-row${aside ? ' v2-connectors__new-row--aside' : ''}`}>
      <div className="v2-connectors__providers" role="group" aria-label={t('connectors.provider', { defaultValue: 'Channel provider' })}>
        {availableProviders.map((provider) => (
          <button
            key={provider.type}
            type="button"
            className={`v2-connectors__provider${addingType === provider.type ? ' v2-connectors__provider--selected' : ''}`}
            onClick={() => setAddingType(provider.type)}
          >
            {TYPE_LABELS[provider.type]}
          </button>
        ))}
      </div>
      <select
        className="v2-connectors__select"
        value={newPodId}
        onChange={(event) => setNewPodId(event.target.value)}
        aria-label={t('connectors.podPicker', { defaultValue: 'Pod to bridge' })}
      >
        {pods.map((pod) => <option key={pod._id} value={pod._id}>{pod.name}</option>)}
      </select>
      <button type="button" className="v2-connectors__create" disabled={!newPodId || creating || !addingType} onClick={createConnector}>
        {creating ? t('connectors.creating', { defaultValue: 'Connecting…' }) : t('connectors.connect', { defaultValue: 'Connect' })}
      </button>
    </div>
  );

  return (
    <div className="v2-connectors">
      <header className="v2-connectors__header">
        <h1>{t('connectors.title', { defaultValue: 'Connectors' })}</h1>
        <p>{t('connectors.description', { defaultValue: 'Each channel gets one agent from a pod. It answers there in its own name; the rest of the team stays behind it.' })}</p>
      </header>

      {loading && <div className="v2-connectors__loading">{t('connectors.loading', { defaultValue: 'Loading connectors…' })}</div>}

      {!loading && (
        <div className="v2-connectors__content">
          <section className="v2-connectors__main" aria-label={t('connectors.channels', { defaultValue: 'Your channels' })}>
            <div className="v2-connectors__rows">
              {connectors.map(renderRow)}
              <article className="v2-connector-row v2-connector-row--not-yet">
                <span className="v2-connector-row__name">
                  <span className="v2-connector-row__dot v2-connector-row__dot--not-yet" aria-hidden="true" />
                  <span className="v2-connector-row__glyph" aria-hidden="true"><PlatformGlyph type="discord" /></span>
                  <span>{UNAVAILABLE_PLATFORM_LABELS.join(' · ')}</span>
                </span>
                <span className="v2-connector-row__details">
                  <strong>{t('connectors.notYetLine', { defaultValue: 'Not yet. Tell us which channel you need and we build it next.' })}</strong>
                </span>
                <span className="v2-connector-row__when">—</span>
                <a className="v2-connector-row__action v2-connector-row__action--secondary" href="https://github.com/Team-Commonly/commonly/issues/new?title=Connector%20request">
                  {t('connectors.ask', { defaultValue: 'Ask' })}
                </a>
              </article>
            </div>

            {availableProviders.length > 0 && (
              <div className="v2-connectors__add">
                <button type="button" className="v2-connectors__connect" onClick={() => setAddingType((current) => current ? null : availableProviders[0]?.type || null)}>
                  {t('connectors.connectChannel', { defaultValue: 'Connect a channel' })}
                </button>
                <p>{t('connectors.connectChannelHint', { defaultValue: 'Choose a channel and the pod it should join.' })}</p>
                {adding && selectedConnector && renderAddForm()}
              </div>
            )}
          </section>
          {selectedConnector
            ? renderAside(selectedConnector)
            : adding && (
              <aside className="v2-connectors__aside" aria-label={t('connectors.connectChannel', { defaultValue: 'Connect a channel' })}>
                <section className="v2-connector-aside__step">
                  <p className="v2-connector-aside__eyebrow">{t('connectors.nextStep', { defaultValue: 'Next step' })}</p>
                  <p>{t('connectors.connectChannelHint', { defaultValue: 'Choose a channel and the pod it should join.' })}</p>
                  {renderAddForm(true)}
                </section>
              </aside>
            )}
        </div>
      )}

      {(error || slackCallbackError) && <div className="v2-connectors__error" role="alert">{error || slackCallbackError}</div>}
    </div>
  );
};

export default V2ConnectorsPage;
