// Channel connectors: state, effects and verbs of the connectors page, moved out
// of the retired channels page so the tile page and its panels share one model
// (TASK-733). The rows' behaviour is unchanged; the page that drew them is gone.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import { useRelativeNow } from '../hooks/useRelativeNow';
import { V2Pod } from '../hooks/useV2Pods';
import type { MarkName } from '../icons/glyphs';
import { hostedMcpErrorNotice } from '../components/hostedMcpErrorNotice';
import type { HostedMcpManualRevokeNotice } from './toolModel';
import { catalogDescription } from '../utils/connectorCatalogDescription';
import { safeProviderRevokePage } from '../utils/safeProviderRevokePage';
import {
  TYPE_LABELS,
  TOOL_ONLY_CONNECTION_TYPES,
  mappedTypeLabel,
  CONNECT_DETAIL,
  RECENT_MS,
  TRANSIENT_STATUSES,
  installableLifecyclePath,
  installErrorResponse,
  SLACK_REFUSALS,
  connectorPodId,
  defaultPodForChannel,
  codeIsLive,
  codeExpiresInMinutes,
  claimIsStale,
  projectionMissing,
} from './channelModel';
import type {
  ConnectorGate,
  Connector,
  CatalogEntry,
  CatalogResponse,
  InstallResponse,
  SlackAuthorizeResponse,
  ConnectorAction,
  ConnectorRow,
  ListItem,
} from './channelModel';

