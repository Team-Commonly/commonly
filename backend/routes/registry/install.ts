// Agent install route — extracted from registry.js (GH#112)
// Handles: POST /install
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../../middleware/auth');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const Activity = require('../../models/Activity');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentIdentityService = require('../../services/agentIdentityService');
const AgentMessageService = require('../../services/agentMessageService');
const {
  getUserId,
  normalizeInstanceId,
  normalizeConfigMap,
  normalizeRuntimeAuthProfiles,
  normalizeSkillEnvEntries,
  sanitizeRuntimeConfig,
  resolveGatewayForRequest,
  buildAgentProfileId,
} = require('./helpers');
const {
  AUTO_GRANTED_INTEGRATION_SCOPES,
} = require('./tokens');

// Inlined per-route limiter so CodeQL's `js/missing-rate-limiting`
// query (which only sees express-rate-limit calls in the same file
// as the route registration) recognises the guard. Mirrors the
// phase4RateLimit pattern in agentsRuntime.ts. Skipped under
// NODE_ENV=test so the integration suite's beforeEach reinstall
// loops (30+ installs in <60s) don't get throttled.
const installRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  handler: (_req: any, res: any) => res.status(429).json({
    message: 'rate limit exceeded: 30 install requests per 60s',
    code: 'rate_limited',
  }),
});

const installRouter = express.Router();

/**
 * Derive instanceId from displayName for consistent agent identity across pods.
 * This ensures the same agent (e.g., "Cuz") gets the same instanceId regardless
 * of which pod it's installed in, allowing shared runtime tokens and memory.
 */
const deriveInstanceId = (displayName: any, agentName: any) => {
  if (!displayName) return 'default';
  const slug = String(displayName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug === agentName.toLowerCase()) {
    return 'default';
  }
  return slug;
};

/**
 * Check if an agent instance already exists globally (across all pods).
 * Returns the existing installations and agent user if found.
 */
const findExistingAgentInstance = async (agentName: any, instanceId: any) => {
  const installations = await AgentInstallation.find({
    agentName: agentName.toLowerCase(),
    instanceId,
    status: 'active',
  }).lean();

  if (installations.length === 0) {
    return { exists: false, installations: [], agentUser: null };
  }

  const username = AgentIdentityService.buildAgentUsername(agentName, instanceId);
  const agentUser = await User.findOne({
    username,
    isBot: true,
  }).lean();

  return { exists: true, installations, agentUser };
};

/**
 * POST /api/registry/install
 * Install an agent to a pod
 */
