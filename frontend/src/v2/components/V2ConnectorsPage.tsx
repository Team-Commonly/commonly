// Connectors — the Signal Coverage artboard's channel list. It deliberately
// renders only controls the connector service already enforces: rows are keyed
// by the server's capability catalog (D8 Phase 2 D1/D2), every action is an
// existing lifecycle verb, and the aside's gate list writes only what the
// owner-only PATCH accepts (D3/D4).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import { V2Pod, V2PodMember } from '../hooks/useV2Pods';
import { PlatformGlyph } from '../icons/platforms';

interface ConnectorGate {
  enabled?: boolean;
  mode?: 'attention' | 'mirror';
  lead?: string;
  since?: string;
}

interface ConnectorConfig {
  chatTitle?: string;
  connectCode?: string;
  connectCodeExpiresAt?: string;
  liveRelay?: boolean;
  relayAllAgentMessages?: boolean;
  leadAgentUsername?: string;
  gates?: Record<string, ConnectorGate>;
  // Projected by the server as { reason, at } only — the admin is never named.
  adminPause?: { reason?: string; at?: string };
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
  scope?: 'user' | 'pod';
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
  config?: ConnectorConfig;
  podId?: { _id: string; name?: string } | string | null;
}

interface CatalogInstallation {
  status: string;
  errorMessage?: string;
  boundPodId?: string;
  claimedAt?: string;
  updatedAt?: string;
  components?: { name?: string; status?: string; errorMessage?: string }[];
}

interface CatalogEntry {
  installableId: string;
  label?: string;
  description?: string;
  available: boolean;
  unavailableReason?: string;
  installation: CatalogInstallation | null;
  integration: Connector | null;
}

