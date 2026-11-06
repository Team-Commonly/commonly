// Pod/agent management routes — extracted from registry.js (GH#112)
// Handles: list agents in pod, get single agent, uninstall agent
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const AgentTemplate = require('../../models/AgentTemplate');
const AgentCredential = require('../../models/AgentCredential');
const Machine = require('../../models/Machine');
const { deriveAgentConnection } = require('../../services/agentConnectionStateService');
const { hostedRunsNative } = require('../../services/hostedEngine');
const { retireHostedRoomRows } = require('../../services/hostedRuntimeService');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentIdentityService = require('../../services/agentIdentityService');
const { outsiderGrantPodCounts } = require('../../services/nativeOutsiderGrantPolicy');
const { revokeRuntimeTokensAfterLastUninstall } = require('./tokens');
const { limitConcurrency } = require('../../utils/concurrencyLimit');
const {
  getUserId,
  isGlobalAdminUser,
  normalizeInstanceId,
  normalizeConfigMap,
  normalizeDisplayName,
  resolveInstallation,
  buildAgentProfileId,
  buildAgentInstallationPayload,
  resolveSeatRuntimeIdentities,
} = require('./helpers');

const podAgentsRouter = express.Router();

// How many of one roster request's reads hold a pool connection at once (F65).
// Prod runs one backend on Mongo's default pool of 100 and PG's 50, shared
// with chat and auth. Uncapped, a burst of ~100 rosters at ~12 reads each put
// ~1,100 reads ahead of a chat post: modelled chat p95 went 128ms → 512ms.
// At 4 it is 242ms, and one roster still drops from ~880ms to ~290ms.
const POD_AGENTS_READ_CONCURRENCY = 4;

/**
 * DELETE /api/registry/agents/:name/pods/:podId
 * Uninstall an agent from a pod
 */
