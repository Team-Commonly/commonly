// Agent install route — extracted from registry.js (GH#112)
// Handles: POST /install
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../../middleware/auth');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const AgentTemplate = require('../../models/AgentTemplate');
const Activity = require('../../models/Activity');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentIdentityService = require('../../services/agentIdentityService');
const AgentMessageService = require('../../services/agentMessageService');
const { deriveAgentState } = require('../../services/agentStateService');
const FirstContactService = require('../../services/firstContactService');
const HostedRuntime = require('../../services/hostedRuntimeService');
const { normalizeAvatarUrl } = require('../../services/avatarService');
const {
  getUserId,
  resolveUsername,
  normalizeInstanceId,
  normalizeConfigMap,
  normalizeRuntimeAuthProfiles,
  normalizeSkillEnvEntries,
  sanitizeRuntimeConfig,
  resolveGatewayForRequest,
  buildAgentProfileId,
  composeInstallIntro,
} = require('./helpers');
const {
  AUTO_GRANTED_INTEGRATION_SCOPES,
} = require('./tokens');

// Inlined per-route limiter. This comment used to attribute its clean CodeQL
// status to `js/missing-rate-limiting` "only seeing express-rate-limit calls
// in the same file as the route registration" — copied from agentsRuntime.ts,
// where the routes following that recipe are in fact flagged.
//
// The route below is clean for a different reason: `installRateLimit` is
// applied BEFORE `auth`, so the Mongo lookup auth performs is itself covered.
// Order is the discriminator (~37 routes with the limiter first: none
// flagged; 9 with it after auth: 6 flagged). Keep it first — moving it after
// `auth` would flag this route and, more to the point, would leave that
// lookup unlimited. Skipped under
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

    // Fetched once and reused for the #609 owner-scoping decision below and
    // the cloud-entitlement gate further down.
    const installerUser = await User.findById(userId).select('role entitlements isBot').lean();
    const isAdminInstaller = installerUser?.role === 'admin';

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

    // The 07-24 launch incident, closed at the SERVER this time: new users
    // auto-join Commonly HQ (publicRead) and it sorts first by activity, so
    // every client whose picker defaults badly lands strangers' agents in the
    // community pod. The web picker was fixed then; the CLI self-serve path
    // was not (tablebench-agent → HQ, 2026-08-21 — a member, so the gate
    // above passed). Rule: installing into a publicRead pod is for pod
    // creators and instance admins, never for ordinary members.
    if (pod.publicRead === true && !isAdminInstaller && !isCreator) {
      return res.status(403).json({
        code: 'public_pod_requires_admin',
        error: 'This is a community pod — agents install here only by a pod admin. Pick one of your own pods instead.',
      });
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
      // Self-serve identities: BYO webhook (ADR-006) and Commonly-hosted
      // (ADR-023). Both synthesize an ephemeral row; the hosted one is metered
      // by the cap gate below rather than by entitlement.
      if (requestedRuntimeType !== 'webhook' && requestedRuntimeType !== HostedRuntime.HOSTED_RUNTIME_TYPE) {
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
        description: 'A connected agent.',
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
        publisher: { userId, name: await resolveUsername(req) },
        ephemeral: true,
      });
      console.log('[cap self-serve-install]', {
        user: String(userId),
        pod: String(podId),
        agent: synthManifest.name,
        runtime: requestedRuntimeType,
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

    // #609 — cross-owner identity guard for SELF-SERVE BYO agents. Agent
    // identity + memory key on (agentName, instanceId) with no owner dimension,
    // so if two DIFFERENT users self-serve-install a custom agent under the
    // same (agentName, instanceId) the second would reuse the first's bot User
    // row + memory (a private-memory leak — reproduced live). Scope precisely:
    //   - `agent.ephemeral` → only the self-serve BYO path (the live attack).
    //     Published / marketplace agents are intentionally multi-installer and
    //     must NOT be blocked (each installer needs their own instance — the
    //     proper per-owner identity is a tracked follow-up, #609).
    //   - first-party AGENT_TYPES agents are shared by design and exempt.
    // Refuse to bind a name any OTHER user owns (any install status — an
    // uninstalled agent keeps its bot User + memory under identity continuity,
    // so reuse would still leak). The owner can always reinstall their own.
    const isFirstPartyShared = !!AgentIdentityService.getAgentTypeConfig(safeAgentName);
    if (!isFirstPartyShared && agent?.ephemeral) {
      // Bare findOne (no .select/.lean chain) to mirror the existingInPod
      // check above and stay compatible with route unit-test mocks.
      const foreignInstall = await AgentInstallation.findOne({
        agentName: safeAgentName,
        instanceId: normalizedInstanceId,
        installedBy: { $ne: userId },
      });
      if (foreignInstall) {
        return res.status(409).json({
          code: 'agent_name_taken',
          error: `The agent name "${safeAgentName}" is already in use by another user — please choose a different name.`,
        });
      }
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
    // Fall back to the registry manifest's declared runtimeType when the caller
    // didn't pick one. Without this, native first-party apps installed via the
    // v2 UI land with runtimeType=null → events route to the external queue
    // (which has no listener for native apps) → agent never replies. Only copy
    // the dedicated runtime identity field: `manifest.runtime.type` is
    // deployment-shape metadata (`standalone` / `commonly-hosted` / `hybrid`),
    // not the install row's canonical driver identity.
    if (!runtimeConfig.runtimeType) {
      const manifestRuntimeType = String(
        (agent.manifest as any)?.runtime?.runtimeType || '',
      ).trim().toLowerCase();
      if (
        manifestRuntimeType
        && !['standalone', 'commonly-hosted', 'hybrid'].includes(manifestRuntimeType)
      ) {
        runtimeConfig.runtimeType = manifestRuntimeType;
      }
    }
    // Stamp `host: 'byo'` on self-serve polling seats.
    //
    // Every self-serve BYO seat is currently born MISLABELLED, and it is one
    // mismatch: the connect page posts `runtimeType: 'webhook'` (ADR-006's
    // self-serve branch requires that value to synthesize a manifest) while the
    // user never runs a webhook — they run `commonly agent run`, which POLLS.
    // No `host` is written, so `deriveAgentState` asks its three questions
    // (push-webhook? native? byo?), gets no to all three, and returns
    // 'unknown'.
    //
    // Measured cost: 202 of 314 active installs derive 'unknown', and every
    // real BYO user seat is in that 202 — including all four users who
    // mentioned a dead seat and got silence (pod-architect, fleet review
    // 2026-08-14). The honesty surface, the install intro (#943) and W4's
    // stalled-connect trigger all read that derivation, so all three are inert
    // for exactly the population they exist to protect.
    //
    // Discriminator: a PUSH webhook must supply `webhookUrl` — no registry
    // route ever writes that field, it only ever arrives in caller config — so
    // webhook-typed WITHOUT a URL is a polling seat. Never overwrite an
    // explicit host; the CLI attach path already sets it correctly.
    // Store runtimeType NORMALIZED. Every gate below lowercases its own copy;
    // the stored value was whatever the caller sent, so `runtimeType: "Hosted"`
    // passed the hosted gate, got metered as hosted, and was never counted by
    // countHostedAgentsForUser (exact 'hosted') — the per-user cap failed open
    // (Otto on #1355). Query the field the code writes: write it normalized.
    if (runtimeConfig.runtimeType !== undefined && runtimeConfig.runtimeType !== null) {
      runtimeConfig.runtimeType = String(runtimeConfig.runtimeType).trim().toLowerCase();
    }
    if (!runtimeConfig.host
      && runtimeConfig.runtimeType === 'webhook'
      && !runtimeConfig.webhookUrl) {
      runtimeConfig.host = 'byo';
    }
    if (Object.keys(runtimeConfig).length) {
      installConfig.runtime = runtimeConfig;
    }

    // Hosted-agent entitlement gate (open-registration prerequisite). A cloud
    // (Commonly-hosted) runtime requires the installer to be an admin OR to
    // carry the `cloudAgents` entitlement. BYO / self-serve installs (webhook,
    // claude-code, or host:'byo') are intentionally NOT gated — connecting your
    // own local agent stays open to all authenticated users. Resolve the
    // effective runtimeType from the same place we just stored it
    // (config.runtime), falling back to the agent's AGENT_TYPES runtime so a
    // built-in cloud agent (openclaw→moltbot, commonly-bot→internal) is caught
    // even when the caller omits an explicit runtimeType.
    const effectiveRuntimeType = String(runtimeConfig.runtimeType || '').trim().toLowerCase()
      || String(AgentIdentityService.getAgentTypeConfig(safeAgentName)?.runtime || '').trim().toLowerCase();
    if (AgentIdentityService.isCloudRuntime({
      runtimeType: effectiveRuntimeType,
      host: runtimeConfig.host,
    })) {
      const isEntitled = installerUser?.entitlements?.cloudAgents === true;
      if (!isAdminInstaller && !isEntitled) {
        return res.status(403).json({
          code: 'cloud_agents_not_entitled',
          message: 'Hosted (cloud) agents require entitlement; you can connect your own local/BYO agent instead.',
        });
      }
    }

    // Hosted runtime (ADR-023 D3.1): open to every authenticated user, metered
    // instead of entitlement-gated. isCloudRuntime() deliberately does not
    // classify 'hosted' as cloud — the gate above is for operator-run tiers
    // (moltbot/codex/...), this one is the per-user beta cap. Admins bypass
    // the cap the same way they bypass the entitlement.
    if (effectiveRuntimeType === HostedRuntime.HOSTED_RUNTIME_TYPE && !isAdminInstaller) {
      const { agentsPerUser } = HostedRuntime.hostedCaps();
      const used = await HostedRuntime.countHostedAgentsForUser(userId);
      if (used >= agentsPerUser) {
        return res.status(403).json({
          code: 'hosted_cap_reached',
          message: `Hosted agents are capped at ${agentsPerUser} per user in beta; connect your own agent for more.`,
          used,
          cap: agentsPerUser,
        });
      }
    }

    const grantedScopes = Array.from(new Set([
      ...requiredScopes,
      ...scopes,
      ...AUTO_GRANTED_INTEGRATION_SCOPES,
    ]));

    // Task #62 (round 2): prefer the curated User.botMetadata.displayName
    // for the SAME agentName + instanceId over the registry-default
    // (`agent.displayName` e.g. "Cuz 🦞" / "Codex"). PR #408 fixed this
    // seam on the intro-post path; this is the install-path equivalent.
    // Without this, installing an existing agent identity (e.g. openclaw:nova)
    // into a NEW pod writes "Cuz 🦞" to both AgentInstallation.displayName
    // AND AgentProfile.name — and the V2 member list reads AgentProfile FIRST,
    // so users see "Cuz" on every member row even though the underlying
    // identity has the right name. Order: explicit caller intent > existing
    // identity > registry default. Resolve the existing identity through the
    // same leak guard every display surface uses: historical rows may contain
    // a runtime-shaped displayName such as "openclaw (nova)", which must not
    // become a higher-precedence installation or profile label.
    let effectiveDisplayName: string = displayName || '';
    if (!effectiveDisplayName) {
      try {
        const existingAgentUser = await User.findOne({
          'botMetadata.agentName': agent.agentName,
          'botMetadata.instanceId': normalizedInstanceId,
          isBot: true,
        }).select('username botMetadata.displayName botMetadata.agentName botMetadata.instanceId').lean();
        if (existingAgentUser?.botMetadata?.displayName) {
          effectiveDisplayName = AgentIdentityService.resolveAgentDisplayLabel(existingAgentUser, '');
        }
      } catch (lookupErr) {
        // Non-fatal — fall through to registry default below.
        // Log with agent identity so an operator chasing "wrong
        // displayName on reinstall" can correlate the install attempt
        // to the agent it failed for, instead of just seeing a bare
        // Mongoose error.
        // Structured args (object) instead of template-literal in the
        // format string — CodeQL's js/format-string-injection flags
        // user-tainted values in the format-string slot. Same diagnostic
        // payload, just shaped to keep the analyzer happy.
        console.warn('[install] displayName lookup failed', {
          agent: agent.agentName,
          instance: normalizedInstanceId,
          error: (lookupErr as Error).message,
        });
      }
    }
    if (!effectiveDisplayName) {
      effectiveDisplayName = agent.displayName;
    }

    const installation = await AgentInstallation.install(agentName, podId, {
      version: version || agent.latestVersion,
      config: installConfig,
      scopes: grantedScopes,
      installedBy: userId,
      instanceId: normalizedInstanceId,
      displayName: effectiveDisplayName,
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
          name: effectiveDisplayName,
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
      let avatarSeed = normalizeAvatarUrl(agent.iconUrl);
      if (explicitDisplayName) {
        // Query by the sanitized package key, then compare the user-provided
        // display label in memory. Besides avoiding a tainted Mongo filter,
        // this lets the installer's private template win over a public one.
        const templateCandidates = await AgentTemplate.find({
          agentName: safeAgentName,
          $or: [
            { createdBy: userId },
            { visibility: 'public' },
          ],
        }).select('displayName iconUrl createdBy visibility').lean();
        const matchingTemplates = templateCandidates.filter((template: any) => (
          String(template.displayName || '').trim().toLowerCase()
          === explicitDisplayName.toLowerCase()
        ));
        const template = matchingTemplates.find(
          (candidate: any) => String(candidate.createdBy || '') === String(userId),
        ) || matchingTemplates.find((candidate: any) => candidate.visibility === 'public');
        avatarSeed = normalizeAvatarUrl(template?.iconUrl) || avatarSeed;
      }
      const agentUser = await AgentIdentityService.getOrCreateAgentUser(agent.agentName, {
        instanceId: normalizedInstanceId,
        ...(explicitDisplayName ? { displayName: explicitDisplayName } : {}),
        ...(avatarSeed ? { profilePicture: avatarSeed } : {}),
      });
      await AgentIdentityService.ensureAgentInPod(agentUser, podId);
    } catch (identityError: unknown) {
      console.warn('Failed to provision agent user identity:', (identityError as Error).message);
    }

    // First contact belongs to the durable human↔agent relationship, not the
    // replaceable installation row. Best-effort by design: neither a marker
    // write nor event enqueue failure may turn a successful install into 500.
    void FirstContactService.maybeFireFirstContact({
      agentName: agent.agentName,
      instanceId: normalizedInstanceId,
      podId,
      installedByUserId: userId,
      installerIsAgent: installerUser?.isBot === true,
    }).catch((firstContactError: unknown) => {
      console.warn('[first-contact] trigger failed after install', {
        agent: agent.agentName,
        instance: normalizedInstanceId,
        pod: String(podId),
        error: (firstContactError as Error).message,
      });
    });

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
          // Log with agent identity for operator correlation.
          // Same CodeQL-safe shape as the install-path log above.
          console.warn('[install] intro displayName lookup failed', {
            agent: agent.agentName,
            instance: normalizedInstanceId,
            error: (lookupErr as Error).message,
          });
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
        // The mention handle is the instanceId (what the UI dropdown inserts),
        // NOT the registry agentName — a BYO user is told their agent's *name*
        // is e.g. "sam-agent" but the way to mention it is "@scout". Say it in
        // the intro so nobody has to guess (GH smoke finding 2026-07-05).
        const handle = normalizedInstanceId && normalizedInstanceId !== 'default'
          ? normalizedInstanceId
          : safeAgentName;
        // Honesty gate (2026-08-14). This intro used to promise "Mention me
        // with @handle when you need me" UNCONDITIONALLY — posted server-side
        // the moment the seat is created, which for a BYO seat is before any
        // wrapper process exists to answer.
        //
        // Measured cost, from production message history: four users mentioned
        // a seat with nobody home and got total silence — m0re (08-04),
        // l3r0ys4n3 (08-07), user-8863 (08-09, who asked three times in two
        // phrasings whether the connection was working), ngoc-tran (08-10).
        // None returned. The promise is made in the AGENT'S OWN VOICE, which
        // is the most authoritative surface we have, so it has to be
        // conditional on the same derivation the #891 honesty surface and the
        // pod roster already use — not a second, divergent guess.
        //
        // Reused-agent installs are why this derives rather than assumes: an
        // already-running agent installed into a new pod IS listening, and
        // telling that room otherwise would be the opposite lie.
        // The state enum is passed through WHOLE. Flattening it to a boolean
        // collapsed `never-connected` (structurally certain) into `gone-dark`
        // (inferred from staleness), which made a gone-dark agent announce
        // "Nothing is running me yet" — flat-certain and factually wrong,
        // since it demonstrably ran. Asserting an inference in the agent's own
        // voice is the same defect in a new costume (ux-lead, 2026-08-14).
        //
        // The token store is the BOT's, not the installer's (sprint-impl,
        // fleet review 2026-08-14). `deriveAgentState` unions
        // `installation.runtimeTokens` with a USER's `agentRuntimeTokens`, and
        // the user it means is the agent's bot row — that is where a polling
        // wrapper stamps `lastUsedAt`. An earlier draft passed the human
        // installer's tokens, a store a wrapper never writes, so a reused and
        // demonstrably live seat computed as never-connected and would have
        // been announced as dead. Same identity match the pod roster uses
        // (routes/pods.ts:437).
        let state = 'unknown';
        let fixCommand = `commonly agent run ${safeAgentName}`;
        try {
          const botRow = await User.findOne({
            isBot: true,
            'botMetadata.agentName': agent.agentName,
            'botMetadata.instanceId': normalizedInstanceId,
          }).select('agentRuntimeTokens.lastUsedAt').lean() as
              { agentRuntimeTokens?: { lastUsedAt?: Date | string | null }[] } | null;
          // `config` is `{ type: Map, of: Mixed }` (AgentRegistry.ts:235), so
          // on a LIVE Mongoose document `installation.config.runtime` is
          // undefined — a Map needs `.get()`. `deriveAgentState` reads
          // `config?.runtime` directly, so passing the live doc made it see an
          // empty runtime, answer `unknown`, and pick the invitation copy.
          //
          // Verified live: after the host:'byo' stamp shipped, a seat minted by
          // the real connect flow derived `never-connected` through
          // /agent-states (which uses `.lean()`, and lean converts Maps to
          // plain objects) while this call site still produced "Mention me with
          // @handle when you need me". Two readers of one field disagreeing
          // because one of them held a Mongoose document.
          //
          // Unit tests could not catch it: they pass plain objects, which is
          // the shape lean gives and the shape this line did NOT have.
          // Built field-by-field on purpose: spreading a Mongoose document
          // copies internals rather than the fields (they live under `_doc`),
          // which would fail the same silent way.
          const derived = deriveAgentState(
            {
              agentName: installation.agentName,
              instanceId: installation.instanceId,
              displayName: installation.displayName,
              installedBy: installation.installedBy,
              runtimeTokens: installation.runtimeTokens,
              config: normalizeConfigMap(installation.config) || {},
            },
            botRow?.agentRuntimeTokens || [],
            String(userId),
          );
          state = derived.state;
          if (derived.fixCommand) fixCommand = derived.fixCommand;
        } catch (stateErr: unknown) {
          // Fail toward the invitation: wrongly telling a LIVE agent's room
          // that nothing is listening is a worse lie than the one being fixed.
          // 'unknown' is exactly that branch, and it is an honest label here.
          console.warn('[install] intro liveness derivation failed', {
            agent: agent.agentName,
            instance: normalizedInstanceId,
            error: (stateErr as Error).message,
          });
        }
        const intro = composeInstallIntro({
          displayName,
          blurb: isMeaninglessBlurb ? '' : blurb,
          handle,
          state,
          fixCommand,
        });
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