export const useChannelConnectors = () => {
  const { t, i18n } = useTranslation();
  const api = useV2Api();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [hostedCatalog, setHostedCatalog] = useState<CatalogEntry[] | null>(null);
  // `null` means membership is not available yet (or the read failed).  An
  // empty array is the only confirmed zero-pod state, so it alone may replace
  // the existing picker with the create-a-pod path.
  const [pods, setPods] = useState<V2Pod[] | null>(null);
  // The pod list could not be read, so nothing downstream can vouch for it.
  const [podListFailed, setPodListFailed] = useState(false);
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
  const [hostedMcpManualRevoke, setHostedMcpManualRevoke] = useState<HostedMcpManualRevokeNotice | null>(null);
  // Row C: a refusal raised by a row's own button belongs on that row, not
  // only in the page-level slot at the foot of the page.
  const [rowRefusal, setRowRefusal] = useState<{ key: string; message: string } | null>(null);
  const [slackCallbackError, setSlackCallbackError] = useState<string | null>(null);
  const [slackLeadChoices, setSlackLeadChoices] = useState<Record<string, string>>({});
  const [hostedMcpCallbackError, setHostedMcpCallbackError] = useState<string | null>(null);
  // A refused connect whose grant the server could not withdraw. `pending` is
  // what the callback URL claimed; `hostedMcpCallbackRevoke` is set only once
  // the catalogue confirms it.
  const [pendingCallbackRevoke, setPendingCallbackRevoke] = useState<{ entryId: string; revokeAt: string } | null>(null);
  const [hostedMcpCallbackRevoke, setHostedMcpCallbackRevoke] = useState<{
    entryId: string; provider: string; revokePage: string;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const podPickerRef = useRef<HTMLSelectElement | null>(null);
  // Ages must advance while the page sits open, and the source must be re-read
  // when the tab comes back: a row that says `since 5m ago` is wrong twice
  // over if it is still saying it an hour later (TASK-131).
  const now = useRelativeNow();
  const adding = addingType !== null;
  // Memoised: a fresh `[]` each render while `pods` is null would re-fire every effect keyed on it.
  const podList = useMemo(() => pods || [], [pods]);
  // The gate mode options, declared here rather than inline in the JSX: eslint's
  // i18next/no-literal-string reads an array literal in JSX as copy, and only the
  // second element of each pair is copy (TASK-164).
  const gateModes: [ConnectorGate['mode'], string][] = [
    [undefined, t('connectors.modeDefault', { defaultValue: 'Default' })],
    ['attention', t('connectors.modeAttention', { defaultValue: 'Attention' })],
    ['mirror', t('connectors.modeMirror', { defaultValue: 'Mirror' })],
  ];

  // TASK-155: at 390 the aside sits below the fold of the page's own scroller
  // (`v2-feature__body` is the scroller, not the document), so opening the form
  // changed nothing on screen even once it moved into the panel. Focusing the
  // picker scrolls it into view, and is where a keyboard user wants the cursor
  // anyway. Keyed on the type so switching provider also lands on the picker.
  useEffect(() => {
    if (addingType) podPickerRef.current?.focus();
  }, [addingType]);

  const load = useCallback(async () => {
    try {
      const [rows, catalogResponse] = await Promise.all([
        api.get<Connector[]>('/api/integrations/user/all'),
        // The catalog is the page's authority for provider rows; if it cannot
        // be read the legacy list still renders and the picker falls back.
        api.get<CatalogResponse>('/api/installables').catch(() => null),
      ]);
      const connectorRows = Array.isArray(rows) ? rows : [];
      const installables = catalogResponse && Array.isArray(catalogResponse.installables)
        ? catalogResponse.installables
        : null;
      setConnectors(connectorRows);
      setCatalog(installables ? installables.filter((entry) => entry.list !== 'tools') : null);
      setHostedCatalog(installables
        ? installables.filter((entry) => entry.list === 'tools' && entry.connectionType === 'hosted-mcp')
        : null);
      setError(null);
      return connectorRows;
    } catch {
      setError(t('connectors.loadError', { defaultValue: 'Could not load connectors.' }));
      return [];
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [load]);

  // Keep vendor-controlled scope values out of the URL and official UI copy.
  // Consume the callback result after displaying a fixed notice.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('hostedMcp') !== 'error') return;
    setHostedMcpCallbackError(hostedMcpErrorNotice(t, query.get('code')));
    const entryId = query.get('entryId');
    const revokeAt = query.get('revokeAt');
    if (entryId && revokeAt) setPendingCallbackRevoke({ entryId, revokeAt });
    query.delete('hostedMcp');
    query.delete('code');
    query.delete('entryId');
    query.delete('revokeAt');
    query.delete('extraScope');
    query.delete('error');
    query.delete('error_description');
    const remaining = query.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${remaining ? `?${remaining}` : ''}${window.location.hash}`,
    );
  }, [t]);

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

  // A refused connect has no row to read, so the catalogue entry is the
  // authority: the page is linked only when it is the one the entry names.
  useEffect(() => {
    if (!pendingCallbackRevoke || loading || hostedCatalog === null) return;
    const entry = hostedCatalog.find((candidate) => candidate.entryId === pendingCallbackRevoke.entryId);
    const { revokeAt } = pendingCallbackRevoke;
    if (entry?.label && entry.revokePage === revokeAt && safeProviderRevokePage(revokeAt)) {
      setHostedMcpCallbackRevoke({ entryId: pendingCallbackRevoke.entryId, provider: entry.label, revokePage: revokeAt });
    }
    setPendingCallbackRevoke(null);
  }, [hostedCatalog, loading, pendingCallbackRevoke]);

  // The hosted-MCP callback says when a previous provider authorization may
  // need manual attention. Resolve its page from the authenticated connection
  // row and match the callback copy to that server-owned value; never turn an
  // arbitrary query parameter into a provider link.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('hostedMcp') !== 'connected') return;
    // Let the ordinary page load finish first; its authenticated row is the
    // authority for the provider link, so there is no second request here.
    if (loading || hostedCatalog === null) return;
    const entryId = query.get('entryId');
    const revokeAt = query.get('revokeAt');
    if (entryId && revokeAt) {
      const row = connectors.find((candidate) => (
        candidate.type === 'hosted-mcp' && candidate.config?.entryId === entryId
      ));
      const revokePage = row?.config?.revokePage;
      const provider = hostedCatalog?.find((entry) => entry.entryId === entryId)?.label;
      if (row && provider && revokePage === revokeAt && safeProviderRevokePage(revokePage)) {
        setHostedMcpManualRevoke({
          connectionId: row._id,
          entryId,
          provider,
          revokePage,
        });
      }
    }
    query.delete('hostedMcp');
    query.delete('entryId');
    query.delete('revokeAt');
    query.delete('code');
    const remaining = query.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${remaining ? `?${remaining}` : ''}${window.location.hash}`,
    );
  }, [connectors, hostedCatalog, loading]);

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
        // The server decides this. A pod the user is listed in is a connector
        // target UNLESS its type is one the default listing hides (`agent-admin`):
        // installing into one, gating one, or making one active all 403, so this
        // list — built from that same endpoint — offers exactly what those verbs
        // accept (TASK-171).
        const data = await api.get<V2Pod[]>('/api/pods');
        const eligible = Array.isArray(data) ? data : [];
        if (!cancelled) {
          setPods(eligible);
          setPodListFailed(false);
          setNewPodId((current) => current || defaultPodForChannel(eligible));
        }
      } catch {
        // Keep the normal picker visible when membership cannot be read. A
        // zero-pod CTA requires a confirmed `[]`, never an unavailable read.
        if (!cancelled) setPodListFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const untitledPodName = (): string => t('connectors.untitledPod', { defaultValue: 'Untitled pod' });

  const podNameById = (podId: string | null | undefined, fallback?: Connector | null): string => {
    const pod = podList.find((candidate) => String(candidate._id) === String(podId || ''));
    if (pod) return pod.name || untitledPodName();
    if (fallback && typeof fallback.podId === 'object' && fallback.podId?.name) return fallback.podId.name;
    return untitledPodName();
  };

  const boundPodName = (boundPodId: string | undefined): string => {
    const existing = connectors.find((connector) => connectorPodId(connector) === String(boundPodId));
    const boundPod = podList.find((pod) => String(pod._id) === String(boundPodId));
    return existing
      ? podNameById(connectorPodId(existing), existing)
      : (boundPod?.name || t('connectors.anotherPod', { defaultValue: 'another pod' }));
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
          // TASK-173: name the controls the page actually shows. "gate" is
          // this file's internal name for the switches (ConnectorGate,
          // expandedGate, writeGate) and it had leaked into the only
          // user-visible string on the page that used it. The section is
          // `connectors.gatesTitle` ("Pods that reach this channel", :1106).
          //
          // The aside that HOLDS that section is labelled "Channel details"
          // (:1220, :1286) — an `aria-label`, not visible text, so naming it in
          // the copy sent a sighted user hunting for a string the page never
          // renders. That is the same defect as "gate switches" sourced from an
          // attribute instead of an identifier (TASK-173 gate), so the
          // copy names the section title alone.
          defaultValue: 'Your {{connector}} channel is bound to {{pod}}. Other pods reach it through "Pods that reach this channel" — switch a pod on there.',
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
  // The server validates every key against membership and refuses the whole
  // body on the first miss, so a gate for a pod the owner has since left
  // (not yet pruned by the reconciler) is dropped here rather than sent —
  // otherwise every toggle would 403 for up to one sweep.
  const writeGate = (connector: Connector, podId: string, next: ConnectorGate) => {
    const current = connector.config?.gates || {};
    const memberOf = new Set(podList.map((pod) => String(pod._id)));
    const gates: Record<string, ConnectorGate> = {};
    Object.entries(current).forEach(([key, gate]) => {
      if (!memberOf.has(String(key))) return;
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

  // The refusal is named from the response body, not swallowed: a bare catch
  // here is what hid `slack_already_authorized` from the row (Row C).
  const refusalCopy = (requestError: unknown, fallbackKey: string, fallbackDefault: string): string => {
    const { data } = installErrorResponse(requestError);
    const known = data?.code ? SLACK_REFUSALS[data.code] : undefined;
    if (known) return t(known.key, { defaultValue: known.defaultValue });
    if (data?.error) return data.error;
    return t(fallbackKey, { defaultValue: fallbackDefault });
  };

  const authorizeSlack = async (connector: Connector, rowKey: string) => {
    if (busyId) return;
    const authorizationWindow = window.open('', '_blank');
    setBusyId(connector._id);
    setError(null);
    setRowRefusal(null);
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
    } catch (requestError) {
      authorizationWindow?.close();
      setRowRefusal({
        key: rowKey,
        message: refusalCopy(requestError, 'connectors.slackAuthorizeError', 'Could not begin Slack authorization. Try again in a moment.'),
      });
    } finally {
      setBusyId(null);
    }
  };

  const resolveSlackBind = async (connector: Connector, action: 'confirm' | 'reject', rowKey: string, lead?: string) => {
    if (busyId) return;
    setBusyId(connector._id);
    setError(null);
    setRowRefusal(null);
    try {
      await api.post(`/api/installables/slack/${action}`, action === 'confirm' && lead
        ? { leadAgentUsername: lead } : {});
      await load();
    } catch (requestError) {
      setRowRefusal({
        key: rowKey,
        message: refusalCopy(requestError, 'connectors.slackBindError', 'Could not update the Slack connection. Try again in a moment.'),
      });
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

  // The age as a unit-suffixed number from the timestamp ("23d", "5m", "just now"),
  // and a verb line built from a key — the kicker's source of truth.
  const shortAge = (date?: string | null): string => {
    const timestamp = date ? new Date(date).getTime() : NaN;
    if (!Number.isFinite(timestamp)) return t('time.age.justNow', { defaultValue: 'just now' });
    const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
    if (minutes < 1) return t('time.age.justNow', { defaultValue: 'just now' });
    if (minutes < 60) return t('time.age.minutes', { defaultValue: '{{n}}m', n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time.age.hours', { defaultValue: '{{n}}h', n: hours });
    return t('time.age.days', { defaultValue: '{{n}}d', n: Math.floor(hours / 24) });
  };
  const ageLine = (verb: 'added' | 'started' | 'since' | 'paused' | 'slackAnswered', date?: string | null): string => {
    const age = shortAge(date);
    switch (verb) {
      case 'added': return t('connectors.age.added', { defaultValue: 'added {{age}}', age });
      case 'started': return t('connectors.age.started', { defaultValue: 'started {{age}}', age });
      case 'since': return t('connectors.age.since', { defaultValue: 'since {{age}}', age });
      case 'paused': return t('connectors.age.paused', { defaultValue: 'paused {{age}}', age });
      default: return t('connectors.age.slackAnswered', { defaultValue: 'Slack answered {{age}}', age });
    }
  };

  const rowFor = (connector: Connector): ConnectorRow => {
    const started = ageLine('started', connector.createdAt);
    const isTelegram = connector.type === 'telegram';
    const isSlack = connector.type === 'slack';
    const title = connector.config?.chatTitle || connector.config?.teamName || TYPE_LABELS[connector.type] || connector.type;

    if (connector.status === 'error') {
      return {
        action: isTelegram ? 'new-code' : isSlack ? 'authorize' : null,
        actionLabel: isTelegram ? t('connectors.newCode', { defaultValue: 'New code' }) : t('connectors.slackAuthorize', { defaultValue: 'Authorize in Slack' }),
        detail: t('connectors.errorReconnect', { defaultValue: 'reconnect to resume' }),
        dot: 'empty',
        line: connector.errorMessageUserFacing && connector.errorMessage
          ? connector.errorMessage
          : t('connectors.errorLine', { defaultValue: 'The connection dropped.' }),
        pulse: false,
        when: ageLine('since', connector.updatedAt || connector.createdAt),
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
          when: ageLine('added', connector.createdAt),
        };
      }
      const relay = Boolean(connector.config?.liveRelay);
      const mirror = connector.config?.relayAllAgentMessages === true;
      const recent = connector.updatedAt && (Date.now() - new Date(connector.updatedAt).getTime()) < RECENT_MS;
      const markName: MarkName = relay ? (mirror ? 'mirror' : 'attention') : 'off';
      const markLabel = relay
        ? (mirror
          ? t('connectors.rowMirror', { defaultValue: 'every agent line reaches the channel' })
          : t('connectors.rowAttention', { defaultValue: 'escalations reach the channel' }))
        : t('connectors.rowRelayOff', { defaultValue: 'messages stay in the pod' });
      return {
        action: (isTelegram || isSlack) ? 'manage' : null,
        actionLabel: t('connectors.manage', { defaultValue: 'Manage' }),
        detail: '',
        mark: {
          name: markName,
          label: markLabel,
          word: relay
            ? (mirror ? t('connectors.kickerMirror', { defaultValue: 'mirror' }) : t('connectors.kickerAttention', { defaultValue: 'attention' }))
            : t('connectors.kickerOff', { defaultValue: 'relay off' }),
        },
        dot: relay ? 'live' : 'idle',
        line: t('connectors.linkedLine', { defaultValue: '{{title}} · linked to {{pod}}', title, pod: podNameById(activePodId, connector) }),
        pulse: relay && Boolean(recent),
        secondary: true,
        when: ageLine('added', connector.createdAt),
      };
    }

    if (isTelegram && codeIsLive(connector)) {
      return {
        action: 'show-code',
        actionLabel: t('connectors.showCode', { defaultValue: 'Show code' }),
        detail: t('connectors.codeExpires', {
          defaultValue: 'Code expires in {{minutes}} min',
          minutes: codeExpiresInMinutes(connector),
        }),
        dot: 'pending',
        line: t('connectors.waitingTelegram', {
          defaultValue: 'Send /commonly-enable in your Telegram chat.',
        }),
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
      const workspace = connector.config.pendingBind.teamName || t('connectors.thisSlackWorkspace', { defaultValue: 'This Slack workspace' });
      const user = connector.config.pendingBind.slackUserName
        ? `@${connector.config.pendingBind.slackUserName}`
        : t('connectors.yourSlackUser', { defaultValue: 'your Slack user' });
      return {
        action: 'confirm',
        actionLabel: t('connectors.slackConfirm', { defaultValue: 'Confirm' }),
        detail: t('connectors.slackConfirmDetail', { defaultValue: 'waiting for you to confirm' }),
        dot: 'pending',
        line: t('connectors.slackConfirmRow', { defaultValue: '{{workspace}} says {{user}} connected — is that you?', workspace, user }),
        pulse: true,
        when: ageLine('slackAnswered', connector.updatedAt || connector.createdAt),
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
      line: t('connectors.waitingToConnect', { defaultValue: '{{label}} is waiting to connect.', label: TYPE_LABELS[connector.type] || connector.type }),
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
        // The copy decision here is main's, not this branch's: this commit set
        // `detail: ''` citing the 09-04 one-state-line rule, but #1557 landed
        // the detail AFTER that ruling and its tests assert the text is present.
        // A rebase is not the place to re-open it, so the line is restored and
        // raised on the row; everything else in the commit is unchanged.
        detail: t('connectors.askOperator', { defaultValue: 'ask your operator' }),
        dot: 'not-yet',
        line: t('connectors.notEnabled', { defaultValue: 'Not offered on this instance.' }),
        muted: true,
        notEnabled: true,
        pulse: false,
        when: '—',
      };
    }
    // Usable here, but with nothing to install: declaring readiness is a claim
    // about this instance's keys, not about whether a row exists to install.
    // Showing the Add anyway is what produced a lowercase `discord` row whose
    // click ended in 404 installable_not_found.
    if (entry.offered === false) {
      return {
        action: null,
        detail: '',
        dot: 'not-yet',
        line: t('connectors.notConnectable', { defaultValue: 'Unavailable here.' }),
        muted: true,
        // The class and the Ask link are right for this row; the kicker was the
        // part that lied. Measured in the keys-set render at #1826: the eyebrow
        // read "not enabled" directly above "Not connectable yet.", i.e. asking
        // an operator for credentials the operator had already installed.
        notConnectable: true,
        notEnabled: true,
        pulse: false,
        when: '—',
      };
    }
    if (!installation) {
      const connectDetail = CONNECT_DETAIL[entry.installableId];
      return {
        action: 'connect',
        // The row action opens the pod picker; the form's Connect button is
        // the actual install action. Distinct labels keep the two-step flow
        // legible to a stranger.
        actionLabel: t('connectors.add', { defaultValue: 'Add' }),
        detail: connectDetail
          ? t(connectDetail.key, { defaultValue: connectDetail.defaultValue })
          : '',
        dot: 'empty',
        line: catalogDescription(i18n, entry.installableId, entry.description) || t('connectors.availableLine', { defaultValue: 'Connect {{label}} to a pod.', label }),
        pulse: false,
        when: t('connectors.notConnected', { defaultValue: 'not connected' }),
      };
    }
    const since = ageLine('since', installation.updatedAt);
    const started = ageLine('started', installation.claimedAt || installation.updatedAt);
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
        line: installation.errorMessageUserFacing && installation.errorMessage
          ? installation.errorMessage
          : t('connectors.setupFailed', { defaultValue: 'Setup didn’t finish.' }),
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
        when: ageLine('paused', pause?.at || installation.updatedAt),
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
  // D215: a provider this instance does not offer is not listed, so a connector
  // nobody here has walked is never shown. The API still reports it (the
  // offerability contract), and someone who already installed it keeps their
  // row, which renders in the not-connectable state below.
  const listedCatalog = (catalog || []).filter((entry) => (
    entry.offered !== false || Boolean(entry.installation) || Boolean(entry.integration)
  ));
  const allItems: ListItem[] = [
    ...listedCatalog.map((entry): ListItem => ({
      kind: 'catalog',
      key: `catalog:${entry.installableId}`,
      entry,
      connector: connectorForEntry(entry),
    })),
    // Rows the catalog does not describe: legacy pod-scoped connectors, and
    // installable rows only while the catalog itself cannot be read.
    ...connectors
      .filter((connector) => (
        !TOOL_ONLY_CONNECTION_TYPES.has(connector.type)
        && !(connector.installationId && catalogTypes.has(connector.type))
      ))
      .map((connector): ListItem => ({ kind: 'legacy', key: `legacy:${connector._id}`, connector })),
  ];

  const rowForItem = (item: ListItem): ConnectorRow => (
    item.kind === 'catalog' ? rowForEntry(item.entry, item.connector) : rowFor(item.connector)
  );

  const itemLabel = (item: ListItem): string | null => (
    item.kind === 'catalog'
      ? (item.entry.label?.trim() || mappedTypeLabel(item.entry.installableId))
      : mappedTypeLabel(item.connector.type)
  );

  // A backend type is an identifier, not a customer-facing name. Unknown types
  // have no Channels row until the catalog provides a label or this map does.
  const items = allItems.filter((item) => Boolean(itemLabel(item)));
  const connectedCount = items.filter((item) => item.connector?.status === 'connected').length;
  const itemType = (item: ListItem): string => (item.kind === 'catalog' ? item.entry.installableId : item.connector.type);

  const needsUser = (row: ConnectorRow): boolean => row.action !== null && !row.secondary && row.action !== 'connect';
  const selectItem = (item: ListItem) => {
    setSelectedKey(item.key);
    setConfirmRemove(null);
    setExpandedGate(null);
    // TASK-155: while the form is open it owns the aside, so a row click or a
    // row's gear has to close it — otherwise the click looks like it did
    // nothing, which is the symptom this page was reported for pointed the
    // other way. `runAction` calls this first and re-opens the form for
    // `connect`, so Add is unaffected.
    setAddingType(null);
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
    if (action === 'authorize') return authorizeSlack(connector, item.key);
    // The row opens the aside where the active pod's lead can be chosen.
    // Sending a confirm here would silently omit that choice.
    if (action === 'confirm') return undefined;
    return undefined;
  };

  const busyFor = (item: ListItem): boolean => busyId === item.key || (item.connector !== null && busyId === item.connector._id);

  return {
    connectors,
    setConnectors,
    catalog,
    setCatalog,
    hostedCatalog,
    setHostedCatalog,
    pods,
    setPods,
    newPodId,
    setNewPodId,
    addingType,
    setAddingType,
    loading,
    setLoading,
    busyId,
    setBusyId,
    creating,
    setCreating,
    selectedKey,
    setSelectedKey,
    confirmRemove,
    setConfirmRemove,
    expandedGate,
    setExpandedGate,
    copied,
    setCopied,
    error,
    setError,
    hostedMcpManualRevoke,
    setHostedMcpManualRevoke,
    rowRefusal,
    setRowRefusal,
    slackCallbackError,
    setSlackCallbackError,
    slackLeadChoices,
    setSlackLeadChoices,
    hostedMcpCallbackError,
    setHostedMcpCallbackError,
    hostedMcpCallbackRevoke,
    pollRef,
    podPickerRef,
    now,
    adding,
    podList,
    podListFailed,
    gateModes,
    load,
    hasPending,
    untitledPodName,
    podNameById,
    boundPodName,
    installInProgressMessage,
    install,
    createConnector,
    patchIntegration,
    patchConfig,
    writeGate,
    makeActive,
    regenerateCode,
    refusalCopy,
    authorizeSlack,
    resolveSlackBind,
    uninstall,
    remove,
    retry,
    copyCommand,
    shortAge,
    ageLine,
    rowFor,
    rowForEntry,
    connectorForEntry,
    catalogTypes,
    listedCatalog,
    allItems,
    rowForItem,
    itemLabel,
    items,
    connectedCount,
    itemType,
    needsUser,
    selectItem,
    runAction,
    busyFor,
  };
};

export type ChannelConnectorsModel = ReturnType<typeof useChannelConnectors>;