podAgentsRouter.delete('/agents/:name/pods/:podId', auth, async (req: any, res: any) => {
  try {
    const { name, podId } = req.params;
    // Destructive writes must never use resolveInstallation's single-install
    // fallback: a stale instanceId could otherwise remove a different agent.
    const instanceId = normalizeInstanceId(req.query.instanceId);
    const installation = await AgentInstallation.findOne({
      agentName: String(name).toLowerCase(), podId, instanceId,
      status: { $ne: 'uninstalled' },
    });
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const isGlobalAdmin = await isGlobalAdminUser(userId);

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    // A DM's row names the agent's owner, who is not in the room when the
    // person talking to it is a guest. Either of them can end it.
    const isRoom = pod.type === 'agent-room';
    const ownsRoomRow = isRoom && installation?.installedBy?.toString?.() === userId.toString();

    if (!membership && !isCreator && !isGlobalAdmin && !ownsRoomRow) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation) {
      if (!isCreator && !isGlobalAdmin) {
        return res.status(404).json({ error: 'Agent not installed in this pod' });
      }

      const resolvedType = AgentIdentityService.resolveAgentType(name);
      const username = AgentIdentityService.buildAgentUsername(resolvedType, instanceId);
      const candidateUser = await User.findOne({ username, isBot: true })
        .select('_id agentRuntimeTokens botMetadata').lean();
      const agentUser = candidateUser?.botMetadata?.agentName === resolvedType
        && candidateUser?.botMetadata?.instanceId === instanceId ? candidateUser : null;
      const hasProfile = await AgentProfile.exists({ agentId: buildAgentProfileId(name, instanceId), podId });
      const hasMembership = agentUser && pod.members?.some((member: any) => (
        String(member?.userId || member) === String(agentUser._id)
      ));
      const hasCredential = agentUser && await AgentCredential.exists({
        agentUserId: agentUser._id, kind: 'runtime', status: 'active',
      });
      const installationNames = Array.from(new Set([name.toLowerCase(), resolvedType]));
      const activeIdentity = { agentName: { $in: installationNames }, instanceId, status: 'active' };
      const hasActiveInstallationHere = await AgentInstallation.exists({
        ...activeIdentity, podId,
      }).collation({ locale: 'en', strength: 2 });
      if (hasActiveInstallationHere) {
        return res.status(404).json({
          error: `Agent not installed under ${name}. Use agentName ${resolvedType} in the URL and instanceId as a query parameter.`,
        });
      }
      const hasActiveInstallation = await AgentInstallation.exists(activeIdentity)
        .collation({ locale: 'en', strength: 2 });
      const hasOrphanCredential = !hasActiveInstallation
        && (agentUser?.agentRuntimeTokens?.length || hasCredential);
      const hasPodArtifact = hasProfile || hasMembership;
      if (!hasPodArtifact && (!isGlobalAdmin || !hasOrphanCredential)) {
        return res.status(404).json({
          error: 'Agent not installed in this pod. Pass its agentName in the URL and instanceId as a query parameter.',
        });
      }

      await AgentProfile.deleteOne({ agentId: buildAgentProfileId(name, instanceId), podId });
      if (agentUser) {
        // Older uninstall paths could leave a bearer on an orphaned User row.
        await revokeRuntimeTokensAfterLastUninstall(name, instanceId);
        try {
          await AgentIdentityService.removeAgentFromPod(username, podId);
        } catch (identityError: unknown) {
          console.warn('Failed to remove agent user from pod:', (identityError as Error).message);
        }
      }

      return res.json({ success: true, removedOrphan: true });
    }

    const isInstaller = installation.installedBy?.toString?.() === userId.toString();

    if (!isCreator && !isInstaller && !isGlobalAdmin && !(isRoom && membership)) {
      return res.status(403).json({ error: 'Only pod admins or installers can remove agents' });
    }

    await AgentInstallation.uninstall(name, podId, instanceId);
    await retireHostedRoomRows(name, instanceId, installation.installedBy);
    await revokeRuntimeTokensAfterLastUninstall(name, instanceId);
    await AgentProfile.deleteOne({ agentId: buildAgentProfileId(name, instanceId), podId });

    // ADR-006 OQ #1: ephemeral self-serve registry rows whose only
    // installation was just removed are leaked here. v1 punts; the GC
    // janitor lands when orphan-row volume warrants it.

    try {
      const resolvedType = AgentIdentityService.resolveAgentType(name);
      await AgentIdentityService.removeAgentFromPod(
        AgentIdentityService.buildAgentUsername(resolvedType, instanceId),
        podId,
      );
    } catch (identityError: unknown) {
      console.warn('Failed to remove agent user from pod:', (identityError as Error).message);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error uninstalling agent:', error);
    res.status(500).json({ error: 'Failed to uninstall agent' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents
 * List agents installed in a pod
 */
podAgentsRouter.get('/pods/:podId/agents', auth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    // §3.7 read-access: members + creator allowed; for agent-dm, anyone
    // sharing a pod with either bot member is also allowed.
    // eslint-disable-next-line global-require
    const DMService = require('../../services/dmService');
    const canView = await DMService.canViewPod(userId, pod);

    if (!canView && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const installations = await AgentInstallation.getInstalledAgents(podId);
    const agentNames = installations.map((i: any) => i.agentName);

    // Everything below needs only the pod and its installs, so it runs
    // together: one request costs a handful of round trips, not one per
    // query (F65: 21 in a row at ~42ms each, and pages that fetch this once
    // per pod drew 504s). Only the connection and last-message reads wait,
    // for the bot User rows. Every read goes through `read`, so at most
    // POD_AGENTS_READ_CONCURRENCY hold a connection; the chained reads take
    // their slots after the User rows land, never while holding one.
    const read = limitConcurrency(POD_AGENTS_READ_CONCURRENCY);

    // The roster is advisory. The runtime middleware independently fails
    // closed; the Connectors page must not claim the seat can post on a bad read.
    const narrowingRead = read(() => outsiderGrantPodCounts(installations))
      .then((counts: Map<string, { pods: number; grantPods: number }>) => ({ counts, unavailable: false }))
      .catch((narrowingErr: Error) => {
        console.warn('[pod-agents] runtime narrowing lookup failed:', narrowingErr.message);
        return { counts: new Map<string, { pods: number; grantPods: number }>(), unavailable: true };
      });

    // One derivation for proof-of-life (heartbeats ∪ runs ∪ token use) —
    // shared with the native runtime's commonly_agent_status tool via
    // agentStateService. Advisory: never fail the roster over it.
    const activityRead = read(() => {
      const { collectPodAgentActivity } = require('../../services/agentStateService');
      return collectPodAgentActivity(String(podId), installations) as Promise<Map<string, Date | null>>;
    }).catch((activityErr: Error) => {
      console.warn('[pod-agents] activity lookup failed:', activityErr.message);
      return new Map<string, Date | null>();
    });

    // Heartbeat-only timestamps still ride the payload (lastHeartbeatAt is
    // its own field): one index seek per install (TASK-774).
    const heartbeatRead = read(() => {
      const { lastHeartbeatPerInstall } = require('../../services/agentStateService');
      return lastHeartbeatPerInstall(installations) as Promise<Map<string, Date>>;
    });

    const registryRead = read(() => AgentRegistry.find({
      agentName: { $in: agentNames },
    }).select('agentName iconUrl').lean());
    const installationDisplayNames = Array.from(new Set(
      installations.map((i: any) => i.displayName).filter(Boolean),
    ));
    const templateRead = read(() => AgentTemplate.find({
      agentName: { $in: agentNames },
      displayName: { $in: installationDisplayNames },
      $or: [
        { visibility: 'public' },
        { createdBy: userId },
        { createdBy: { $in: installations.map((i: any) => i.installedBy).filter(Boolean) } },
      ],
    }).select('agentName displayName iconUrl createdBy visibility').lean());

    const profileRead = read(() => AgentProfile.find({
      podId,
      agentName: { $in: agentNames },
    }).lean());

    // Batch-fetch the bot User rows so the payload builder can resolve
    // displayName via the curated `botMetadata.displayName` rather than
    // the (possibly stale) `installation.displayName`. ADR-001 §3.10:
    // identity is separate from package — the User row is the source of
    // truth for identity labels. Map by (agentName, instanceId).
    const usernameSet = new Set<string>();
    for (const i of installations as any[]) {
      const username = AgentIdentityService.buildAgentUsername(i.agentName, i.instanceId || 'default');
      if (username) usernameSet.add(username);
    }
    // `read` runs the Query once: three readers wait on it, and a Query runs
    // again for every then().
    const userRead: Promise<any[]> = usernameSet.size > 0
      ? read(() => User.find({ username: { $in: Array.from(usernameSet) } })
        .select([
          'username isBot profilePicture botMetadata',
          'agentRuntimeTokens.tokenHash agentRuntimeTokens.lastUsedAt agentRuntimeTokens.expiresAt',
        ].join(' '))
        .lean())
      : Promise.resolve([]);
    // A failed User read fails the request at the Promise.all below. The reads
    // that wait on it then see no rows, rather than each logging a lookup
    // failure that points away from the real one.
    const botRows: Promise<any[]> = userRead.catch(() => []);

    // Connection health is advisory, like activity. Read credentials in one
    // batch; a revoked row survives removal of the embedded bearer.
    const connectionRead = botRows.then(async (userRows: any[]) => {
      const credentialByAgent = new Map<string, any[]>();
      const credentialByMachine = new Map<string, any[]>();
      let machineById = new Map<string, any>();
      if (userRows.length > 0) {
        const agentIds = userRows.map((u: any) => u._id);
        const machineIds = Array.from(new Set(userRows
          .map((u: any) => u.botMetadata?.machineId).filter(Boolean)));
        const [credentials, machines] = await Promise.all([
          read(() => AgentCredential.find({ $or: [
            { kind: 'runtime', agentUserId: { $in: agentIds } },
            { kind: 'daemon', machineId: { $in: machineIds } },
          ] }).select('kind agentUserId machineId tokenHash status lastUsedAt expiresAt').lean()),
          read(() => Machine.find({ machineId: { $in: machineIds } }).select('machineId lastSeenAt').lean()),
        ]);
        for (const credential of credentials as any[]) {
          const key = credential.kind === 'daemon' ? String(credential.machineId) : String(credential.agentUserId);
          const target = credential.kind === 'daemon' ? credentialByMachine : credentialByAgent;
          target.set(key, [...(target.get(key) || []), credential]);
        }
        machineById = new Map((machines as any[]).map((machine: any) => [machine.machineId, machine]));
      }
      return {
        credentialByAgent, credentialByMachine, machineById, connectionAvailable: true,
      };
    }).catch((connectionErr: Error) => {
      console.warn('[pod-agents] connection lookup failed:', connectionErr.message);
      return {
        credentialByAgent: new Map<string, any[]>(),
        credentialByMachine: new Map<string, any[]>(),
        machineById: new Map<string, any>(),
        connectionAvailable: false,
      };
    });

    // Last thing each agent said in THIS pod (spec §1.1 line 2).
    // Advisory like the activity map: a PG hiccup must never fail the roster.
    const lastMessageRead = botRows.then(async (userRows: any[]) => {
      // eslint-disable-next-line global-require
      const PgMessage = require('../../models/pg/Message');
      const rows = await read(() => PgMessage.findLastMessagePerUserInPod(
        String(podId),
        userRows.map((u: any) => u._id),
      ));
      return new Map(
        (rows as Array<{ userId: string; content: string; createdAt: unknown }>)
          .map((r) => [r.userId, { content: r.content, createdAt: r.createdAt }]),
      );
    }).catch((snippetErr: Error) => {
      console.warn('[pod-agents] last-message lookup failed:', snippetErr.message);
      return new Map<string, { content: string; createdAt: unknown }>();
    });

    // The handle a person types to reach each agent here, from the map mention
    // routing reads (F44). Advisory: without it a row simply carries no handle.
    // Lazy, as podContextService loads it: the mention service pulls in the event
    // and message services.
    // eslint-disable-next-line global-require
    const mentions = require('../../services/agentMentionService');
    const mentionRead = read(() => mentions.loadPodMentionMap(podId) as Promise<Map<string, { agentName: string; instanceId?: string }>>)
      .catch((mentionErr: Error) => {
        console.warn('[pod-agents] mention map unavailable:', mentionErr.message);
        return new Map<string, { agentName: string; instanceId?: string }>();
      });

    // Day-zero step 2 (#1648): "Say something to it" closes
    // on the caller's own message in this pod, reply or not. A seat's install intro, a heartbeat
    // or a teammate's post is not the caller speaking, so no per-agent field can carry this.
    // Advisory like the snippet: a PG hiccup reads as "not yet", never as a failed roster.
    const callerSpokeRead = read(async () => {
      // eslint-disable-next-line global-require
      const PgMessage = require('../../models/pg/Message');
      return Boolean(await PgMessage.hasMessageByUserInPod(String(podId), String(userId)));
    }).catch((spokeErr: Error) => {
      console.warn('[pod-agents] caller-spoke lookup failed:', spokeErr.message);
      return false;
    });

    // A seat's runtime identity comes from its newest install in any pod
    // (TASK-569). Advisory: on a failed read each install shows its own.
    const seatIdentityRead = read(() => resolveSeatRuntimeIdentities(installations) as Promise<Map<string, Record<string, unknown>>>)
      .catch((identityErr: Error) => {
        console.warn('[pod-agents] runtime identity lookup failed:', identityErr.message);
        return new Map<string, Record<string, unknown>>();
      });

    // A push webhook's URL can carry a credential in its query string, so only
    // its installer and instance admins see it (hardening ruling,
    // 2026-10-21). The admin lookup runs only when the roster holds a URL the
    // viewer did not install.
    const viewerId = String(userId);
    const installedByViewer = (i: any) => String(i.installedBy || '') === viewerId;
    const needsAdminCheck = (installations as any[]).some((i: any) => (
      !installedByViewer(i) && Boolean(normalizeConfigMap(i.config)?.runtime?.webhookUrl)
    ));
    const adminRead: Promise<boolean> = needsAdminCheck ? read(() => isGlobalAdminUser(userId)) : Promise.resolve(false);

    const [
      narrowing, activityMap, heartbeatMap, registryEntries, templateCandidates, profiles, userRows,
      connection, lastMessageByUserId, mentionMap, callerSpoke, seatRuntimeIdentities, viewerIsAdmin,
    ] = await Promise.all([
      narrowingRead, activityRead, heartbeatRead, registryRead, templateRead, profileRead, userRead,
      connectionRead, lastMessageRead, mentionRead, callerSpokeRead, seatIdentityRead, adminRead,
    ]);
    const { counts: grantPodCounts, unavailable: runtimeNarrowingUnavailable } = narrowing;
    const {
      credentialByAgent, credentialByMachine, machineById, connectionAvailable,
    } = connection;

    const iconMap = new Map(registryEntries.map((entry: any) => [entry.agentName, entry.iconUrl || '']));
    const getTemplateIcon = (installation: any) => {
      const displayName = normalizeDisplayName(installation.displayName);
      if (!displayName) return '';
      const matches = templateCandidates.filter((template: any) => (
        template.agentName === installation.agentName
        && normalizeDisplayName(template.displayName) === displayName
        && template.iconUrl
      ));
      if (matches.length === 0) return '';
      const installedBy = installation.installedBy?.toString?.() || String(installation.installedBy || '');
      const exactOwner = matches.find((template: any) => String(template.createdBy || '') === installedBy);
      if (exactOwner) return exactOwner.iconUrl;
      const currentUserTemplate = matches.find((template: any) => String(template.createdBy || '') === String(userId));
      if (currentUserTemplate) return currentUserTemplate.iconUrl;
      const publicTemplate = matches.find((template: any) => template.visibility === 'public');
      return (publicTemplate || matches[0]).iconUrl || '';
    };
    const userByUsername = new Map<string, any>(
      (userRows as any[]).map((u: any) => [u.username, u]),
    );

    res.json({
      callerSpoke,
      agents: installations.map((i: any) => {
        const profile = profiles.find(
          (p: any) => p.agentName === i.agentName && p.instanceId === (i.instanceId || 'default'),
        );
        const templateIcon = getTemplateIcon(i);
        const instanceKey = `${i.agentName}:${i.instanceId || 'default'}`;
        const username = AgentIdentityService.buildAgentUsername(i.agentName, i.instanceId || 'default');
        const user = userByUsername.get(username) || null;
        const lastActiveAt = activityMap.get(instanceKey) || null;
        const basePayload = buildAgentInstallationPayload(i, {
          profile,
          iconUrl: templateIcon || iconMap.get(i.agentName) || '',
          lastHeartbeatAt: heartbeatMap.get(instanceKey) || null,
          lastActiveAt,
          user,
          lastMessage: (user && lastMessageByUserId.get(String(user._id))) || null,
          revealWebhookUrl: viewerIsAdmin || installedByViewer(i),
          runtimeIdentity: seatRuntimeIdentities.get(instanceKey) || null,
        });
        // Every return path below carries the narrowing state: a boolean per
        // seat, never the ids of the other pods its grants reach.
        const grantCount = grantPodCounts.get(instanceKey);
        const payload = basePayload && {
          ...basePayload,
          // Routing reads the install, so a missing bot row still has a handle.
          mention: mentions.mentionHandleForUser(mentionMap, user || {
            isBot: true, botMetadata: { agentName: i.agentName, instanceId: i.instanceId || 'default' },
          }),
          runtimeNarrowedByMultipleGrantPods: (grantCount?.grantPods ?? 0) >= 2,
          // A seat in one pod loses nothing; one granted pod out of several
          // means it can post only there.
          runtimeNarrowedToOnePod: grantCount?.grantPods === 1 && grantCount.pods >= 2,
          runtimeNarrowingUnavailable,
        };
        const runtimeType = payload?.runtime?.runtimeType;
        // A provisioned in-process seat needs no external connection. Its
        // runtime is available by construction, without a credential ledger.
        if (runtimeType === 'native' || hostedRunsNative(i)) {
          return { ...payload, connection: { state: 'available', lastSeenAt: null } };
        }
        // Legacy local-cli installs are normalized to their harness name
        // (codex/claude-code) in the public payload. Host, not that label,
        // identifies a BYO listener whose credential use proves liveness.
        // A seat bound to a daemon machine is a wrapper whatever its install
        // label says: manage-settings projects it as `wrapper` for the same
        // reason. Without this, a running daemon-managed seat carried no
        // connection and Settings rendered "Connection status unavailable".
        // The runtime type is projected as `wrapper` too: Settings keys its
        // machine-key action and Reconnect link on that field, not on connection.
        const machineId = user?.botMetadata?.machineId;
        const daemonBound = Boolean(machineId);
        // The harness label moves to `adapter`, so the chat tag keeps naming it.
        // The poller's report (TASK-704) outranks a stale runtimeType declaration:
        // a seat declared codex that polls claude must not project codex here.
        const seatPayload = daemonBound
          ? { ...payload, runtime: {
            ...payload?.runtime,
            runtimeType: 'wrapper',
            adapter: payload?.runtime?.adapter || payload?.runtime?.reportedCli || payload?.runtime?.runtimeType,
          } }
          : payload;
        const hasRuntimeConnection = payload?.runtime?.host === 'byo'
          || runtimeType === 'wrapper'
          || daemonBound
          || (runtimeType === 'webhook' && !payload?.runtime?.host);
        if (!connectionAvailable || !user || !hasRuntimeConnection
          || normalizeConfigMap(i.config)?.runtime?.webhookUrl) return seatPayload;
        const connection = deriveAgentConnection({
          runtimeType: daemonBound ? 'wrapper' : runtimeType,
          credentials: credentialByAgent.get(String(user._id)) || [],
          machineCredentials: credentialByMachine.get(String(machineId)) || [],
          embeddedTokens: [...(user.agentRuntimeTokens || []), ...(i.runtimeTokens || [])],
          machineLastSeenAt: machineById.get(String(machineId))?.lastSeenAt || null,
        });
        // TASK-716: the command that makes a never-connected seat run goes to
        // the installer only, the same rule /agent-states applies to fixCommand.
        // It is `commonly agent run <name>`; no token or URL is in it.
        // eslint-disable-next-line global-require
        const fixCommand = connection?.state === 'never' && installedByViewer(i)
          ? require('../../services/agentStateService').runInstructionFor(i) : null;
        return {
          ...seatPayload,
          connection,
          ...(fixCommand ? { fixCommand } : {}),
        };
      }),
    });
  } catch (error) {
    console.error('Error listing pod agents:', error);
    res.status(500).json({ error: 'Failed to list pod agents' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name?instanceId=
 * Return a single installed agent payload with latest persisted config/profile.
 */
podAgentsRouter.get('/pods/:podId/agents/:name', auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { installation } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: req.query.instanceId,
    });
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }
    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });
    if (!membership && !isCreator && !(await isGlobalAdminUser(userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!installation || installation.status === 'uninstalled') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const [registryEntry, profile, templateCandidates] = await Promise.all([
      AgentRegistry.findOne({ agentName: installation.agentName }).select('iconUrl').lean(),
      AgentProfile.findOne({
        podId,
        agentName: installation.agentName,
        instanceId: installation.instanceId || 'default',
      }).lean(),
      AgentTemplate.find({
        agentName: installation.agentName,
        displayName: installation.displayName,
        $or: [
          { visibility: 'public' },
          { createdBy: userId },
          { createdBy: installation.installedBy },
        ],
      }).select('iconUrl createdBy visibility').lean(),
    ]);
    const installedBy = installation.installedBy?.toString?.() || String(installation.installedBy || '');
    const templateIcon = (
      templateCandidates.find((template: any) => String(template.createdBy || '') === installedBy)
      || templateCandidates.find((template: any) => String(template.createdBy || '') === String(userId))
      || templateCandidates.find((template: any) => template.visibility === 'public')
      || templateCandidates[0]
    )?.iconUrl || '';

    let runtimeIdentity = null;
    try {
      const identities = await resolveSeatRuntimeIdentities([installation]);
      runtimeIdentity = identities.values().next().value || null;
    } catch (identityErr) {
      console.warn('[pod-agents] runtime identity lookup failed:', (identityErr as Error).message);
    }

    return res.json({
      agent: buildAgentInstallationPayload(installation, {
        profile,
        runtimeIdentity,
        iconUrl: templateIcon || registryEntry?.iconUrl || '',
        revealWebhookUrl: installedBy === String(userId)
          || (Boolean(normalizeConfigMap(installation.config)?.runtime?.webhookUrl)
            && await isGlobalAdminUser(userId)),
      }),
    });
  } catch (error) {
    console.error('Error loading installed pod agent:', error);
    return res.status(500).json({ error: 'Failed to load installed agent' });
  }
});

module.exports = podAgentsRouter;
module.exports.POD_AGENTS_READ_CONCURRENCY = POD_AGENTS_READ_CONCURRENCY;

export {};
