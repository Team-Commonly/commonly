// Tool connectors: state, effects and verbs of the Tools list, moved out of the
// retired tools list so the tile page and its panels share one model (TASK-733).
// The page draws it as tiles and a drawer.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useV2Api } from '../hooks/useV2Api';
import { useRelativeNow } from '../hooks/useRelativeNow';
import { useAuth } from '../../context/AuthContext';
import { V2Pod } from '../hooks/useV2Pods';
import { hostedMcpErrorNotice } from '../components/hostedMcpErrorNotice';
import { safeProviderRevokePage } from '../utils/safeProviderRevokePage';
import {
  USED_RECENTLY_MS,
  MODE_RANK,
  WRITE_MODES,
  isDead,
  entryCovers,
} from './toolModel';
import type {
  GrantWriteMode,
  ToolGrant,
  ToolOutcome,
  ToolTrail,
  ToolCatalogEntry,
  HiddenToolConnection,
  PodSeat,
  DraftGrant,
  GithubAppSetup,
  GithubAppIntegrationResponse,
  HostedMcpManualRevokeNotice,
} from './toolModel';

export const useToolConnectors = (pods: V2Pod[], manualRevokeNotice: HostedMcpManualRevokeNotice | null = null) => {
  const { t } = useTranslation();
  const api = useV2Api();
  // Revoke and Change access are the granter's: the route 403s anyone else.
  const { currentUser } = useAuth();
  const viewerId = currentUser?._id ? String(currentUser._id) : '';
  const isGranter = (grant: ToolGrant): boolean => Boolean(viewerId) && grant.grantedBy === viewerId;
  const [rawGrants, setGrants] = useState<ToolGrant[] | null>(null);
  const [rawCatalog, setCatalog] = useState<ToolCatalogEntry[]>([]);
  // A connection the server confirmed removed stays removed on this page, as a stale catalogue read could bring it back.
  const [disconnectedHere, setDisconnectedHere] = useState<string[]>([]);
  const [hiddenConnections, setHiddenConnections] = useState<HiddenToolConnection[]>([]);
  const [seats, setSeats] = useState<Record<string, PodSeat[]>>({});
  const [lastUse, setLastUse] = useState<Record<string, string | null>>({});
  const [trail, setTrail] = useState<ToolTrail | null>(null);
  const [trailError, setTrailError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftGrant | null>(null);
  const [githubAppSetup, setGithubAppSetup] = useState<GithubAppSetup | null>(null);
  // Change access minted the new grant but the revoke of the old one failed: only the revoke is retried.
  const [staleAfterChange, setStaleAfterChange] = useState<{ oldGrantId: string; newGrantId: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  // A revoke is irreversible, so once the server has said yes the grant stays
  // revoked on this page whatever a later read returns. Without this, the card
  // kept saying "granted" when the reload came back stale or failed.
  const [revokedHere, setRevokedHere] = useState<Record<string, string>>({});
  const [confirmHiddenRemoval, setConfirmHiddenRemoval] = useState<string | null>(null);
  const [removedHiddenNotice, setRemovedHiddenNotice] = useState<{ label: string; revokePage: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinPolicyFixPodId, setJoinPolicyFixPodId] = useState<string | null>(null);
  const [policyFixedPodId, setPolicyFixedPodId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const catalog = useMemo(() => (disconnectedHere.length === 0 ? rawCatalog : rawCatalog.map((entry) => ({
    ...entry,
    connections: entry.connections.filter((connection) => !disconnectedHere.includes(connection.connectionId)),
  }))), [rawCatalog, disconnectedHere]);
  const grants = useMemo(() => (rawGrants === null ? null : rawGrants.map((grant) => (
    revokedHere[grant.grantId] && !grant.revokedAt
      ? { ...grant, revokedAt: revokedHere[grant.grantId], revokedBy: grant.revokedBy ?? (viewerId || null) }
      : grant
  ))), [rawGrants, revokedHere, viewerId]);
  // Grants and trail rows carry relative ages; they must advance while the
  // page sits open and be re-read when the tab comes back (TASK-131).
  const now = useRelativeNow();

  const isAdmin = currentUser?.role === 'admin';

  const podIds = useMemo(() => pods.map((pod) => String(pod._id)), [pods]);

  const load = useCallback(async () => {
    const catalogRes = await api.get<{ installables?: ToolCatalogEntry[]; hiddenToolConnections?: HiddenToolConnection[] }>('/api/installables').catch(() => null);
    setCatalog((catalogRes?.installables || []).filter((entry) => entry.list === 'tools'));
    setHiddenConnections(catalogRes?.hiddenToolConnections || []);
    const [grantRes, seatResults] = await Promise.all([
      api.get<{ grants: ToolGrant[] }>('/api/grants', { params: { connectionOwner: 'me' } }).catch(() => null),
      Promise.all(podIds.map(async (podId) => {
        const res = await api.get<{ agents?: PodSeat[] }>(`/api/registry/pods/${podId}/agents`).catch(() => null);
        return [podId, (res?.agents ?? []).filter((seat) => !seat.internal)] as const;
      })),
    ]);
    const ownedGrants = grantRes?.grants || [];
    // A failed read must not blank a list the person is looking at.
    if (grantRes) setGrants(ownedGrants); else setGrants((current) => current ?? []);
    setSeats(Object.fromEntries(seatResults));
    // "used in the last 10 min" reads the newest trail row's `at` (§6).
    const uses = await Promise.all(ownedGrants.filter((grant) => !isDead(grant)).map(async (grant) => {
      const res = await api.get<ToolTrail>(`/api/grants/${grant.grantId}/calls`, { params: { limit: 1 } }).catch(() => null);
      return [grant.grantId, res?.calls?.[0]?.at ?? null] as const;
    }));
    setLastUse(Object.fromEntries(uses));
  }, [api, podIds]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [load]);

  useEffect(() => {
    if (!selectedId) { setTrail(null); return undefined; }
    let cancelled = false;
    setTrail(null);
    setTrailError(false);
    api.get<ToolTrail>(`/api/grants/${selectedId}/calls`)
      .then((res) => { if (!cancelled) setTrail(res); })
      .catch(() => { if (!cancelled) setTrailError(true); });
    return () => { cancelled = true; };
  }, [api, selectedId]);

  // The entry a grant belongs to is the one whose namespaced tools it carries.
  // If the catalogue no longer has that entry, keep the row visibly unknown;
  // assigning it to GitHub would misstate who owns the grant and its policy.
  const entryFor = (grant: ToolGrant): ToolCatalogEntry | null => (
    catalog.find((entry) => entryCovers(entry, grant)) || null
  );
  const noticeMatchesEntry = (entry: ToolCatalogEntry | null): boolean => Boolean(
    manualRevokeNotice
    && entry?.entryId === manualRevokeNotice.entryId
    && entry.connections.some((connection) => connection.connectionId === manualRevokeNotice.connectionId),
  );
  const toolLabel = (grant: ToolGrant): string => entryFor(grant)?.label
    || t('tools.unknownConnector', { defaultValue: 'Unknown connector' });

  const podName = (podId: string): string => pods.find((pod) => String(pod._id) === podId)?.name || t('tools.aPod', { defaultValue: 'a pod' });
  // A bot member takes its curated displayName, then a non-default instanceId, then its
  // username. This client does not screen leaked runtime labels the way the server's
  // resolveAgentDisplayLabel does, so a bot whose displayName is a runtime name shows it.
  const memberName = (userId: string | null): string | null => {
    if (!userId) return null;
    for (const pod of pods) {
      for (const member of pod.members || []) {
        if (typeof member !== 'object' || !member || String(member._id) !== userId) continue;
        const instanceId = member.botMetadata?.instanceId;
        const botLabel = member.botMetadata?.displayName?.trim()
          || (instanceId && instanceId !== 'default' ? instanceId : '');
        if (botLabel) return botLabel;
        if (member.username) return member.username;
      }
    }
    return null;
  };
  const seatLabel = (podId: string | null, userId: string): string => {
    const pool = podId ? (seats[podId] || []) : Object.values(seats).flat();
    const seat = pool.find((row) => row.userId === userId) || Object.values(seats).flat().find((row) => row.userId === userId);
    if (seat) return seat.displayName || seat.name;
    // `seats` is the agent list, and a pod grant's audience is a snapshot of the
    // room's members — so a human in it resolved to nothing and the row read
    // "an agent, an agent, <seat>". Name the member instead of asserting an
    // identity the server never claimed (TASK-050).
    return memberName(userId) || t('tools.aSeat', { defaultValue: 'an agent' });
  };
  const grantPodId = (grant: ToolGrant): string | null => {
    if (grant.target.kind === 'pod') return grant.target.id;
    const entry = Object.entries(seats).find(([, rows]) => rows.some((row) => row.userId === grant.target.id));
    return entry ? entry[0] : null;
  };
  // zh joins a list with 、 and en with ', ', so the separator is copy and not a
  // literal at each join site (TASK-164).
  const joinList = (items: string[]): string => items.join(t('tools.listSeparator', { defaultValue: ', ' }));
  const audienceLabels = (grant: ToolGrant): string => {
    const podId = grantPodId(grant);
    const labels = grant.effectiveAudience.map((id) => seatLabel(podId, id));
    if (labels.length === 0) return t('tools.nobody', { defaultValue: 'no agent' });
    return joinList(labels);
  };
  const irreversibleTools = (entry: ToolCatalogEntry | null, tools: string[]): string[] => (entry?.tools || [])
    .filter((tool) => tool.irreversible && tools.includes(tool.name)).map((tool) => tool.name);
  const asksFirst = (grant: ToolGrant): string => {
    if (grant.writeMode === 'read') return t('tools.asksNothing', { defaultValue: 'nothing asks first' });
    if (grant.writeMode === 'write-with-confirm') return t('tools.asksEveryWrite', { defaultValue: 'every write asks first' });
    // Under `write` the floor is the tool's own irreversible flag (piece 2b): the list is the catalogue's.
    const entry = entryFor(grant);
    if (!entry) return t('tools.unknownWritePolicy', { defaultValue: 'write policy unavailable' });
    const list = irreversibleTools(entry, grant.tools);
    return list.length
      ? t('tools.asksList', { defaultValue: '{{tools}} ask first', tools: joinList(list) })
      : t('tools.asksNothing', { defaultValue: 'nothing asks first' });
  };
  const outcomeLabel = (outcome: ToolOutcome): string => ({
    ok: t('tools.outcomeOk', { defaultValue: 'ok' }),
    refused: t('tools.outcomeRefused', { defaultValue: 'refused' }),
    pending_approval: t('tools.awaiting', { defaultValue: 'awaiting a person' }),
    superseded: t('tools.outcomeSuperseded', { defaultValue: 'answered' }),
    failed: t('tools.outcomeFailed', { defaultValue: 'failed' }),
  })[outcome] || outcome;
  // Plain words for why a refused or failed call did not run. An unlabelled code shows as-is.
  const reasonLabel = (reason: string): string => {
    const labels: Record<string, string> = {
      not_in_audience: t('tools.reasonNotInAudience', { defaultValue: 'this seat is outside the grant audience' }),
      tool_not_allowed: t('tools.reasonToolNotAllowed', { defaultValue: 'this tool is not on the allow-list' }),
      write_mode_not_allowed: t('tools.reasonWriteNotAllowed', { defaultValue: 'writes are not granted' }),
      grant_revoked: t('tools.reasonGrantRevoked', { defaultValue: 'the grant was revoked' }),
      grant_expired: t('tools.reasonGrantExpired', { defaultValue: 'the grant expired' }),
      budget_exhausted: t('tools.reasonBudgetExhausted', { defaultValue: 'the call budget is spent' }),
      approval_unavailable: t('tools.reasonApprovalUnavailable', { defaultValue: 'no one could be asked to approve it' }),
      approval_declined: t('tools.reasonApprovalDeclined', { defaultValue: 'approval was declined' }),
      approval_expired: t('tools.reasonApprovalExpired', { defaultValue: 'approval expired before the call ran' }),
      invalid_tool_args: t('tools.reasonInvalidArgs', { defaultValue: 'the arguments did not validate' }),
      connection_mismatch: t('tools.reasonConnectionMismatch', { defaultValue: 'the connection no longer matches the grant' }),
      reconnect_required: t('tools.reasonReconnect', { defaultValue: 'the connection needs reconnecting' }),
      credential_missing: t('tools.reasonCredentialMissing', { defaultValue: 'no credential is stored' }),
      credential_rejected: t('tools.reasonCredentialRejected', { defaultValue: 'the provider rejected the credential' }),
      refresh_unreachable: t('tools.reasonRefreshUnreachable', { defaultValue: 'the credential could not be refreshed' }),
      provider_error: t('tools.reasonProviderError', { defaultValue: 'the provider returned an error' }),
      provider_unreachable: t('tools.reasonProviderUnreachable', { defaultValue: 'the provider could not be reached' }),
      upstream_tool_error: t('tools.reasonUpstreamToolError', { defaultValue: 'the provider tool returned an error' }),
      broker_unavailable: t('tools.reasonBrokerUnavailable', { defaultValue: 'the broker was unavailable' }),
      broker_error: t('tools.reasonBrokerError', { defaultValue: 'the broker failed' }),
    };
    // Own keys only: a code such as `constructor` or `__proto__` must show as itself, not as an inherited member.
    return Object.prototype.hasOwnProperty.call(labels, reason) ? labels[reason] : reason;
  };
  const modeLabel = (mode: GrantWriteMode): string => ({
    read: t('tools.modeRead', { defaultValue: 'read' }),
    'write-with-confirm': t('tools.modeWriteConfirm', { defaultValue: 'read and write, ask first' }),
    write: t('tools.modeWrite', { defaultValue: 'read and write' }),
  })[mode];

  const entryGrantModes = (entry: ToolCatalogEntry): GrantWriteMode[] => {
    if (entry.connectionType !== 'hosted-mcp') return WRITE_MODES;
    return entry.tools.some((tool) => tool.requiredWriteMode !== 'read')
      ? ['read', 'write-with-confirm']
      : ['read'];
  };

  const entryModeCopy = (entry: ToolCatalogEntry): string => {
    const modes = entryGrantModes(entry);
    return modes.length === 1
      ? modeLabel(modes[0])
      : t('tools.readOrWrite', { defaultValue: 'read, or read and write' });
  };

  const usedRecently = (grant: ToolGrant): boolean => {
    const at = lastUse[grant.grantId];
    return Boolean(at) && Date.now() - new Date(at as string).getTime() < USED_RECENTLY_MS;
  };

  const q = query.trim().toLowerCase();
  const selected = selectedId ? (grants || []).find((grant) => grant.grantId === selectedId) || null : null;

  const openDraft = (entry: ToolCatalogEntry, from?: ToolGrant) => {
    const podId = from ? (grantPodId(from) || podIds[0] || '') : (podIds[0] || '');
    const modes = entryGrantModes(entry);
    const agentIds = (seats[podId] || []).map((seat) => seat.userId).filter((id): id is string => Boolean(id));
    setDraft({
      entry,
      podId,
      connectionId: entry.connections[0]?.connectionId || '',
      writeMode: from && modes.includes(from.writeMode) ? from.writeMode : modes[0] || 'read',
      audience: from ? agentIds.filter((id) => from.effectiveAudience.includes(id)) : agentIds,
      expiryDays: 7,
      replaces: from && !isDead(from) ? from.grantId : null,
    });
    setSelectedId(null);
    setConfirmRevoke(null);
    setError(null);
    setJoinPolicyFixPodId(null);
    setPolicyFixedPodId(null);
  };
  const openGithubAppSetup = () => {
    setGithubAppSetup({ installationId: '', owner: '', repo: '' });
    setDraft(null);
    setSelectedId(null);
    setConfirmRevoke(null);
    setError(null);
  };
  // A background catalogue read can fail or stop offering this connection.
  // Keep the open draft (and any server refusal) visible in either case. The
  // mint still checks ownership, connection state, tools, audience and pod policy.
  const draftEntry = draft
    ? catalog.find((entry) => entry.installableId === draft.entry.installableId) || draft.entry
    : null;
  const draftTools = (entry: ToolCatalogEntry | null, mode: GrantWriteMode): string[] => (entry?.tools || [])
    .filter((tool) => MODE_RANK[tool.requiredWriteMode] <= MODE_RANK[mode]).map((tool) => tool.name);

  const selectedAgentIds = (draft ? seats[draft.podId] || [] : [])
    .map((seat) => seat.userId)
    .filter((id): id is string => typeof id === 'string' && Boolean(id) && draft?.audience.includes(id) === true);

  const submitDraft = async () => {
    if (!draft || !draftEntry || selectedAgentIds.length === 0) return;
    setBusy(true);
    setError(null);
    setJoinPolicyFixPodId(null);
    setPolicyFixedPodId(null);
    try {
      const expiresAt = new Date(Date.now() + draft.expiryDays * 86_400_000).toISOString();
      // The mint's body, as routes/grants.ts takes it: the server names the broker
      // and takes the installation from the Connection (#1677) — neither is the caller's.
      const minted = await api.post<{ grantId?: string }>('/api/grants', {
        connectionId: draft.connectionId,
        target: { kind: 'pod', id: draft.podId },
        tools: draftTools(draftEntry, draft.writeMode),
        writeMode: draft.writeMode,
        audience: selectedAgentIds,
        expiresAt,
      });
      // A resolved request alone is not a mint receipt (for example, an HTML
      // fallback or empty response). Keep the form and the old grant intact.
      if (typeof minted?.grantId !== 'string' || !minted.grantId.trim()) {
        setError(t('tools.grantError', { defaultValue: 'Could not grant it.' }));
        return;
      }
      // Change access: a change is a new grant and a revoke of the old one, because `tools` is never
      // widened in place. The mint is kept whatever happens next; a failed revoke is retried alone
      // (0368992e), never by minting a third grant.
      if (draft.replaces) {
        const oldGrantId = draft.replaces;
        const newGrantId = String(minted?.grantId || '');
        try {
          await api.post(`/api/grants/${oldGrantId}/revoke`);
          markRevoked(oldGrantId);
        } catch {
          setStaleAfterChange({ oldGrantId, newGrantId });
          setDraft(null);
          setSelectedId(oldGrantId);
          await load();
          return;
        }
      }
      setDraft(null);
      await load();
    } catch (err) {
      const code = (err as { response?: { data?: { error?: string; message?: string } } })?.response?.data;
      setError(code?.message || code?.error || t('tools.grantError', { defaultValue: 'Could not grant it.' }));
      const creator = pods.find((pod) => pod._id === draft.podId)?.createdBy as { _id?: string } | string | undefined;
      const owner = typeof creator === 'string' ? creator : creator?._id;
      if (code?.error === 'outsider_grant_pod_joinable' && owner === viewerId) {
        setJoinPolicyFixPodId(draft.podId);
      }
    } finally {
      setBusy(false);
    }
  };

  const fixJoinPolicy = async () => {
    if (!draft || joinPolicyFixPodId !== draft.podId || busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/pods/${encodeURIComponent(draft.podId)}/join-policy`, { joinPolicy: 'invite-only' });
      setJoinPolicyFixPodId(null);
      setPolicyFixedPodId(draft.podId);
      setError(null);
    } catch (requestError) {
      const data = (requestError as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
      setError(data?.message || data?.error || t('tools.joinPolicyError', { defaultValue: 'Could not make this pod invite-only.' }));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Connect a hosted-MCP entry (scope §4): the start route answers with the
   * vendor's authorize URL and sets the flow's browser nonce as an httpOnly
   * cookie on the SAME response.
   *
   * `withCredentials` is what keeps that cookie: the API is a different origin
   * from the app, so without it the browser drops the `Set-Cookie` and every
   * callback refuses `invalid_state` — a person consents at the vendor and comes
   * back to a row that is still not connected. A backend test sets the cookie
   * itself and cannot witness this, which is why it is asserted here.
   */
  const connectHostedMcp = async (entry: ToolCatalogEntry) => {
    if (busy || !entry.entryId) return;
    const authorizationWindow = window.open('', '_blank');
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ authorizeUrl?: string }>(
        `/api/integrations/connect/hosted-mcp/${encodeURIComponent(entry.entryId)}/start`,
        {},
        { withCredentials: true },
      );
      if (!result.authorizeUrl) throw new Error('authorization URL was missing');
      if (authorizationWindow) {
        authorizationWindow.opener = null;
        authorizationWindow.location.assign(result.authorizeUrl);
      } else {
        window.location.assign(result.authorizeUrl);
      }
    } catch (err) {
      authorizationWindow?.close();
      const data = (err as { response?: { data?: { error?: string; message?: string } } })?.response?.data;
      setError(hostedMcpErrorNotice(t, data?.error));
    } finally {
      setBusy(false);
    }
  };

  const submitGithubAppSetup = async () => {
    if (!githubAppSetup || !isAdmin) return;
    const installationId = githubAppSetup.installationId.trim();
    const owner = githubAppSetup.owner.trim();
    const repo = githubAppSetup.repo.trim();
    if (!installationId || !owner || !repo) {
      setError(t('tools.githubAppRequired', { defaultValue: 'Enter the installation ID, owner, and repository.' }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<GithubAppIntegrationResponse>('/api/integrations/github-app', { installationId, owner, repo });
      const createdBy = response?.integration?.createdBy;
      const createdById = typeof createdBy === 'string'
        ? createdBy
        : createdBy && typeof createdBy === 'object' && createdBy._id
          ? String(createdBy._id)
          : '';
      if (createdById && viewerId && createdById !== viewerId) {
        setError(t('tools.githubAppOwnedByOther', { defaultValue: 'This GitHub App is already installed by another administrator.' }));
        return;
      }
      setGithubAppSetup(null);
      await load();
    } catch (err) {
      const code = (err as { response?: { data?: { error?: string; message?: string } } })?.response?.data;
      setError(code?.message || code?.error || t('tools.githubAppError', { defaultValue: 'Could not install the GitHub App.' }));
    } finally {
      setBusy(false);
    }
  };

  const markRevoked = (grantId: string) => {
    setRevokedHere((current) => ({ ...current, [grantId]: new Date().toISOString() }));
  };

  const retryStaleRevoke = async () => {
    if (!staleAfterChange) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/grants/${staleAfterChange.oldGrantId}/revoke`);
      markRevoked(staleAfterChange.oldGrantId);
      setStaleAfterChange(null);
      await load();
    } catch {
      setError(t('tools.revokeError', { defaultValue: 'Could not revoke the grant.' }));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grant: ToolGrant) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/grants/${grant.grantId}/revoke`);
      markRevoked(grant.grantId);
      setConfirmRevoke(null);
      await load();
    } catch {
      setError(t('tools.revokeError', { defaultValue: 'Could not revoke the grant.' }));
    } finally {
      setBusy(false);
    }
  };

  const removeHiddenConnection = async (connection: HiddenToolConnection) => {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/integrations/${encodeURIComponent(connection.connectionId)}`);
      setConfirmHiddenRemoval(null);
      if (connection.revokePage) setRemovedHiddenNotice({ label: connection.label, revokePage: connection.revokePage });
      await load();
    } catch {
      setError(t('tools.removeConnectionError', { defaultValue: 'Could not remove the connection.' }));
    } finally {
      setBusy(false);
    }
  };

  // A live connection of an offered hosted connector. The removal verb is the
  // same one the not-offered row uses; the server revokes the connection's grants
  // as part of it, and answers `revokeAt` when the provider's own page still
  // needs a visit.
  const disconnect = async (entry: ToolCatalogEntry, connectionId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.del<{ revokeAt?: string }>(`/api/integrations/${encodeURIComponent(connectionId)}`);
      setConfirmDisconnect(null);
      setDisconnectedHere((current) => [...current, connectionId]);
      // The removal revokes every grant on the connection, so the page says so
      // now rather than waiting on a re-read that may fail.
      const ended = (grants || []).filter((grant) => !isDead(grant) && entryCovers(entry, grant));
      setRevokedHere((current) => ({ ...current, ...Object.fromEntries(ended.map((grant) => [grant.grantId, new Date().toISOString()])) }));
      setRemovedHiddenNotice({ label: entry.label, revokePage: safeProviderRevokePage(res?.revokeAt) ? res.revokeAt : null });
      await load();
    } catch (err) {
      // The route answers 502 with one of these codes when the grants are already
      // revoked and the row is disconnected, and only the provider's own revoke
      // failed. A bare 502 (ingress, a pod restarting) reached nothing, so it takes
      // the plain error below and marks nothing revoked.
      const response = (err as { response?: { status?: number; data?: { code?: string; revokeAt?: string } } })?.response;
      const partial = response?.status === 502
        && (response.data?.code === 'provider_revoke_failed' || response.data?.code === 'provider_revoked_removal_incomplete');
      if (partial) {
        const ended = (grants || []).filter((grant) => !isDead(grant) && entryCovers(entry, grant));
        setRevokedHere((current) => ({ ...current, ...Object.fromEntries(ended.map((grant) => [grant.grantId, new Date().toISOString()])) }));
        setConfirmDisconnect(null);
        setDisconnectedHere((current) => [...current, connectionId]);
        await load();
        if (safeProviderRevokePage(response?.data?.revokeAt)) {
          setRemovedHiddenNotice({ label: entry.label, revokePage: response?.data?.revokeAt as string });
        } else {
          setError(t('tools.disconnectPartial', { defaultValue: 'Disconnected {{label}} here, but {{label}} did not confirm. Remove Commonly in its connected apps.', label: entry.label }));
        }
      } else {
        setError(t('tools.disconnectError', { defaultValue: 'Could not disconnect {{label}}.', label: entry.label }));
      }
    } finally {
      setBusy(false);
    }
  };

  return {
    manualRevokeNotice,
    viewerId,
    isGranter,
    rawGrants,
    setGrants,
    catalog,
    setCatalog,
    hiddenConnections,
    setHiddenConnections,
    seats,
    setSeats,
    lastUse,
    setLastUse,
    trail,
    setTrail,
    trailError,
    setTrailError,
    selectedId,
    setSelectedId,
    draft,
    setDraft,
    githubAppSetup,
    setGithubAppSetup,
    staleAfterChange,
    setStaleAfterChange,
    confirmRevoke,
    setConfirmRevoke,
    confirmDisconnect,
    setConfirmDisconnect,
    revokedHere,
    setRevokedHere,
    confirmHiddenRemoval,
    setConfirmHiddenRemoval,
    removedHiddenNotice,
    setRemovedHiddenNotice,
    busy,
    setBusy,
    error,
    setError,
    joinPolicyFixPodId,
    setJoinPolicyFixPodId,
    policyFixedPodId,
    setPolicyFixedPodId,
    query,
    setQuery,
    grants,
    now,
    isAdmin,
    podIds,
    load,
    entryFor,
    noticeMatchesEntry,
    toolLabel,
    podName,
    memberName,
    seatLabel,
    grantPodId,
    joinList,
    audienceLabels,
    irreversibleTools,
    asksFirst,
    outcomeLabel,
    reasonLabel,
    modeLabel,
    entryGrantModes,
    entryModeCopy,
    usedRecently,
    q,
    selected,
    openDraft,
    openGithubAppSetup,
    draftEntry,
    draftTools,
    selectedAgentIds,
    submitDraft,
    fixJoinPolicy,
    connectHostedMcp,
    submitGithubAppSetup,
    markRevoked,
    retryStaleRevoke,
    revoke,
    removeHiddenConnection,
    disconnect,
  };
};

export type ToolConnectorsModel = ReturnType<typeof useToolConnectors>;