installRouter.post('/install', installRateLimit, auth, async (req: any, res: any) => {
  try {
    const {
      agentName, podId, version, config = {}, scopes = [], instanceId, displayName, gatewayId,
    } = req.body;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Validate + sanitize agentName at the entry point. The
    // strip-via-replace pattern (rather than .test()/.match()) is the
    // one CodeQL recognises as a SqlSanitizer for js/sql-injection on
    // the Mongoose filters below. Validation is still strict — if the
    // sanitized form doesn't round-trip the original (after lowercase),
    // it had invalid chars and we 400. Mirrors normalizeInstanceId in
    // helpers.ts which already uses this shape for the same reason.
    if (typeof agentName !== 'string') {
      return res.status(400).json({ error: 'agentName must be a string' });
    }
    const safeAgentName: string = String(agentName)
      .toLowerCase()
      .replace(/[^a-z0-9@/-]/g, '');
    if (!safeAgentName || safeAgentName !== agentName.toLowerCase()
        || !/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(safeAgentName)) {
      return res.status(400).json({ error: 'Invalid agentName: must match /^(@[a-z0-9-]+\\/)?[a-z0-9-]+$/' });
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

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'You must be a member of this pod' });
    }

    let agent = await AgentRegistry.getByName(agentName);

    if (agent && agent.status === 'unpublished') {
      return res.status(410).json({
        error: 'This manifest has been unpublished by its author.',
      });
    }

    // ADR-006 §Self-serve install: when a pod member installs a webhook-typed
    // agent that has no published manifest, synthesize an ephemeral registry
    // row owned by them. Marketplace catalog excludes ephemeral rows; only
    // direct getByName() resolves them. Membership check above is the gate.
    if (!agent) {
      const requestedRuntimeType = String(
        (config && config.runtime && (config.runtime as any).runtimeType) || '',
      ).toLowerCase();
      if (requestedRuntimeType !== 'webhook') {
        return res.status(404).json({ error: 'Agent not found in registry' });
      }
      // ADR-006 §invariant 7 — self-serve is pod-scope only. The route
      // already requires `podId` (pod 404 above guards this), but the
      // explicit check here keeps the invariant in source so a future
      // refactor that adds instance/user/dm scope can't bypass it.
      if (!podId) {
        return res.status(400).json({ error: 'podId is required for self-serve install' });
      }
      if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(String(agentName).toLowerCase())) {
        return res.status(400).json({
          error: 'Invalid agentName: must match /^(@[a-z0-9-]+\\/)?[a-z0-9-]+$/',
        });
      }
      // manifest.runtime.type is the registry-level deployment shape
      // (enum: 'standalone' | 'commonly-hosted' | 'hybrid'). Self-serve
      // webhook agents run outside Commonly so they map to 'standalone'.
      // The actual webhook routing is driven by config.runtime.runtimeType
      // on the AgentInstallation, not on the registry manifest.
      const synthManifest = {
        name: String(agentName).toLowerCase(),
        version: String(version || '1.0.0'),
        description: 'Self-serve agent installed via CAP (ADR-006).',
        capabilities: [],
        context: { required: [], optional: [] },
        runtime: { type: 'standalone', connection: 'rest' },
      };
      agent = await AgentRegistry.create({
        agentName: synthManifest.name,
        displayName: String(displayName || agentName),
        description: synthManifest.description,
        manifest: synthManifest,
        latestVersion: synthManifest.version,
        versions: [{ version: synthManifest.version, manifest: synthManifest, publishedAt: new Date() }],
        registry: 'private',
        publisher: { userId, name: req.user?.username },
        ephemeral: true,
      });
      console.log('[cap self-serve-install]', {
        user: String(userId),
        pod: String(podId),
        agent: synthManifest.name,
        runtime: 'webhook',
      });
    }

    let normalizedInstanceId;
    if (instanceId) {
      normalizedInstanceId = normalizeInstanceId(instanceId);
      if (normalizedInstanceId === agentName.toLowerCase()) {
        normalizedInstanceId = 'default';
      }
    } else {
      normalizedInstanceId = deriveInstanceId(displayName, agentName);
    }

    const existingInPod = await AgentInstallation.findOne({
      agentName: agentName.toLowerCase(),
      podId,
      instanceId: normalizedInstanceId,
      status: 'active',
    });

    if (existingInPod) {
      return res.status(400).json({ error: 'Agent already installed in this pod' });
    }

    const globalAgent = await findExistingAgentInstance(agentName, normalizedInstanceId);
    const isReusingExistingAgent = globalAgent.exists;

    const requiredScopes = agent.manifest.context?.required || [];
    const missingScopes = requiredScopes.filter((s: any) => !scopes.includes(s));
    if (missingScopes.length > 0) {
      return res.status(400).json({
        error: 'Missing required scopes',
        missingScopes,
      });
    }

    const installConfig = normalizeConfigMap(config) || {};
    const runtimeConfig = typeof installConfig.runtime === 'object' && installConfig.runtime
      ? { ...installConfig.runtime }
      : {};
    const normalizedAuthProfiles = normalizeRuntimeAuthProfiles(runtimeConfig.authProfiles);
    if (normalizedAuthProfiles) {
      runtimeConfig.authProfiles = normalizedAuthProfiles;
    }
    const normalizedSkillEnv = normalizeSkillEnvEntries(runtimeConfig.skillEnv);
    if (normalizedSkillEnv) {
      runtimeConfig.skillEnv = normalizedSkillEnv;
    }
    let resolvedGateway = null;
    if (gatewayId) {
      resolvedGateway = await resolveGatewayForRequest({ gatewayId, userId });
      runtimeConfig.gatewayId = resolvedGateway._id.toString();
    }
    if (Object.keys(runtimeConfig).length) {
      installConfig.runtime = runtimeConfig;
    }

    const grantedScopes = Array.from(new Set([
      ...requiredScopes,
      ...scopes,
      ...AUTO_GRANTED_INTEGRATION_SCOPES,
    ]));

    const installation = await AgentInstallation.install(agentName, podId, {
      version: version || agent.latestVersion,
      config: installConfig,
      scopes: grantedScopes,
      installedBy: userId,
      instanceId: normalizedInstanceId,
      displayName: displayName || agent.displayName,
    });

    // Use upsert by the natural key (podId + agentId) so reinstalling
    // over a stale row left behind by raw status='uninstalled' updates
    // doesn't duplicate-key-error out. Identity continuity (ADR-001
    // §3) wants the AgentInstallation reactivated; the AgentProfile
    // should be refreshed in place, not re-created.
    await AgentProfile.findOneAndUpdate(
      { podId, agentId: buildAgentProfileId(safeAgentName, normalizedInstanceId) },
      {
        // setDefaultsOnInsert fires on insert only, so stats /
        // integrations / modelPreferences keep their existing values
        // across re-installs — what we want for identity continuity.
        $set: {
          agentName: safeAgentName,
          instanceId: normalizedInstanceId,
          name: displayName || agent.displayName,
          purpose: agent.description,
          instructions: agent.manifest.configSchema?.defaultInstructions || '',
          persona: {
            tone: 'friendly',
            specialties: agent.manifest.capabilities?.map((c: any) => c.name) || [],
          },
          toolPolicy: {
            allowed: grantedScopes.filter((s: any) => s.includes(':')).map((s: any) => s.split(':')[0]),
          },
          // Force back to active — a previous admin action or partial
          // uninstall may have left the profile paused/archived.
          status: 'active',
        },
        $setOnInsert: {
          createdBy: userId,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    try {
      // Task #62: don't clobber a curated per-instance displayName with the
      // AgentRegistry's default. When installing a NEW pod for an EXISTING
      // agent identity (e.g. installing Aria into a new pod when she's
      // already Aria-named via prior install), `agent.displayName` is the
      // registry-wide fallback ("Cuz 🦞" for openclaw, "Codex" for codex).
      // Passing that into getOrCreateAgentUser overwrites the User row's
      // curated displayName ("Aria"). Caller intent: install in pod, NOT
      // rename. So: only pass `displayName` to identity service when the
      // caller explicitly set one in the request body (truthy displayName
      // from req.body); otherwise leave it undefined and let
      // getOrCreateAgentUser preserve the existing User row's displayName.
      const explicitDisplayName = typeof displayName === 'string' && displayName.trim()
        ? displayName.trim()
        : undefined;
      const agentUser = await AgentIdentityService.getOrCreateAgentUser(agent.agentName, {
        instanceId: normalizedInstanceId,
        ...(explicitDisplayName ? { displayName: explicitDisplayName } : {}),
      });
      await AgentIdentityService.ensureAgentInPod(agentUser, podId);
    } catch (identityError: unknown) {
      console.warn('Failed to provision agent user identity:', (identityError as Error).message);
    }

    await AgentRegistry.incrementInstalls(agentName);

    try {
      const user = await User.findById(userId).select('username').lean();
      await Activity.create({
        type: 'agent_action',
        actor: {
          id: userId,
          name: user?.username || 'Unknown',
          type: 'human',
          verified: false,
        },
        action: 'agent_action',
        content: `Installed agent "${agent.displayName}" to this pod`,
        podId,
        agentMetadata: {
          agentName: agent.agentName,
        },
      });
    } catch (activityError: unknown) {
      console.warn('Failed to create activity for agent install:', (activityError as Error).message);
    }

    // Post a short self-introduction so the room learns the new member
    // without having to wait for their first heartbeat. Team pods only —
    // skip DMs, agent-rooms, and single-member surfaces.
    try {
      const podDoc = await Pod.findById(podId).select('type members').lean();
      const introWorthy = podDoc
        && podDoc.type !== 'dm'
        && podDoc.type !== 'agent-room'
        && (podDoc.members?.length || 0) >= 2;
      if (introWorthy) {
        // Task #62 follow-up: the intro post passes `displayName` to
        // AgentMessageService.postMessage, which forwards it to
        // getOrCreateAgentUser. If we pass the AgentRegistry default
        // ("Cuz 🦞" / "Codex"), the User row's curated per-instance
        // displayName ("Aria") gets clobbered or sticky-dedup-suffixed
        // to "Cuz 🦞 (Aria)". Resolve the intro display label by
        // preferring the live agent identity (User.botMetadata.displayName)
        // first, so we never overwrite a curated label with a registry default.
        let displayName: string;
        try {
          const existingBot = await User.findOne({
            isBot: true,
            'botMetadata.agentName': agent.agentName,
            'botMetadata.instanceId': normalizedInstanceId,
          }).select('botMetadata').lean() as { botMetadata?: { displayName?: string } } | null;
          displayName = existingBot?.botMetadata?.displayName
            || installation.displayName
            || agent.displayName;
        } catch (lookupErr: unknown) {
          // Fall back to the legacy chain if the identity lookup blew up —
          // don't take down the intro flow on a transient mongo hiccup.
          console.warn('[install] intro displayName lookup failed:', (lookupErr as Error).message);
          displayName = installation.displayName || agent.displayName;
        }
        const blurb = (agent.description || '').trim().replace(/\s+/g, ' ');
        // Skip the blurb when it just repeats the name (the publish step in
        // older CLI versions seeded description from displayName, producing
        // intros like "Hi all — I'm bot. bot Ping me ..."). Compare
        // case-insensitively against both displayName and the bare agentName
        // since either could have been the source.
        const normalizedBlurb = blurb.toLowerCase();
        const isMeaninglessBlurb = !blurb
          || normalizedBlurb === displayName.toLowerCase()
          || normalizedBlurb === agent.agentName.toLowerCase();
        const intro = isMeaninglessBlurb
          ? `Hi all — I'm ${displayName}, just joined the pod.`
          : `Hi all — I'm ${displayName}. ${blurb} Ping me when you need it.`;
        await AgentMessageService.postMessage({
          agentName: agent.agentName,
          instanceId: normalizedInstanceId,
          displayName,
          podId,
          content: intro,
          metadata: { kind: 'install-intro' },
        });
      }
    } catch (introError: unknown) {
      console.warn('Failed to post install intro:', (introError as Error).message);
    }

    const otherPodIds = isReusingExistingAgent
      ? globalAgent.installations
        .filter((i: any) => i.podId.toString() !== podId)
        .map((i: any) => i.podId)
      : [];

    res.json({
      success: true,
      installation: {
        id: installation._id.toString(),
        agentName: installation.agentName,
        instanceId: installation.instanceId || normalizedInstanceId,
        displayName: installation.displayName,
        version: installation.version,
        status: installation.status,
        scopes: installation.scopes,
        runtime: sanitizeRuntimeConfig(installConfig.runtime) || null,
      },
      sharedIdentity: isReusingExistingAgent,
      otherPods: otherPodIds,
      hasExistingRuntimeToken: globalAgent.agentUser?.agentRuntimeTokens?.length > 0,
    });
  } catch (error) {
    console.error('Error installing agent:', error);
    res.status(500).json({ error: (error as any).message || 'Failed to install agent' });
  }
});

module.exports = installRouter;

export {};