interface CatalogResponse {
  installables?: CatalogEntry[];
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

type ConnectorAction =
  | 'manage' | 'show-code' | 'new-code' | 'authorize' | 'confirm'
  | 'connect' | 'cancel' | 'retry' | 'retry-remove' | 'pick-pod';

interface ConnectorRow {
  action: ConnectorAction | null;
  actionLabel?: string;
  detail: string;
  dot: 'live' | 'idle' | 'pending' | 'empty' | 'not-yet';
  line: string;
  muted?: boolean;
  pulse: boolean;
  secondary?: boolean;
  when: string;
}

// One list, two sources: the catalog keys a row per provider the instance
// knows about; legacy pod-scoped rows (no installation) render as before.
type ListItem =
  | { kind: 'catalog'; key: string; entry: CatalogEntry; connector: Connector | null }
  | { kind: 'legacy'; key: string; connector: Connector };

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

// Fallback only: when the catalog cannot be read the page still offers the
// two providers it can drive, exactly as it did before the catalog existed.
const ADD_PLATFORMS = [
  { type: 'telegram', enabled: true },
  { type: 'slack', enabled: true },
];
const UNAVAILABLE_PLATFORM_LABELS = ['Discord', 'WhatsApp'];

const BOT_HANDLE = process.env.REACT_APP_TELEGRAM_BOT_HANDLE || '';
const RECENT_MS = 10 * 60_000;
// Mirrors INSTALL_LOCK_TTL_MS on the server: Cancel appears exactly when the
// lifecycle verb would honour it (a stale claim), never before.
export const INSTALL_LOCK_TTL_MS = 60_000;
const TRANSIENT_STATUSES = ['installing', 'activating', 'uninstalling'];

export const installableLifecyclePath = (type: string): string => (
  `/api/installables/${encodeURIComponent(type)}/install`
);

const installErrorResponse = (error: unknown): { status?: number; data?: InstallErrorResponse } => (
  (error as { response?: { status?: number; data?: InstallErrorResponse } })?.response || {}
);

const connectorPodId = (connector: Connector | null | undefined): string | null => {
  if (!connector || !connector.podId) return null;
  return typeof connector.podId === 'object' ? String(connector.podId._id || '') || null : String(connector.podId);
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

const claimIsStale = (installation: CatalogInstallation): boolean => {
  const claimedAt = installation.claimedAt ? new Date(installation.claimedAt).getTime() : NaN;
  if (!Number.isFinite(claimedAt)) return true;
  return Date.now() - claimedAt >= INSTALL_LOCK_TTL_MS;
};

const projectionMissing = (entry: CatalogEntry): boolean => (
  !entry.integration
  || entry.integration.isActive === false
  || (entry.installation?.components || []).some((component) => component.status === 'stale')
);

const botMembers = (pod: V2Pod | undefined): V2PodMember[] => (
  (pod?.members || []).filter((member): member is V2PodMember => (
    typeof member === 'object' && member !== null && Boolean(member.isBot) && Boolean(member.username)
  ))
);

const V2ConnectorsPage: React.FC = () => {
  const { t } = useTranslation();
  const api = useV2Api();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [pods, setPods] = useState<V2Pod[]>([]);
  const [newPodId, setNewPodId] = useState('');
  const [addingType, setAddingType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [expandedGate, setExpandedGate] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slackCallbackError, setSlackCallbackError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const adding = addingType !== null;

  const load = useCallback(async () => {
    try {
      const [rows, catalogResponse] = await Promise.all([
        api.get<Connector[]>('/api/integrations/user/all'),
        // The catalog is the page's authority for provider rows; if it cannot
        // be read the legacy list still renders and the picker falls back.
        api.get<CatalogResponse>('/api/installables').catch(() => null),
      ]);
      setConnectors(Array.isArray(rows) ? rows : []);
      setCatalog(catalogResponse && Array.isArray(catalogResponse.installables) ? catalogResponse.installables : null);
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
  )) || (catalog || []).some((entry) => (
    entry.installation ? TRANSIENT_STATUSES.includes(entry.installation.status) : false
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
        // Membership is the only rule, and it is the server's: every pod that
        // lists the user is one the install verb and a gate key would accept.
        const data = await api.get<V2Pod[]>('/api/pods');
        const eligible = Array.isArray(data) ? data : [];
        if (!cancelled) {
          setPods(eligible);
          setNewPodId((current) => current || eligible[0]?._id || '');
        }
      } catch {
        // The picker stays empty when no pod can be read.
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const podNameById = (podId: string | null | undefined, fallback?: Connector | null): string => {
    const pod = pods.find((candidate) => String(candidate._id) === String(podId || ''));
    if (pod) return pod.name || 'Untitled pod';
    if (fallback && typeof fallback.podId === 'object' && fallback.podId?.name) return fallback.podId.name;
    return 'Untitled pod';
  };

  const boundPodName = (boundPodId: string | undefined): string => {
    const existing = connectors.find((connector) => connectorPodId(connector) === String(boundPodId));
    const boundPod = pods.find((pod) => String(pod._id) === String(boundPodId));
    return existing ? podNameById(connectorPodId(existing), existing) : (boundPod?.name || 'another pod');
  };

  const installInProgressMessage = (boundPodId?: string): string => (
    boundPodId
      ? t('connectors.installInProgressForPod', {
        defaultValue: 'Still setting up for {{pod}} — try again in a moment.',
        pod: boundPodName(boundPodId),
      })
      : t('connectors.installInProgress', { defaultValue: 'Still setting up — try again in a moment.' })
  );

  const install = async (type: string, podId: string): Promise<boolean> => {
    const typeLabel = TYPE_LABELS[type] || type;
    try {
      const result = await api.post<InstallResponse>(installableLifecyclePath(type), { podId });
      // Reload before reporting: `load` clears the error slot on success, and
      // the row's new state is what the message refers to.
      await load();
      if (result.status && result.status !== 'active') {
        setError(installInProgressMessage(result.boundPodId));
        return false;
      }
      return true;
    } catch (requestError) {
      const response = installErrorResponse(requestError);
      let message: string;
      if (response.status === 409 && response.data?.code === 'install_in_progress') {
        message = installInProgressMessage(response.data.boundPodId);
      } else if (response.status === 409 && response.data?.code === 'already_installed') {
        message = t('connectors.alreadyBound', {
          defaultValue: 'Your {{connector}} channel is bound to {{pod}}. Remove it to bind a different pod.',
          connector: typeLabel,
          pod: boundPodName(response.data.boundPodId),
        });
      } else if (response.status === 409 && response.data?.code === 'installation_paused') {
        message = t('connectors.pausedRefusal', {
          defaultValue: 'An administrator paused this connector. Ask your operator.',
        });
      } else if (response.status === 422 && response.data?.code === 'provider_not_configured') {
        message = t('connectors.providerNotConfigured', {
          defaultValue: '{{connector}} is not enabled on this instance. Ask your operator.',
          connector: typeLabel,
        });
      } else {
        message = t('connectors.createError', { defaultValue: 'Could not create the connector.' });
      }
      await load();
      setError(message);
      return false;
    }
  };

  const createConnector = async () => {
    if (!newPodId || !addingType || creating) return;
    setCreating(true);
    setError(null);
    try {
      const installed = await install(addingType, newPodId);
      if (installed) setAddingType(null);
    } finally {
      setCreating(false);
    }
  };

  const patchIntegration = async (connector: Connector, body: Record<string, unknown>, errorKey: string, errorDefault: string) => {
    if (busyId) return;
    setBusyId(connector._id);
    setError(null);
    try {
      await api.patch(`/api/integrations/${connector._id}`, body);
      await load();
    } catch {
      setError(t(errorKey, { defaultValue: errorDefault }));
    } finally {
      setBusyId(null);
    }
  };

  const patchConfig = (connector: Connector, config: Record<string, unknown>, errorKey: string, errorDefault: string) => (
    patchIntegration(connector, { config }, errorKey, errorDefault)
  );

  // The PATCH merges `config` one level deep, so `gates` is written whole:
  // every pod's gate travels with the one that changed, `since` included.
  const writeGate = (connector: Connector, podId: string, next: ConnectorGate) => {
    const current = connector.config?.gates || {};
    const gates: Record<string, ConnectorGate> = {};
    Object.entries(current).forEach(([key, gate]) => {
      gates[key] = {
        enabled: gate.enabled === true,
        ...(gate.mode ? { mode: gate.mode } : {}),
        ...(gate.lead ? { lead: gate.lead } : {}),
        since: gate.since || new Date().toISOString(),
      };
    });
    gates[podId] = {
      enabled: next.enabled === true,
      ...(next.mode ? { mode: next.mode } : {}),
      ...(next.lead ? { lead: next.lead } : {}),
      since: current[podId]?.since || new Date().toISOString(),
    };
    return patchConfig(connector, { gates }, 'connectors.gateError', 'Could not update that pod.');
  };

  const makeActive = (connector: Connector, podId: string) => (
    patchIntegration(connector, { podId }, 'connectors.activePodError', 'Could not change the active pod.')
  );

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

  // DELETE on the lifecycle verb serves Remove, Cancel and Retry remove alike:
  // the service decides what a DELETE means from the parent's state.
  const uninstall = async (type: string, busyKey: string, errorKey: string, errorDefault: string) => {
    if (busyId) return;
    setBusyId(busyKey);
    setError(null);
    try {
      await api.del(installableLifecyclePath(type));
      setConfirmRemove(null);
    } catch (requestError) {
      const response = installErrorResponse(requestError);
      // A live claim refuses Cancel; the row simply reads "Setting up…" again.
      if (!(response.status === 409 && response.data?.code === 'install_in_progress')) {
        setError(t(errorKey, { defaultValue: errorDefault }));
      }
    } finally {
      setBusyId(null);
      await load();
    }
  };

  const remove = async (item: ListItem) => {
    const connector = item.connector;
    if (item.kind === 'catalog') {
      await uninstall(item.entry.installableId, item.key, 'connectors.removeError', 'Could not remove the channel.');
      setSelectedKey(null);
      return;
    }
    if (!connector) return;
    setBusyId(connector._id);
    try {
      if (connector.installationId) {
        await api.del(installableLifecyclePath(connector.type));
      } else {
        await api.patch(`/api/integrations/${connector._id}`, { isActive: false });
      }
      setConfirmRemove(null);
      setSelectedKey(null);
      await load();
    } catch {
      setError(t('connectors.removeError', { defaultValue: 'Could not remove the channel.' }));
    } finally {
      setBusyId(null);
    }
  };

  const retry = async (entry: CatalogEntry) => {
    if (busyId) return;
    const podId = entry.installation?.boundPodId || connectorPodId(entry.integration) || newPodId;
    if (!podId) {
      setAddingType(entry.installableId);
      return;
    }
    setBusyId(entry.installableId);
    setError(null);
    try {
      await install(entry.installableId, podId);
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
    const title = connector.config?.chatTitle || TYPE_LABELS[connector.type] || connector.type;

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
      const activePodId = connectorPodId(connector);
      if (!activePodId) {
        // The owner left the active pod and the prune cleared it (D3). Their
        // typed messages have nowhere to go until they pick a pod in the aside.
        return {
          action: 'pick-pod',
          actionLabel: t('connectors.pickPod', { defaultValue: 'Pick a pod' }),
          detail: t('connectors.notLinkedDetail', { defaultValue: 'your messages have nowhere to go' }),
          dot: 'idle',
          line: t('connectors.notLinkedLine', { defaultValue: '{{title}} · not linked to a pod', title }),
          pulse: false,
          when: `added ${relativeTime(connector.createdAt)}`,
        };
      }
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
        line: `${title} · linked to ${podNameById(activePodId, connector)}`,
        pulse: relay && Boolean(recent),
        secondary: true,
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

  // D2: the catalog entry and its parent decide the row; the Integration row
  // only takes over once the parent is `active` and its projection is whole.
  const rowForEntry = (entry: CatalogEntry, connector: Connector | null): ConnectorRow => {
    const label = entry.label || TYPE_LABELS[entry.installableId] || entry.installableId;
    const installation = entry.installation;
    if (!entry.available) {
      return {
        action: null,
        detail: t('connectors.askOperator', { defaultValue: 'ask your operator' }),
        dot: 'not-yet',
        line: t('connectors.notEnabled', { defaultValue: 'Not enabled on this instance.' }),
        muted: true,
        pulse: false,
        when: '—',
      };
    }
    if (!installation) {
      return {
        action: 'connect',
        actionLabel: t('connectors.connect', { defaultValue: 'Connect' }),
        detail: entry.installableId === 'telegram'
          ? t('connectors.availableTelegram', { defaultValue: 'one message' })
          : t('connectors.availableSlack', { defaultValue: 'one click in your workspace' }),
        dot: 'empty',
        line: entry.description || t('connectors.availableLine', { defaultValue: 'Connect {{label}} to a pod.', label }),
        pulse: false,
        when: t('connectors.notConnected', { defaultValue: 'not connected' }),
      };
    }
    const since = `since ${relativeTime(installation.updatedAt)}`;
    const started = `started ${relativeTime(installation.claimedAt || installation.updatedAt)}`;
    const stale = claimIsStale(installation);
    if (installation.status === 'installing' || installation.status === 'activating') {
      return stale
        ? {
          action: 'cancel',
          actionLabel: t('connectors.cancel', { defaultValue: 'Cancel' }),
          detail: t('connectors.serverLetGo', { defaultValue: 'the server let go of it' }),
          dot: 'pending',
          line: t('connectors.setupSlow', { defaultValue: 'Setup is taking longer than it should.' }),
          pulse: true,
          secondary: true,
          when: started,
        }
        : {
          action: null,
          detail: t('connectors.waitingServer', { defaultValue: 'waiting for the server' }),
          dot: 'pending',
          line: t('connectors.settingUp', { defaultValue: 'Setting up…' }),
          pulse: true,
          when: started,
        };
    }
    if (installation.status === 'uninstalling') {
      return stale
        ? {
          action: 'retry-remove',
          actionLabel: t('connectors.retryRemove', { defaultValue: 'Retry remove' }),
          detail: t('connectors.serverLetGo', { defaultValue: 'the server let go of it' }),
          dot: 'pending',
          line: t('connectors.removeSlow', { defaultValue: 'Removal is taking longer than it should.' }),
          pulse: true,
          secondary: true,
          when: started,
        }
        : {
          action: null,
          detail: t('connectors.waitingServer', { defaultValue: 'waiting for the server' }),
          dot: 'pending',
          line: t('connectors.removing', { defaultValue: 'Removing…' }),
          pulse: true,
          when: started,
        };
    }
    if (installation.status === 'error') {
      return {
        action: 'retry',
        actionLabel: t('connectors.retry', { defaultValue: 'Retry' }),
        detail: t('connectors.retryOrRemove', { defaultValue: 'retry, or remove it' }),
        dot: 'empty',
        line: installation.errorMessage || t('connectors.setupFailed', { defaultValue: 'Setup didn’t finish.' }),
        pulse: false,
        when: since,
      };
    }
    if (installation.status === 'paused') {
      const pause = connector?.config?.adminPause;
      const reason = pause?.reason ? ` ${pause.reason}` : '';
      return {
        action: null,
        detail: t('connectors.askOperator', { defaultValue: 'ask your operator' }),
        dot: 'empty',
        line: `${t('connectors.pausedLine', { defaultValue: 'Paused by an administrator.' })}${reason}`,
        pulse: false,
        when: `paused ${relativeTime(pause?.at || installation.updatedAt)}`,
      };
    }
    if (installation.status === 'stale') {
      return {
        action: null,
        detail: t('connectors.notRelaying', { defaultValue: 'not relaying' }),
        dot: 'empty',
        line: t('connectors.pausedShort', { defaultValue: 'Paused.' }),
        pulse: false,
        when: since,
      };
    }
    if (projectionMissing(entry) || !connector) {
      return {
        action: 'retry',
        actionLabel: t('connectors.retry', { defaultValue: 'Retry' }),
        detail: t('connectors.retryRebuilds', { defaultValue: 'retry rebuilds it' }),
        dot: 'empty',
        line: t('connectors.recordGone', { defaultValue: 'The channel record is gone.' }),
        pulse: false,
        when: since,
      };
    }
    return rowFor(connector);
  };

  const connectorForEntry = (entry: CatalogEntry): Connector | null => {
    if (!entry.integration) return null;
    const podId = connectorPodId(entry.integration);
    return {
      ...entry.integration,
      type: entry.integration.type || entry.installableId,
      installationId: entry.integration.installationId || 'catalog',
      podId: podId ? { _id: podId, name: podNameById(podId, entry.integration) } : null,
    };
  };

  const catalogTypes = new Set((catalog || []).map((entry) => entry.installableId));
  const items: ListItem[] = [
    ...(catalog || []).map((entry): ListItem => ({
      kind: 'catalog',
      key: `catalog:${entry.installableId}`,
      entry,
      connector: connectorForEntry(entry),
    })),
    // Rows the catalog does not describe: legacy pod-scoped connectors, and
    // installable rows only while the catalog itself cannot be read.
    ...connectors
      .filter((connector) => !(connector.installationId && catalogTypes.has(connector.type)))
      .map((connector): ListItem => ({ kind: 'legacy', key: `legacy:${connector._id}`, connector })),
  ];

  const rowForItem = (item: ListItem): ConnectorRow => (
    item.kind === 'catalog' ? rowForEntry(item.entry, item.connector) : rowFor(item.connector)
  );

  const itemLabel = (item: ListItem): string => (
    item.kind === 'catalog'
      ? (item.entry.label || TYPE_LABELS[item.entry.installableId] || item.entry.installableId)
      : (TYPE_LABELS[item.connector.type] || item.connector.type)
  );

  const itemType = (item: ListItem): string => (item.kind === 'catalog' ? item.entry.installableId : item.connector.type);

  const needsUser = (row: ConnectorRow): boolean => row.action !== null && !row.secondary && row.action !== 'connect';
  const selectedItem = items.find((item) => item.key === selectedKey)
    || items.find((item) => needsUser(rowForItem(item)))
    || items.find((item) => item.connector !== null)
    || null;

  const selectItem = (item: ListItem) => {
    setSelectedKey(item.key);
    setConfirmRemove(null);
    setExpandedGate(null);
  };

  const runAction = (item: ListItem, action: ConnectorAction) => {
    selectItem(item);
    const connector = item.connector;
    if (action === 'connect') {
      setAddingType(itemType(item));
      return undefined;
    }
    // Pick a pod: the aside's gate list is already expanded for an unlinked
    // row (D4), so selecting the row is the whole action.
    if (action === 'pick-pod') return undefined;
    if (item.kind === 'catalog') {
      if (action === 'cancel') return uninstall(item.entry.installableId, item.key, 'connectors.cancelError', 'Could not cancel setup.');
      if (action === 'retry-remove') return uninstall(item.entry.installableId, item.key, 'connectors.removeError', 'Could not remove the channel.');
      if (action === 'retry') return retry(item.entry);
    }
    if (!connector) return undefined;
    if (action === 'new-code') return regenerateCode(connector);
    if (action === 'authorize') return authorizeSlack(connector);
    if (action === 'confirm') return resolveSlackBind(connector, 'confirm');
    return undefined;
  };

  const busyFor = (item: ListItem): boolean => busyId === item.key || (item.connector !== null && busyId === item.connector._id);

  const renderRow = (item: ListItem) => {
    const row = rowForItem(item);
    const selected = selectedItem?.key === item.key;
    const label = itemLabel(item);
    const busy = busyFor(item);
    return (
      <article
        key={item.key}
        className={`v2-connector-row${selected ? ' v2-connector-row--selected' : ''}${row.muted ? ' v2-connector-row--not-yet' : ''}`}
      >
        <button
          type="button"
          className="v2-connector-row__selection"
          aria-pressed={selected}
          aria-label={t('connectors.viewChannel', { defaultValue: 'View {{channel}}', channel: label })}
          onClick={() => selectItem(item)}
        >
          <span className="v2-connector-row__name">
            <span className={`v2-connector-row__dot v2-connector-row__dot--${row.dot}${row.pulse ? ' v2-connector-row__dot--pulse' : ''}`} aria-hidden="true" />
            <span className="v2-connector-row__glyph" aria-hidden="true"><PlatformGlyph type={itemType(item)} /></span>
            <span>{label}</span>
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
            className={`v2-connector-row__action${row.secondary ? ' v2-connector-row__action--secondary' : ''}`}
            disabled={busy && row.action !== 'manage'}
            onClick={() => { void runAction(item, row.action as ConnectorAction); }}
          >
            {busy && row.action === 'authorize'
              ? t('connectors.slackAuthorizing', { defaultValue: 'Opening Slack…' })
              : row.actionLabel}
          </button>
        )}
      </article>
    );
  };

  // D4: one row per pod the user is in. The switch is the gate; the active pod
  // is where the owner's typed messages land, and it is its own control.
  const renderGates = (connector: Connector) => {
    const gates = connector.config?.gates || {};
    const activePodId = connectorPodId(connector);
    const unlinked = !activePodId;
    return (
      <div className="v2-connector-gates" data-testid="connector-gates">
        <p className="v2-connector-gates__title">
          {unlinked
            ? t('connectors.pickWhere', { defaultValue: 'Pick where your messages go' })
            : t('connectors.gatesTitle', { defaultValue: 'Pods that reach this channel' })}
        </p>
        {pods.length === 0 && (
          <p className="v2-connector-gates__empty">{t('connectors.noPods', { defaultValue: 'Join a pod first.' })}</p>
        )}
        {pods.map((pod) => {
          const gate = gates[pod._id];
          const enabled = gate?.enabled === true;
          const active = String(activePodId || '') === String(pod._id);
          const open = unlinked || expandedGate === pod._id;
          const bots = botMembers(pod);
          const disabled = busyId === connector._id;
          return (
            <div key={pod._id} className={`v2-connector-gate${active ? ' v2-connector-gate--active' : ''}`}>
              <div className="v2-connector-gate__row">
                <button
                  type="button"
                  className="v2-connector-gate__name"
                  aria-expanded={open}
                  onClick={() => setExpandedGate((current) => (current === pod._id ? null : pod._id))}
                >
                  <span className="v2-connector-gate__mark" aria-hidden="true" />
                  <span className="v2-connector-gate__pod">{pod.name}</span>
                  {active && <span className="v2-connector-gate__tag">{t('connectors.activeTag', { defaultValue: 'active' })}</span>}
                </button>
                <span className={`v2-connector-gate__since${enabled ? '' : ' v2-connector-gate__since--off'}`}>
                  {enabled ? `since ${relativeTime(gate?.since)}` : t('connectors.gateOff', { defaultValue: 'off' })}
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="v2-connector-gate__switch"
                  aria-checked={enabled}
                  aria-label={t('connectors.gateSwitch', { defaultValue: 'Relay {{pod}}', pod: pod.name })}
                  checked={enabled}
                  disabled={disabled}
                  onChange={() => { void writeGate(connector, pod._id, { ...gate, enabled: !enabled }); }}
                />
              </div>
              {open && (
                <div className="v2-connector-gate__more">
                  <div className="v2-connector-aside__mode" role="group" aria-label={t('connectors.gateMode', { defaultValue: 'Mode for {{pod}}', pod: pod.name })}>
                    {([
                      [undefined, t('connectors.modeDefault', { defaultValue: 'Default' })],
                      ['attention', t('connectors.modeAttention', { defaultValue: 'Attention' })],
                      ['mirror', t('connectors.modeMirror', { defaultValue: 'Mirror' })],
                    ] as [ConnectorGate['mode'], string][]).map(([mode, modeLabel]) => {
                      const on = (gate?.mode || undefined) === mode;
                      return (
                        <button
                          key={modeLabel}
                          type="button"
                          className={on ? 'v2-connector-aside__mode-opt v2-connector-aside__mode-opt--on' : 'v2-connector-aside__mode-opt'}
                          disabled={disabled || on}
                          onClick={() => { void writeGate(connector, pod._id, { ...gate, enabled, mode }); }}
                        >
                          {modeLabel}
                        </button>
                      );
                    })}
                  </div>
                  <select
                    className="v2-connectors__select v2-connector-gate__lead"
                    aria-label={t('connectors.gateLead', { defaultValue: 'Lead agent for {{pod}}', pod: pod.name })}
                    value={gate?.lead || ''}
                    disabled={disabled}
                    onChange={(event) => { void writeGate(connector, pod._id, { ...gate, enabled, lead: event.target.value || undefined }); }}
                  >
                    <option value="">{t('connectors.leadAny', { defaultValue: 'Any agent leads' })}</option>
                    {bots.map((bot) => <option key={bot.username} value={bot.username}>{bot.username}</option>)}
                  </select>
                  {!active && (
                    <button
                      type="button"
                      className="v2-connector-aside__secondary"
                      disabled={disabled}
                      onClick={() => { void makeActive(connector, pod._id); }}
                    >
                      {t('connectors.makeActive', { defaultValue: 'Make active' })}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderRemove = (item: ListItem) => (
    confirmRemove === item.key ? (
      <button type="button" className="v2-connector-aside__primary" disabled={busyFor(item)} onClick={() => { void remove(item); }}>
        {t('connectors.removeConfirm', { defaultValue: 'Really remove — the channel goes quiet' })}
      </button>
    ) : (
      <button type="button" className="v2-connector-aside__secondary" onClick={() => setConfirmRemove(item.key)}>
        {t('connectors.remove', { defaultValue: 'Remove' })}
      </button>
    )
  );

  // The parent's non-active states own the aside: one sentence, the verbs the
  // service would honour, and nothing the owner cannot press.
  const renderParentAside = (item: ListItem & { kind: 'catalog' }, row: ConnectorRow) => {
    const status = item.entry.installation?.status || '';
    const busy = busyFor(item);
    return (
      <aside className="v2-connectors__aside" aria-label={t('connectors.channelDetails', { defaultValue: 'Channel details' })}>
        <section className="v2-connector-aside__step">
          <p className="v2-connector-aside__eyebrow">
            {status === 'paused'
              ? t('connectors.pausedEyebrow', { defaultValue: 'Paused' })
              : t('connectors.nextStep', { defaultValue: 'Next step' })}
          </p>
          <p>{row.line}</p>
          {status === 'error' && (
            <div className="v2-connector-aside__actions">
              <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void retry(item.entry); }}>
                {t('connectors.retry', { defaultValue: 'Retry' })}
              </button>
              {renderRemove(item)}
            </div>
          )}
          {row.action === 'cancel' && (
            <div className="v2-connector-aside__actions">
              <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => { void runAction(item, 'cancel'); }}>
                {t('connectors.cancel', { defaultValue: 'Cancel' })}
              </button>
            </div>
          )}
          {row.action === 'retry-remove' && (
            <div className="v2-connector-aside__actions">
              <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => { void runAction(item, 'retry-remove'); }}>
                {t('connectors.retryRemove', { defaultValue: 'Retry remove' })}
              </button>
            </div>
          )}
          {status === 'active' && row.action === 'retry' && (
            <div className="v2-connector-aside__actions">
              <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void retry(item.entry); }}>
                {t('connectors.retry', { defaultValue: 'Retry' })}
              </button>
              {renderRemove(item)}
            </div>
          )}
          {status === 'paused' && (
            <p className="v2-connector-aside__note">
              {t('connectors.pausedNote', { defaultValue: 'Only an administrator can resume it. Your relay, mode and pods are kept.' })}
            </p>
          )}
        </section>
      </aside>
    );
  };

  const renderAside = (item: ListItem) => {
    const row = rowForItem(item);
    if (item.kind === 'catalog') {
      const status = item.entry.installation?.status;
      if (!item.entry.available || !item.entry.installation) return null;
      if (status !== 'active' || !item.connector || row.action === 'retry') return renderParentAside(item, row);
    }
    const connector = item.connector as Connector;
    const isTelegram = connector.type === 'telegram';
    const isSlack = connector.type === 'slack';
    const connected = connector.status === 'connected';
    const supportsRelayControls = isTelegram || isSlack;
    const mirror = connector.config?.relayAllAgentMessages === true;
    const pendingBind = connector.config?.pendingBind;
    const userScoped = connector.scope === 'user' || Boolean(connector.config?.gates);
    const busy = busyFor(item);

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
                <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void regenerateCode(connector); }}>
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
                  <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void resolveSlackBind(connector, 'confirm'); }}>
                    {t('connectors.slackConfirm', { defaultValue: 'Confirm connection' })}
                  </button>
                  <button type="button" className="v2-connector-aside__secondary" disabled={busy} onClick={() => { void resolveSlackBind(connector, 'reject'); }}>
                    {t('connectors.slackReject', { defaultValue: 'This is not me' })}
                  </button>
                </div>
              </>
            )}
            {isSlack && !pendingBind && connector.status !== 'error' && (
              <>
                <p>{row.line}</p>
                <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void authorizeSlack(connector); }}>
                  {t('connectors.slackAuthorize', { defaultValue: 'Authorize in Slack' })}
                </button>
              </>
            )}
            {connector.status === 'error' && (
              <>
                <p>{row.line}</p>
                {row.action && (
                  <button type="button" className="v2-connector-aside__primary" disabled={busy} onClick={() => { void runAction(item, row.action as ConnectorAction); }}>
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
                    disabled={busy}
                    onChange={() => patchConfig(connector, { liveRelay: !connector.config?.liveRelay }, 'connectors.toggleError', 'Could not update live relay.')}
                  />
                  <span>{t('connectors.liveRelay', { defaultValue: 'Relay' })}</span>
                </label>
                {connector.config?.liveRelay && (
                  <div className="v2-connector-aside__mode" role="group" aria-label={t('connectors.mode', { defaultValue: 'Relay mode' })}>
                    <button
                      type="button"
                      className={!mirror ? 'v2-connector-aside__mode-opt v2-connector-aside__mode-opt--on' : 'v2-connector-aside__mode-opt'}
                      disabled={busy || !mirror}
                      onClick={() => patchConfig(connector, { relayAllAgentMessages: false }, 'connectors.modeError', 'Could not switch mode.')}
                    >
                      {t('connectors.modeAttention', { defaultValue: 'Attention' })}
                    </button>
                    <button
                      type="button"
                      className={mirror ? 'v2-connector-aside__mode-opt v2-connector-aside__mode-opt--on' : 'v2-connector-aside__mode-opt'}
                      disabled={busy || mirror}
                      onClick={() => patchConfig(connector, { relayAllAgentMessages: true }, 'connectors.modeError', 'Could not switch mode.')}
                    >
                      {t('connectors.modeMirror', { defaultValue: 'Mirror' })}
                    </button>
                  </div>
                )}
              </div>
            )}
            {connected && userScoped && renderGates(connector)}
            {renderRemove(item)}
          </section>
        )}
      </aside>
    );
  };

  const hasInstallation = (type: string): boolean => connectors.some(
    (connector) => connector.type === type && Boolean(connector.installationId),
  );
  const availableProviders = catalog
    ? catalog.filter((entry) => entry.available && !entry.installation).map((entry) => ({ type: entry.installableId }))
    : ADD_PLATFORMS.filter((provider) => provider.enabled && !hasInstallation(provider.type));
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
            {TYPE_LABELS[provider.type] || provider.type}
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

  const selectedAside = selectedItem ? renderAside(selectedItem) : null;

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
              {items.map(renderRow)}
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
                {adding && selectedAside && renderAddForm()}
              </div>
            )}
          </section>
          {selectedAside
            || (adding && (
              <aside className="v2-connectors__aside" aria-label={t('connectors.connectChannel', { defaultValue: 'Connect a channel' })}>
                <section className="v2-connector-aside__step">
                  <p className="v2-connector-aside__eyebrow">{t('connectors.nextStep', { defaultValue: 'Next step' })}</p>
                  <p>{t('connectors.connectChannelHint', { defaultValue: 'Choose a channel and the pod it should join.' })}</p>
                  {renderAddForm(true)}
                </section>
              </aside>
            ))}
        </div>
      )}

      {(error || slackCallbackError) && <div className="v2-connectors__error" role="alert">{error || slackCallbackError}</div>}
    </div>
  );
};

export default V2ConnectorsPage;
