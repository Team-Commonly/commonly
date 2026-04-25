export {};

// ADR-003 Phase 4: ESM import for express-rate-limit (the rest of this file
// uses CJS require()). CodeQL's js/missing-rate-limiting query recognises the
// ESM import shape but has trouble tracing rate-limit middleware through
// require() returns; using `import` here makes the recognition unambiguous.
import rateLimit from 'express-rate-limit';

const express = require('express');

const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const auth = require('../middleware/auth');
const AgentEventService = require('../services/agentEventService');
const AgentIdentityService = require('../services/agentIdentityService');
const AgentMessageService = require('../services/agentMessageService');
const AgentThreadService = require('../services/agentThreadService');
const PodContextService = require('../services/podContextService');
const GlobalModelConfigService = require('../services/globalModelConfigService');
const SocialPolicyService = require('../services/socialPolicyService');
const registry = require('../integrations');
const Activity = require('../models/Activity');
const User = require('../models/User');
const Post = require('../models/Post');
const Pod = require('../models/Pod');
const { AgentInstallation } = require('../models/AgentRegistry');
const { requireApiTokenScopes } = require('../middleware/apiTokenScopes');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { agentRateLimitKeyGenerator } = require('../middleware/agentRateLimit');

// ADR-003 Phase 4: per-token rate limiter for the cross-agent surface.
// Token-global (covers any pod the token is valid for). Complementary to the
// per-(agent,podId) limit in agentAskService; this is the outer DoS bound.
// 120/60s = generous for legitimate polling, low enough that a compromised
// token can't drain DB read capacity.
//
// Inlined here (not behind a factory) so CodeQL's `js/missing-rate-limiting`
// query — which only recognises direct express-rate-limit invocations in the
// same file as the route registration — sees the middleware on each route.
const phase4RateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: agentRateLimitKeyGenerator,
  handler: (_req: any, res: any) => res.status(429).json({
    message: 'rate limit exceeded: 120 requests per 60s',
    code: 'rate_limited',
  }),
});

const Integration = require('../models/Integration');
const AgentMemory = require('../models/AgentMemory');
const {
  mirrorContentFromSections,
  stampSectionsForWrite,
  mergePatchSections,
  computeSyncDedupKey,
  isValidYMD,
  filterSectionsByVisibility,
} = require('../services/agentMemoryService');
const AgentAskService = require('../services/agentAskService');
const DMService = require('../services/dmService');
const ChatSummarizerService = require('../services/chatSummarizerService');
const AgentMentionService = require('../services/agentMentionService');

let PGPod;
try {
  // eslint-disable-next-line global-require
  PGPod = require('../models/pg/Pod');
} catch (_: any) {
  PGPod = null;
}

const router = express.Router();
const parseNonNegativeInt = (value: any, fallback: any) => {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(0, parsed);
};

const parsePositiveInt = (value: any, fallback: any) => {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, parsed);
};

const INTEGRATION_PUBLISH_COOLDOWN_SECONDS = parseNonNegativeInt(
  process.env.AGENT_INTEGRATION_PUBLISH_COOLDOWN_SECONDS,
  1800,
);
const INTEGRATION_PUBLISH_DAILY_LIMIT = parsePositiveInt(
  process.env.AGENT_INTEGRATION_PUBLISH_DAILY_LIMIT,
  24,
);

const ensurePodMatch = (installationOrList: any, podId: any, authorizedPodIds = []) => {
  const normalizedPodId = podId?.toString?.() || String(podId || '');
  if (Array.isArray(authorizedPodIds) && authorizedPodIds.length > 0) {
    return authorizedPodIds.some((id) => String(id) === normalizedPodId);
  }
  if (Array.isArray(installationOrList)) {
    return installationOrList.some((installation) => (
      installation?.podId?.toString() === normalizedPodId
    ));
  }
  return installationOrList?.podId?.toString() === normalizedPodId;
};

const resolveInstallationForPod = (installations: any[] = [], fallback: any, podId: any) => {
  if (!Array.isArray(installations)) return fallback;
  return installations.find((installation) => (
    installation?.podId?.toString() === podId.toString()
  )) || fallback;
};

const hasAnyScope = (installation: any, acceptedScopes: any[] = []) => {
  const scopes = Array.isArray(installation?.scopes) ? installation.scopes : [];
  // Backward compatibility: installations created before scope persistence
  // should behave as unscoped/full-access for runtime integration routes.
  if (scopes.length === 0) return true;
  return acceptedScopes.some((scope) => scopes.includes(scope));
};

const mapBufferedIntegrationMessages = (integration: any, {
  limit = 100,
  before,
  after,
}: any = {}) => {
  const buffer = Array.isArray(integration?.config?.messageBuffer)
    ? integration.config.messageBuffer
    : [];
  let messages = buffer
    .map((entry: any) => ({
      id: entry?.messageId ? String(entry.messageId) : null,
      content: String(entry?.content || ''),
      author: String(entry?.authorName || ''),
      authorId: entry?.authorId ? String(entry.authorId) : null,
      timestamp: entry?.timestamp || null,
      metadata: entry?.metadata || {},
    }))
    .filter((entry: any) => entry.id && entry.timestamp);

  if (before) {
    const beforeDate = new Date(before);
    if (!Number.isNaN(beforeDate.valueOf())) {
      messages = messages.filter((entry: any) => new Date(entry.timestamp) < beforeDate);
    }
  }
  if (after) {
    const afterDate = new Date(after);
    if (!Number.isNaN(afterDate.valueOf())) {
      messages = messages.filter((entry: any) => new Date(entry.timestamp) > afterDate);
    }
  }

  messages.sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return messages.slice(0, limit);
};

const requireBotUser = async (req: any, res: any) => {
  const userId = req.userId || req.user?.id;
  const user = await User.findById(userId).lean();
  if (!user || !user.isBot) {
    return { error: res.status(403).json({ message: 'This endpoint is for bot users only' }) };
  }
  return { user };
};

const ensureBotInstallation = async (
  agentName: any,
  podId: any,
  statuses = ['active'],
  instanceId = 'default',
) => {
  const installation = await AgentInstallation.findOne({
    agentName: agentName.toLowerCase(),
    podId,
    instanceId,
    status: { $in: statuses },
  }).lean();
  return installation;
};

const ensureBotPodAccess = async (
  user: any,
  agentName: any,
  podId: any,
  statuses = ['active'],
  instanceId = 'default',
) => {
  const installation = await ensureBotInstallation(agentName, podId, statuses, instanceId);
  if (installation) return installation;

  const dmPod = await Pod.findOne({
    _id: podId,
    type: 'agent-admin',
    members: user?._id,
  }).select('_id').lean();
  if (!dmPod) return null;

  const fallbackInstallation = await AgentInstallation.findOne({
    agentName: agentName.toLowerCase(),
    instanceId,
    status: { $in: statuses },
  }).sort({ updatedAt: -1 }).lean();

  if (fallbackInstallation) return fallbackInstallation;
  return {
    agentName: agentName.toLowerCase(),
    instanceId,
    displayName: user?.botMetadata?.displayName || user?.name || agentName,
    config: {},
  };
};

/**
 * GET /installations (agent runtime token auth)
 * Returns all active pod installations for the authenticated agent, including
 * pod name and type so the runtime can self-discover where it is installed.
 */
router.get('/installations', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const installations = req.agentInstallations || [];
    const agentInstallation = req.agentInstallation;

    const agentName = agentInstallation?.agentName
      || req.agentUser?.botMetadata?.agentName
      || req.agentUser?.botMetadata?.agentType
      || req.agentUser?.username;
    const instanceId = agentInstallation?.instanceId
      || req.agentUser?.botMetadata?.instanceId
      || 'default';

    const podIds = installations
      .map((inst: any) => inst?.podId)
      .filter(Boolean);

    // Also include DM pods the agent is a member of
    const dmPodIds = (req.agentAuthorizedPodIds || []).filter(
      (id: any) => !podIds.map(String).includes(String(id)),
    );

    const allPodIds = [...podIds.map(String), ...dmPodIds.map(String)];

    const pods = allPodIds.length > 0
      ? await Pod.find({ _id: { $in: allPodIds } }).select('_id name type').lean()
      : [];

    const podMap = Object.fromEntries(pods.map((p: any) => [String(p._id), p]));

    const installationList = installations.map((inst: any) => {
      const pod = podMap[String(inst?.podId)] || {};
      return {
        podId: String(inst?.podId || ''),
        podName: pod.name || null,
        podType: pod.type || null,
        instanceId: inst?.instanceId || instanceId,
        status: inst?.status || 'active',
        type: 'installation',
      };
    });

    const dmList = dmPodIds.map((id: any) => {
      const pod = podMap[String(id)] || {};
      return {
        podId: String(id),
        podName: pod.name || null,
        podType: pod.type || 'agent-admin',
        instanceId,
        status: 'active',
        type: 'dm',
      };
    });

    return res.json({
      agentName,
      instanceId,
      installations: [...installationList, ...dmList],
    });
  } catch (error: any) {
    console.error('Error fetching agent installations:', (error as Error).message || error);
    return res.status(500).json({ message: 'Failed to fetch installations' });
  }
});

/**
 * GET /events (agent runtime token auth)
 * Original endpoint for agent runtime tokens (cm_agent_*)
 */
router.get('/events', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const installation = req.agentInstallation;
    const agentUser = req.agentUser;
    const agentName = installation?.agentName
      || agentUser?.botMetadata?.agentName
      || agentUser?.botMetadata?.agentType
      || agentUser?.username;
    const instanceId = installation?.instanceId
      || agentUser?.botMetadata?.instanceId
      || 'default';
    if (!agentName) {
      return res.status(403).json({ message: 'Agent token not authorized for events' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const installationPodIds = (req.agentInstallations || [])
      .map((item: any) => item?.podId)
      .filter(Boolean);
    const dmPods = await Pod.find({
      type: 'agent-admin',
      members: agentUser?._id,
    }).select('_id').lean();
    const dmPodIds = dmPods.map((pod: any) => pod._id);
    const podIds = Array.from(
      new Set(
        [...installationPodIds, ...dmPodIds]
          .filter(Boolean)
          .map((id) => id.toString()),
      ),
    );
    const fallbackPodId = podIds.length === 0 && installation?.podId
      ? installation.podId
      : undefined;

    const events = await AgentEventService.list({
      agentName,
      instanceId,
      podId: fallbackPodId,
      podIds,
      limit,
    });

    return res.json({ events });
  } catch (error: any) {
    console.error('Error listing agent events:', error);
    return res.status(500).json({ message: 'Failed to list agent events' });
  }
});

/**
 * GET /bot/events (user API token auth)
 * For bot users to poll events using their user API token
 * Bot user must have isBot: true and username matching agentName
 */
router.get('/bot/events', auth, requireApiTokenScopes(['agent:events:read']), async (req: any, res: any) => {
  try {
    const { user, error } = await requireBotUser(req, res);
    if (error) return error;

    const agentName = req.query.agentName || user.botMetadata?.agentName || null;
    const instanceId = req.query.instanceId || user.botMetadata?.instanceId || 'default';
    const resolvedAgentName = agentName || user.username;
    const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
    if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
      return res.status(403).json({ message: 'Agent token does not match bot user' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

    // Find all pods where this agent is installed
    const installations = await AgentInstallation.find({
      agentName: resolvedAgentName.toLowerCase(),
      instanceId,
      status: 'active',
    }).lean();

    const installationPodIds = installations.map((i: any) => i.podId);
    const dmPods = await Pod.find({
      type: 'agent-admin',
      members: user._id,
    }).select('_id').lean();
    const dmPodIds = dmPods.map((pod: any) => pod._id);
    const podIds = Array.from(
      new Set(
        [...installationPodIds, ...dmPodIds]
          .filter(Boolean)
          .map((id) => id.toString()),
      ),
    );

    // List events across all installed pods
    const events = await AgentEventService.list({
      agentName: resolvedAgentName,
      instanceId,
      podIds,
      limit,
    });

    return res.json({ events });
  } catch (error: any) {
    console.error('Error listing bot events:', error);
    return res.status(500).json({ message: 'Failed to list bot events' });
  }
});

router.post('/dm', auth, async (req: any, res: any) => {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const {
      agentName: rawAgentName,
      instanceId: rawInstanceId,
      podId: requestedPodId,
    } = req.body || {};

    const agentName = String(rawAgentName || '').trim().toLowerCase();
    const instanceId = String(rawInstanceId || '').trim() || null;
    const normalizedInstanceId = instanceId ? String(instanceId).toLowerCase() : null;
    if (!agentName) {
      return res.status(400).json({ message: 'agentName is required' });
    }

    const installationQuery = {
      agentName,
      status: 'active',
    };
    if (instanceId) (installationQuery as any).instanceId = instanceId;
    if (requestedPodId) (installationQuery as any).podId = requestedPodId;

    let installations = await AgentInstallation.find(installationQuery)
      .select('agentName instanceId podId installedBy')
      .lean();

    // Backward-compat fallback for stale clients that still send
    // instanceId=default when only one non-default instance is installed.
    if (!installations.length && instanceId) {
      const fallbackQuery = {
        agentName,
        status: 'active',
      };
      if (requestedPodId) (fallbackQuery as any).podId = requestedPodId;
      const fallbackInstalls = await AgentInstallation.find(fallbackQuery)
        .select('agentName instanceId podId installedBy')
        .limit(2)
        .lean();
      if (fallbackInstalls.length === 1) {
        installations = fallbackInstalls;
      }
    }

    if (!installations.length) {
      return res.status(404).json({ message: 'No active installation found for that agent' });
    }

    const candidatePodIds = installations
      .map((installation: any) => installation.podId)
      .filter(Boolean);
    const accessiblePods = await Pod.find({
      _id: { $in: candidatePodIds },
      members: userId,
    }).select('_id').lean();
    const accessiblePodIdSet = new Set(
      accessiblePods.map((pod: any) => pod._id.toString()),
    );

    const authorizedInstallations = installations.filter((installation: any) => (
      String(installation.installedBy || '') === String(userId)
      || accessiblePodIdSet.has(String(installation.podId))
    ));

    if (!authorizedInstallations.length) {
      return res.status(403).json({ message: 'Not authorized to message this agent' });
    }

    const normalizedInstalls = authorizedInstallations.map((installation: any) => ({
      ...installation,
      instanceId: String(installation.instanceId || 'default'),
    }));
    const byExactInstance = normalizedInstanceId
      ? normalizedInstalls.filter(
        (installation: any) => installation.instanceId.toLowerCase() === normalizedInstanceId,
      )
      : [];

    let selectedInstallation = null;
    if (byExactInstance.length === 1) {
      selectedInstallation = byExactInstance[0];
    } else if (byExactInstance.length > 1) {
      return res.status(409).json({
        message: 'Multiple installations match that instanceId. Specify podId.',
      });
    } else if (normalizedInstanceId === 'default' && normalizedInstalls.length === 1) {
      // Backward compatibility: stale clients may still send default.
      selectedInstallation = normalizedInstalls[0];
    } else if (!normalizedInstanceId && normalizedInstalls.length === 1) {
      selectedInstallation = normalizedInstalls[0];
    } else {
      return res.status(409).json({
        message: 'Multiple installations found. Specify instanceId (and podId if needed).',
        installations: normalizedInstalls.map((installation: any) => ({
          instanceId: installation.instanceId,
          podId: String(installation.podId || ''),
        })),
      });
    }

    const agentUser = await AgentIdentityService.getOrCreateAgentUser(
      selectedInstallation.agentName,
      { instanceId: selectedInstallation.instanceId || 'default' },
    );

    const dmPod = await DMService.getOrCreateAdminDMPod(agentUser._id, userId, {
      agentName: selectedInstallation.agentName,
      instanceId: selectedInstallation.instanceId || 'default',
    });

    return res.json({ dmPod });
  } catch (error: any) {
    console.error('Error creating/fetching agent DM:', error);
    return res.status(500).json({ message: 'Failed to create/fetch agent DM' });
  }
});

/**
 * POST /room — Find or create an agent-room (1:1 DM) per ADR-001 §3.10.
 *
 * Agent rooms are personal 1:1 DMs whose two members can be (human + agent)
 * or (agent + agent), never three. The earlier "many humans × one agent
 * office" framing was rejected during product review; the join/auto-install
 * paths in podController/agentIdentityService now enforce strict 1:1.
 *
 * This endpoint currently accepts only `auth` (human JWT), so callers
 * always create human↔agent DMs through it. Agent-initiated agent↔agent
 * DMs are supported by `getOrCreateAgentRoom` at the service level but
 * have no agent-runtime endpoint yet — file a follow-up if needed.
 *
 * Request: { agentName, instanceId?, podId? }
 * Response: { room: Pod }
 */
router.post('/room', auth, async (req: any, res: any) => {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const {
      agentName: rawAgentName,
      instanceId: rawInstanceId,
      podId: requestedPodId,
    } = req.body || {};

    const agentName = String(rawAgentName || '').trim().toLowerCase();
    const instanceId = String(rawInstanceId || '').trim() || null;
    if (!agentName) {
      return res.status(400).json({ message: 'agentName is required' });
    }

    // Find an active installation the requesting user has access to.
    const installationQuery: any = { agentName, status: 'active' };
    if (instanceId) installationQuery.instanceId = instanceId;
    if (requestedPodId) installationQuery.podId = requestedPodId;

    let installations = await AgentInstallation.find(installationQuery)
      .select('agentName instanceId podId installedBy')
      .lean();

    // Backward-compat fallback for single-install agents.
    if (!installations.length && instanceId) {
      const fallbackQuery: any = { agentName, status: 'active' };
      if (requestedPodId) fallbackQuery.podId = requestedPodId;
      const fallbackInstalls = await AgentInstallation.find(fallbackQuery)
        .select('agentName instanceId podId installedBy')
        .limit(2)
        .lean();
      if (fallbackInstalls.length === 1) installations = fallbackInstalls;
    }

    if (!installations.length) {
      return res.status(404).json({ message: 'No active installation found for that agent' });
    }

    // Authorization: user must be installer or a member of an installed pod.
    const candidatePodIds = installations
      .map((i: any) => i.podId).filter(Boolean);
    const accessiblePods = await Pod.find({
      _id: { $in: candidatePodIds },
      members: userId,
    }).select('_id').lean();
    const accessibleSet = new Set(accessiblePods.map((p: any) => p._id.toString()));

    const authorized = installations.filter((i: any) => (
      String(i.installedBy || '') === String(userId)
      || accessibleSet.has(String(i.podId))
    ));

    if (!authorized.length) {
      return res.status(403).json({ message: 'Not authorized to talk to this agent' });
    }

    // Pick the installation — prefer exact instanceId match, fall back to sole.
    const normalizedInstanceId = instanceId?.toLowerCase() || null;
    const normalized = authorized.map((i: any) => ({
      ...i,
      instanceId: String(i.instanceId || 'default'),
    }));
    let selected: any = null;
    const byExact = normalizedInstanceId
      ? normalized.filter((i: any) => i.instanceId.toLowerCase() === normalizedInstanceId)
      : [];
    if (byExact.length === 1) {
      selected = byExact[0];
    } else if (normalized.length === 1) {
      selected = normalized[0];
    } else {
      return res.status(409).json({
        message: 'Multiple installations found. Specify instanceId.',
        installations: normalized.map((i: any) => ({
          instanceId: i.instanceId,
          podId: String(i.podId || ''),
        })),
      });
    }

    // Resolve the agent's User row.
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(
      selected.agentName,
      { instanceId: selected.instanceId || 'default' },
    );

    // Get or create the agent room.
    const room = await DMService.getOrCreateAgentRoom(agentUser._id, userId, {
      agentName: selected.agentName,
      instanceId: selected.instanceId || 'default',
    });

    return res.json({ room });
  } catch (error: any) {
    console.error('Error creating/fetching agent room:', error);
    return res.status(500).json({ message: 'Failed to create/fetch agent room' });
  }
});

/**
 * POST /bot/events/:id/ack (user API token auth)
 * For bot users to acknowledge events
 */
router.post('/bot/events/:id/ack', auth, requireApiTokenScopes(['agent:events:ack']), async (req: any, res: any) => {
  try {
    const { user, error } = await requireBotUser(req, res);
    if (error) return error;

    const agentName = req.body.agentName || user.botMetadata?.agentName || null;
    const instanceId = req.body.instanceId || user.botMetadata?.instanceId || 'default';
    const resolvedAgentName = agentName || user.username;
    const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
    if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
      return res.status(403).json({ message: 'Agent token does not match bot user' });
    }
    const delivery = req.body?.result || req.body?.delivery || null;
    await AgentEventService.acknowledge(req.params.id, resolvedAgentName, instanceId, delivery);

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Error acknowledging bot event:', error);
    return res.status(500).json({ message: 'Failed to acknowledge bot event' });
  }
});

router.post('/events/:id/ack', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const installation = req.agentInstallation;
    const agentUser = req.agentUser;
    const agentName = installation?.agentName
      || agentUser?.botMetadata?.agentName
      || agentUser?.botMetadata?.agentType
      || agentUser?.username;
    const instanceId = installation?.instanceId
      || agentUser?.botMetadata?.instanceId
      || 'default';
    if (!agentName) {
      return res.status(403).json({ message: 'Agent token not authorized for events' });
    }
    const delivery = req.body?.result || req.body?.delivery || null;
    await AgentEventService.acknowledge(
      req.params.id,
      agentName,
      instanceId,
      delivery,
    );
    return res.json({ success: true });
  } catch (error: any) {
    console.error('Error acknowledging agent event:', error);
    return res.status(500).json({ message: 'Failed to acknowledge agent event' });
  }
});

/**
 * GET /bot/pods/:podId/context (user API token auth)
 * Bot users can fetch pod context without runtime tokens.
 */
router.get(
  '/bot/pods/:podId/context',
  auth,
  requireApiTokenScopes(['agent:context:read']),
  async (req: any, res: any) => {
    try {
      const { podId } = req.params;
      const { user, error } = await requireBotUser(req, res);
      if (error) return error;

      const agentName = req.query.agentName || user.botMetadata?.agentName || null;
      const instanceId = req.query.instanceId || user.botMetadata?.instanceId || 'default';
      const resolvedAgentName = agentName || user.username;
      const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
      if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
        return res.status(403).json({ message: 'Agent token does not match bot user' });
      }

      const installation = await ensureBotPodAccess(
        user,
        resolvedAgentName,
        podId,
        ['active', 'paused'],
        instanceId,
      );
      if (!installation) {
        return res.status(403).json({ message: 'Bot not installed in this pod' });
      }

      await AgentIdentityService.ensureAgentInPod(user, podId);

      const clamp = (value: any, min: any, max: any) => Math.min(Math.max(value, min), max);
      const parseLimit = (raw: any, fallback: any, max: any) => {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isNaN(parsed)) return fallback;
        return clamp(parsed, 1, max);
      };

      const context = await PodContextService.getPodContext({
        podId,
        userId: user._id,
        agentContext: { agentName: resolvedAgentName, instanceId },
        task: req.query.task || '',
        summaryLimit: parseLimit(req.query.summaryLimit, 6, 20),
        assetLimit: parseLimit(req.query.assetLimit, 12, 40),
        tagLimit: parseLimit(req.query.tagLimit, 16, 40),
        skillLimit: parseLimit(req.query.skillLimit, 6, 12),
        skillMode: typeof req.query.skillMode === 'string' ? req.query.skillMode.toLowerCase() : 'llm',
        skillRefreshHours: parseLimit(req.query.skillRefreshHours, 6, 72),
      });

      return res.json(context);
    } catch (error: any) {
      console.error('Error fetching bot pod context:', error);
      return res.status(500).json({ message: 'Failed to fetch pod context' });
    }
  },
);

/**
 * GET /bot/pods/:podId/messages (user API token auth)
 */
router.get(
  '/bot/pods/:podId/messages',
  auth,
  requireApiTokenScopes(['agent:messages:read']),
  async (req: any, res: any) => {
    try {
      const { podId } = req.params;
      const { user, error } = await requireBotUser(req, res);
      if (error) return error;

      const agentName = req.query.agentName || user.botMetadata?.agentName || null;
      const instanceId = req.query.instanceId || user.botMetadata?.instanceId || 'default';
      const resolvedAgentName = agentName || user.username;
      const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
      if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
        return res.status(403).json({ message: 'Agent token does not match bot user' });
      }

      const installation = await ensureBotPodAccess(
        user,
        resolvedAgentName,
        podId,
        ['active', 'paused'],
        instanceId,
      );
      if (!installation) {
        return res.status(403).json({ message: 'Bot not installed in this pod' });
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
      const messages = await AgentMessageService.getRecentMessages(podId, limit);
      return res.json({ messages });
    } catch (error: any) {
      console.error('Error fetching bot messages:', error);
      return res.status(500).json({ message: 'Failed to fetch messages' });
    }
  },
);

/**
 * POST /bot/pods/:podId/messages (user API token auth)
 */
router.post(
  '/bot/pods/:podId/messages',
  auth,
  requireApiTokenScopes(['agent:messages:write']),
  async (req: any, res: any) => {
    try {
      const { podId } = req.params;
      const { user, error } = await requireBotUser(req, res);
      if (error) return error;

      const agentName = req.body.agentName || user.botMetadata?.agentName || null;
      const instanceId = req.body.instanceId || user.botMetadata?.instanceId || 'default';
      const resolvedAgentName = agentName || user.username;
      const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
      if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
        return res.status(403).json({ message: 'Agent token does not match bot user' });
      }

      const installation = await ensureBotPodAccess(
        user,
        resolvedAgentName,
        podId,
        ['active'],
        instanceId,
      );
      if (!installation) {
        return res.status(403).json({ message: 'Bot not installed in this pod' });
      }

      const { content, metadata, messageType } = req.body || {};
      const result = await AgentMessageService.postMessage({
        agentName: resolvedAgentName,
        instanceId,
        displayName: installation.displayName,
        podId,
        content,
        metadata,
        messageType,
        installationConfig: installation.config || null,
      });

      return res.json(result);
    } catch (error: any) {
      console.error('Error posting bot message:', error);
      return res.status(500).json({ message: (error as Error).message || 'Failed to post message' });
    }
  },
);

/**
 * POST /bot/threads/:threadId/comments (user API token auth)
 * Post a thread comment as the agent (bot user token).
 */
router.post(
  '/bot/threads/:threadId/comments',
  auth,
  requireApiTokenScopes(['agent:messages:write']),
  async (req: any, res: any) => {
    try {
      const { threadId } = req.params;
      const { user, error } = await requireBotUser(req, res);
      if (error) return error;

      const agentName = req.body.agentName || user.botMetadata?.agentName || null;
      const instanceId = req.body.instanceId || user.botMetadata?.instanceId || 'default';
      const resolvedAgentName = agentName || user.username;
      const expectedUsername = AgentIdentityService.buildAgentUsername(resolvedAgentName, instanceId);
      if (expectedUsername.toLowerCase() !== user.username.toLowerCase()) {
        return res.status(403).json({ message: 'Agent token does not match bot user' });
      }

      const { content, podId: requestPodId } = req.body || {};
      if (!content) {
        return res.status(400).json({ message: 'content is required' });
      }

      const post = await Post.findById(threadId).select('_id podId').lean();
      if (!post) {
        return res.status(404).json({ message: 'Thread not found' });
      }

      const targetPodId = post?.podId || requestPodId;
      if (!targetPodId) {
        return res.status(400).json({ message: 'podId is required for threads without a pod' });
      }

      const installation = await ensureBotInstallation(
        resolvedAgentName,
        targetPodId,
        ['active'],
        instanceId,
      );
      if (!installation) {
        return res.status(403).json({ message: 'Bot not installed in this pod' });
      }

      const result = await AgentThreadService.postComment({
        agentName: resolvedAgentName,
        instanceId,
        displayName: installation.displayName,
        threadId,
        content,
      });

      return res.json(result);
    } catch (error: any) {
      console.error('Error posting bot thread comment:', error);
      return res.status(500).json({ message: (error as Error).message || 'Failed to post comment' });
    }
  },
);

router.get('/pods/:podId/context', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const agentUser = await AgentIdentityService.getOrCreateAgentUser(installation.agentName, {
      instanceId: installation.instanceId || 'default',
      displayName: installation.displayName,
    });
    await AgentIdentityService.ensureAgentInPod(agentUser, podId);

    const clamp = (value: any, min: any, max: any) => Math.min(Math.max(value, min), max);
    const parseLimit = (raw: any, fallback: any, max: any) => {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) return fallback;
      return clamp(parsed, 1, max);
    };

    // Resolve context token budget from model config
    let maxContextTokens = 0;
    if (req.query.maxContextTokens) {
      maxContextTokens = parseLimit(req.query.maxContextTokens, 0, 200000);
    } else {
      const modelConfig = await GlobalModelConfigService.getConfig().catch(() => null);
      const contextLimit = modelConfig?.llmService?.contextLimit || 0;
      // Reserve 25% of model context for system prompt + output
      if (contextLimit > 0) {
        maxContextTokens = Math.floor(contextLimit * 0.75);
      }
    }

    const context = await PodContextService.getPodContext({
      podId,
      userId: agentUser._id,
      agentContext: { agentName: installation.agentName, instanceId: installation.instanceId || 'default' },
      task: req.query.task || '',
      summaryLimit: parseLimit(req.query.summaryLimit, 6, 20),
      assetLimit: parseLimit(req.query.assetLimit, 12, 40),
      tagLimit: parseLimit(req.query.tagLimit, 16, 40),
      skillLimit: parseLimit(req.query.skillLimit, 6, 12),
      skillMode: typeof req.query.skillMode === 'string' ? req.query.skillMode.toLowerCase() : 'llm',
      skillRefreshHours: parseLimit(req.query.skillRefreshHours, 6, 72),
      maxContextTokens,
    });

    return res.json(context);
  } catch (error: any) {
    let statusCode = 500;
    if (error.status) statusCode = error.status;
    else if ((error as any).code === 'POD_NOT_FOUND') statusCode = 404;
    else if ((error as any).code === 'NOT_A_MEMBER') statusCode = 403;
    console.error(`Error fetching agent pod context [${statusCode}]:`, (error as Error).message || error);
    return res.status(statusCode).json({
      message: (error as Error).message || 'Failed to fetch pod context',
      code: (error as any).code || 'INTERNAL_ERROR',
    });
  }
});

router.get('/pods/:podId/messages', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const messages = await AgentMessageService.getRecentMessages(podId, limit);

    return res.json({ messages });
  } catch (error: any) {
    console.error('Error fetching pod messages:', error);
    return res.status(500).json({ message: 'Failed to fetch messages' });
  }
});

/**
 * GET /pods/:podId/posts
 * Recent posts in a pod with comment counts and recent human comments.
 * postId doubles as threadId for commonly_post_thread_comment.
 */
router.get('/pods/:podId/posts', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    if (!ensurePodMatch(req.agentInstallations || req.agentInstallation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 10);
    const posts = await Post.find({ podId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('userId', 'username isBot')
      .populate('comments.userId', 'username isBot')
      .lean();

    const agentUserId = req.agentUser?._id?.toString();
    const result = posts.map((p: any) => {
      const allComments = p.comments || [];
      const humanComments = [];
      const agentComments = [];
      const myCommentIds = new Set();
      for (const c of allComments) {
        if (c.userId?.isBot) {
          agentComments.push(c);
          if (agentUserId && c.userId?._id?.toString() === agentUserId) {
            myCommentIds.add(c._id?.toString());
          }
        } else {
          humanComments.push(c);
        }
      }
      return {
        postId: p._id.toString(),
        author: p.userId?.username || 'unknown',
        isBot: p.userId?.isBot || false,
        content: (p.content || '').slice(0, 300),
        source: p.source?.url || null,
        createdAt: p.createdAt,
        commentCount: allComments.length,
        humanCommentCount: humanComments.length,
        recentComments: (() => {
          const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
          return humanComments
            .filter((c) => c.createdAt && new Date(c.createdAt) >= cutoff)
            .slice(-5)
            .map((c) => ({
              commentId: c._id?.toString(),
              author: c.userId?.username || 'unknown',
              text: (c.text || '').slice(0, 200),
              replyTo: c.replyTo?.toString() || null,
              createdAt: c.createdAt,
            }));
        })(),
        agentComments: agentComments.slice(-5).map((c) => ({
          commentId: c._id?.toString(),
          author: c.userId?.username || 'unknown',
          text: (c.text || '').slice(0, 120),
          replyTo: c.replyTo?.toString() || null,
          isReplyToMe: !!(c.replyTo && myCommentIds.has(c.replyTo.toString())),
          createdAt: c.createdAt,
        })),
      };
    });

    return res.json({ posts: result });
  } catch (error: any) {
    console.error('Error fetching pod posts:', error);
    return res.status(500).json({ message: 'Failed to fetch posts' });
  }
});

router.post('/pods/:podId/messages', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const { content, metadata, messageType, replyToMessageId } = req.body || {};
    const result = await AgentMessageService.postMessage({
      agentName: installation.agentName,
      instanceId: installation.instanceId || 'default',
      displayName: installation.displayName,
      podId,
      content,
      metadata,
      messageType,
      replyToMessageId: replyToMessageId || null,
      installationConfig: installation.config || null,
    });

    // Fire mention detection so @mentions trigger chat.mention events for other agents
    if (result.success && !result.skipped && result.message) {
      const userId = req.agentUser?._id;
      const username = req.agentUser?.username;
      AgentMentionService.enqueueMentions({ podId, message: result.message, userId, username })
        .catch((err: any) => console.warn('enqueueMentions failed:', err.message));
    }

    return res.json(result);
  } catch (error: any) {
    console.error('Error posting agent message:', error);
    return res.status(500).json({ message: (error as Error).message || 'Failed to post message' });
  }
});

router.post('/pods/:podId/summaries', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const {
      summary,
      summaryType = 'chats',
      source = 'agent',
      sourceLabel = 'Agent',
      title,
      messageCount = 0,
      timeRange = null,
      eventId = null,
    } = req.body || {};

    const summaryText = typeof summary === 'string'
      ? summary
      : (summary?.content || summary?.summary || '');
    if (!summaryText || !String(summaryText).trim()) {
      return res.status(400).json({ message: 'summary is required' });
    }

    const structuredPayload = {
      type: summaryType,
      source,
      sourceLabel,
      summary: String(summaryText).trim(),
      title: title || null,
      messageCount: Number.isFinite(Number(messageCount)) ? Number(messageCount) : 0,
      timeRange: timeRange || undefined,
      eventId: eventId || undefined,
    };

    const persisted = await AgentMessageService.persistSummaryFromAgentMessage({
      agentName: installation.agentName,
      podId,
      content: `[BOT_MESSAGE]${JSON.stringify(structuredPayload)}`,
      metadata: {
        summaryType,
        source,
        messageCount: structuredPayload.messageCount,
        timeRange: structuredPayload.timeRange || undefined,
        eventId: structuredPayload.eventId || undefined,
      },
    });

    return res.json({
      success: true,
      summary: persisted
        ? {
          id: persisted._id?.toString?.() || persisted._id,
          type: persisted.type,
          title: persisted.title,
          content: persisted.content,
          createdAt: persisted.createdAt,
        }
        : null,
    });
  } catch (error: any) {
    console.error('Error persisting agent summary:', error);
    return res.status(500).json({ message: (error as Error).message || 'Failed to persist summary' });
  }
});

/**
 * POST /threads/:threadId/comments (agent runtime token auth)
 */
router.post('/threads/:threadId/comments', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { threadId } = req.params;
    const installation = req.agentInstallation;

    const { content, replyToCommentId } = req.body || {};
    if (!content) {
      return res.status(400).json({ message: 'content is required' });
    }

    const post = await Post.findById(threadId).select('_id podId').lean();
    if (!post) {
      return res.status(404).json({ message: 'Thread not found' });
    }

    if (post.podId && !ensurePodMatch(
      req.agentInstallations || installation,
      post.podId,
      req.agentAuthorizedPodIds,
    )) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    const resolvedInstallation = post.podId
      ? resolveInstallationForPod(req.agentInstallations, installation, post.podId)
      : installation;

    const result = await AgentThreadService.postComment({
      agentName: resolvedInstallation.agentName,
      instanceId: resolvedInstallation.instanceId || 'default',
      displayName: resolvedInstallation.displayName,
      threadId,
      content,
      replyToCommentId: replyToCommentId || null,
    });

    return res.json(result);
  } catch (error: any) {
    console.error('Error posting agent thread comment:', error);
    return res.status(500).json({ message: (error as Error).message || 'Failed to post comment' });
  }
});

// ADR-003 Phase 1: GET/PUT /memory accept both v1 (`{ content }`) and
// v2 (`{ sections, sourceRuntime }`) shapes. GET always returns both for
// compatibility. `schemaVersion` is server-set (2 whenever sections are
// written), not client-supplied. New CAP endpoint (POST /memory/sync) with
// explicit full/patch mode lands in Phase 2.

// Single source of truth — shared with the model schema.
const { VISIBILITY_VALUES } = require('../models/AgentMemory');
const VALID_VISIBILITIES = new Set(VISIBILITY_VALUES);

function resolveMemoryIdentity(req: any): { agentName?: string; instanceId: string } {
  const agentInstallation = req.agentInstallation;
  const agentName =
    agentInstallation?.agentName ||
    req.agentUser?.botMetadata?.agentName ||
    req.agentUser?.username;
  const instanceId =
    agentInstallation?.instanceId ||
    req.agentUser?.botMetadata?.instanceId ||
    'default';
  return { agentName, instanceId };
}

function validateSectionsPayload(sections: any): string | null {
  if (typeof sections !== 'object' || sections === null || Array.isArray(sections)) {
    return 'sections must be an object';
  }
  if (Object.keys(sections).length === 0) {
    return 'sections must have at least one key';
  }
  const allowed = new Set(['soul', 'long_term', 'dedup_state', 'shared', 'runtime_meta', 'daily', 'relationships']);
  for (const key of Object.keys(sections)) {
    if (!allowed.has(key)) return `unknown section: ${key}`;
  }
  const singleSectionKeys = ['soul', 'long_term', 'dedup_state', 'shared', 'runtime_meta'];
  for (const key of singleSectionKeys) {
    const s = sections[key];
    if (s === undefined) continue;
    if (typeof s !== 'object' || s === null) return `sections.${key} must be an object`;
    if (s.content !== undefined && typeof s.content !== 'string') return `sections.${key}.content must be a string`;
    if (s.visibility !== undefined && !VALID_VISIBILITIES.has(s.visibility)) {
      return `sections.${key}.visibility must be one of private|pod|public`;
    }
  }
  if (sections.daily !== undefined) {
    if (!Array.isArray(sections.daily)) return 'sections.daily must be an array';
    for (const d of sections.daily) {
      if (!isValidYMD(d?.date)) return 'sections.daily[].date must be YYYY-MM-DD';
      if (d.visibility !== undefined && !VALID_VISIBILITIES.has(d.visibility)) {
        return 'sections.daily[].visibility must be one of private|pod|public';
      }
    }
  }
  if (sections.relationships !== undefined) {
    if (!Array.isArray(sections.relationships)) return 'sections.relationships must be an array';
    for (const r of sections.relationships) {
      if (typeof r?.otherInstanceId !== 'string') return 'sections.relationships[].otherInstanceId must be a string';
      if (r.visibility !== undefined && !VALID_VISIBILITIES.has(r.visibility)) {
        return 'sections.relationships[].visibility must be one of private|pod|public';
      }
    }
  }
  return null;
}

/**
 * GET /memory (agent runtime token auth)
 * Returns this agent's memory in both v1 (`content`) and v2 (`sections`)
 * shapes. v1 callers read `content`; v2 callers read `sections` directly.
 */
router.get('/memory', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { agentName, instanceId } = resolveMemoryIdentity(req);
    if (!agentName) {
      return res.status(403).json({ message: 'Could not resolve agent identity' });
    }
    const record = await AgentMemory.findOne({ agentName, instanceId }).lean();
    return res.json({
      content: record?.content ?? '',
      sections: record?.sections,
      sourceRuntime: record?.sourceRuntime,
      schemaVersion: record?.schemaVersion,
    });
  } catch (err: any) {
    console.error('GET /memory error:', err);
    return res.status(500).json({ message: 'Failed to read agent memory' });
  }
});

/**
 * PUT /memory (agent runtime token auth)
 * Accepts v1 (`{ content }`) or v2 (`{ sections, sourceRuntime? }`) or both.
 *
 * Semantics:
 * - Single-object sections (`soul | long_term | dedup_state | shared |
 *   runtime_meta`) are MERGED per-key. Sibling sections the caller did not
 *   include are preserved (e.g. writing just `dedup_state` leaves
 *   `long_term` alone).
 * - Array sections (`daily`, `relationships`) are **whole-array replace**.
 *   Sending `{ relationships: [...] }` replaces the entire stored array.
 *   Phase 2's POST /memory/sync with `mode: 'patch'` will add element-level
 *   merge. Callers that need to add a single entry must resend the full
 *   array for now.
 * - `content` is mirrored from `sections.long_term.content` only when the
 *   caller actually supplied `long_term` AND did not also supply an explicit
 *   `content`. Sending `{ sections: { long_term: { content: '' } } }` is a
 *   deliberate clear and will blank `content`. Otherwise existing `content`
 *   is untouched.
 * - `schemaVersion` is server-set to 2 whenever sections are written; not
 *   client-supplied. Phase 2 (/memory/sync) introduces explicit mode flags.
 * - `byteSize` and `updatedAt` are always server-stamped via
 *   `stampSectionsForWrite`; client-supplied values are discarded.
 */
router.put('/memory', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { agentName, instanceId } = resolveMemoryIdentity(req);
    if (!agentName) {
      return res.status(403).json({ message: 'Could not resolve agent identity' });
    }
    const { content, sections, sourceRuntime } = req.body || {};
    if (content === undefined && sections === undefined) {
      return res.status(400).json({ message: 'must provide content or sections' });
    }
    if (content !== undefined && typeof content !== 'string') {
      return res.status(400).json({ message: 'content must be a string' });
    }
    if (sections !== undefined) {
      const sectionsError = validateSectionsPayload(sections);
      if (sectionsError) return res.status(400).json({ message: sectionsError });
    }
    if (sourceRuntime !== undefined && typeof sourceRuntime !== 'string') {
      return res.status(400).json({ message: 'sourceRuntime must be a string' });
    }

    const setOps: Record<string, unknown> = {};
    if (sections !== undefined) {
      // Server-stamp byteSize + updatedAt so clients can't fabricate them.
      const stamped = stampSectionsForWrite(sections);
      // Per-key merge via dotted $set paths — preserves sibling sections the
      // caller didn't include in this write.
      for (const key of Object.keys(stamped)) {
        setOps[`sections.${key}`] = (stamped as any)[key];
      }
      setOps.schemaVersion = 2;
      if (content === undefined && stamped.long_term !== undefined) {
        setOps.content = mirrorContentFromSections(stamped);
      }
    }
    if (content !== undefined) setOps.content = content;
    if (sourceRuntime !== undefined) setOps.sourceRuntime = sourceRuntime;

    // Invalidate the /memory/sync dedup cache: any non-sync writer mutates
    // state the sync dedup key may no longer reflect. Without this, a sync
    // path that promoted the same bytes earlier in the day will get wrongly
    // short-circuited after a PUT/native-runtime write landed between.
    await AgentMemory.findOneAndUpdate(
      { agentName, instanceId },
      { $set: setOps, $unset: { lastSyncKey: '', lastSyncAt: '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    console.log('[agent-memory PUT]', {
      agentName,
      instanceId,
      sectionKeys: sections ? Object.keys(sections) : [],
      contentProvided: content !== undefined,
      sourceRuntime,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('PUT /memory error:', err);
    return res.status(500).json({ message: 'Failed to write agent memory' });
  }
});

/**
 * POST /memory/sync (agent runtime token auth)
 * ADR-003 Phase 2. Runtime-driver promotion of memory into the kernel.
 *
 * Body:
 *   {
 *     sections: {...},              // required, validated as in PUT /memory
 *     sourceRuntime?: string,       // driver self-id (e.g. "openclaw")
 *     mode: "full" | "patch"        // required
 *   }
 *
 * Modes:
 *   - "full":  replaces `sections` wholesale with the payload. Sections not
 *              in the payload are cleared. Use when the driver is pushing a
 *              complete snapshot.
 *   - "patch": merges with existing state. Single-object sections are $set
 *              per-key (siblings preserved). Array sections (`daily`,
 *              `relationships`) merge element-wise, keyed by `date` and
 *              `otherInstanceId`. Use for incremental updates.
 *
 * Idempotency: repeated identical payloads within the same UTC day bucket
 * are deduped (no write, returns `{ deduped: true }`). Key is
 * `(dayBucket, sourceRuntime, sha256(sections+mode))`.
 *
 * `byteSize` and `updatedAt` are server-stamped. `schemaVersion` auto-set to 2.
 * v1 `content` is mirrored from `long_term.content` (same rule as PUT).
 */
router.post('/memory/sync', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { agentName, instanceId } = resolveMemoryIdentity(req);
    if (!agentName) {
      return res.status(403).json({ message: 'Could not resolve agent identity' });
    }
    const { sections, sourceRuntime, mode } = req.body || {};
    const rejectAndLog = (msg: string) => {
      console.log('[agent-memory SYNC reject]', { agentName, instanceId, msg });
      return res.status(400).json({ message: msg });
    };
    if (sections === undefined) return rejectAndLog('sections is required');
    const sectionsError = validateSectionsPayload(sections);
    if (sectionsError) return rejectAndLog(sectionsError);
    if (sourceRuntime !== undefined && typeof sourceRuntime !== 'string') {
      return rejectAndLog('sourceRuntime must be a string');
    }
    if (mode !== 'full' && mode !== 'patch') {
      return rejectAndLog("mode must be 'full' or 'patch'");
    }

    const now = new Date();
    const dedupKey = computeSyncDedupKey(sections, sourceRuntime, mode, now);

    const existing = await AgentMemory.findOne({ agentName, instanceId }).lean();
    if (existing?.lastSyncKey === dedupKey) {
      console.log('[agent-memory SYNC deduped]', { agentName, instanceId, mode, sourceRuntime });
      return res.json({ ok: true, deduped: true });
    }

    const stamped = stampSectionsForWrite(sections, now);

    let finalSections: any;
    if (mode === 'full') {
      finalSections = stamped;
    } else {
      finalSections = mergePatchSections(existing?.sections, stamped);
    }

    const update: Record<string, unknown> = {
      sections: finalSections,
      schemaVersion: 2,
      lastSyncKey: dedupKey,
      lastSyncAt: now,
    };
    if (sourceRuntime !== undefined) update.sourceRuntime = sourceRuntime;

    // v1 `content` mirror rules:
    // - full mode: always reflects whatever `long_term` is in the new
    //   sections — including `''` when the caller omitted long_term, since
    //   full mode means "no long_term from now on." Otherwise v1 readers
    //   see phantom data the kernel no longer stores.
    // - patch mode: only mirrored when the caller explicitly wrote
    //   long_term (so an incremental patch that ignored long_term doesn't
    //   stomp v1 content).
    if (mode === 'full') {
      update.content = mirrorContentFromSections(finalSections);
    } else if ((stamped as any).long_term !== undefined) {
      update.content = mirrorContentFromSections(stamped);
    }

    await AgentMemory.findOneAndUpdate(
      { agentName, instanceId },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    console.log('[agent-memory SYNC]', {
      agentName,
      instanceId,
      mode,
      sectionKeys: Object.keys(stamped),
      sourceRuntime,
    });

    return res.json({ ok: true, schemaVersion: 2 });
  } catch (err: any) {
    console.error('POST /memory/sync error:', err);
    return res.status(500).json({ message: 'Failed to sync agent memory' });
  }
});

/**
 * POST /posts (agent runtime token auth)
 * Create a post in the feed as the agent's bot user
 */
router.post('/posts', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const agentUser = req.agentUser;
    if (!agentUser) {
      return res.status(403).json({ message: 'No bot user associated with this runtime token' });
    }

    const { content, tags, category, podId, source } = req.body || {};
    if (!content) {
      return res.status(400).json({ message: 'content is required' });
    }

    if (podId) {
      const pod = await Pod.findById(podId).select('_id members').lean();
      if (!pod) return res.status(404).json({ message: 'Pod not found' });
      const isMember = pod.members?.some((m: any) => m.toString() === agentUser._id.toString());
      if (!isMember) {
        return res.status(403).json({ message: 'Agent is not a member of this pod' });
      }
    }

    const resolvedCategory = (category || '').trim() || 'General';
    const resolvedSource = source && typeof source === 'object'
      ? {
        type: source.type || (podId ? 'pod' : 'user'),
        provider: source.provider || 'internal',
        externalId: source.externalId || null,
        url: source.url || null,
        author: source.author || null,
        authorUrl: source.authorUrl || null,
        channel: source.channel || null,
      }
      : { type: podId ? 'pod' : 'user', provider: 'internal' };

    // Dedup: if a post with the same source URL already exists in this pod, return it
    if (resolvedSource.url && podId) {
      const existing = await Post.findOne({ podId, 'source.url': resolvedSource.url }).lean();
      if (existing) {
        return res.status(200).json(existing);
      }
    }

    const isAcpAgent = agentUser.botMetadata?.agentName === 'codex';

    const post = new Post({
      userId: agentUser._id,
      content,
      tags: Array.isArray(tags) ? tags : [],
      podId: podId || null,
      category: resolvedCategory,
      source: resolvedSource,
      agentCommentsDisabled: isAcpAgent,
    });
    await post.save();

    return res.status(201).json(post);
  } catch (error: any) {
    console.error('Error creating agent post:', error);
    return res.status(500).json({ message: (error as Error).message || 'Failed to create post' });
  }
});

/**
 * Ensure the summarizer bot is installed (or reactivated) in a pod.
 * Silently no-ops if already active.
 */
async function ensureCommonlyBotInstalled(podId: any, installedBy: any) {
  try {
    await AgentInstallation.install('commonly-bot', podId, {
      version: '1.0.0',
      config: {},
      scopes: ['context:read', 'summaries:read'],
      installedBy,
      instanceId: 'default',
      displayName: 'Commonly Summarizer',
    });
  } catch (err: any) {
    if (!err.message?.includes('already installed')) throw err;
  }
}

/**
 * GET /pods (agent runtime token auth)
 * List public pods the agent can discover and join.
 * Returns pods ordered by recent activity, excluding DM pods.
 */
router.get('/pods', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const pods = await Pod.find({ type: { $nin: ['dm', 'agent-admin'] } })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select('name description type members updatedAt')
      .lean();

    const authorizedPodIds = new Set((req.agentAuthorizedPodIds || []).map((id: any) => id.toString()));

    // Batch-fetch bot user IDs and pod summaries in parallel
    const allMemberIds = [...new Set(
      pods.flatMap((p: any) => (p.members || []).map((id: any) => id.toString())),
    )];
    const podIdStrings = pods.map((p: any) => p._id.toString());

    const [bots, summaryMapResult] = await Promise.all([
      allMemberIds.length > 0
        ? User.find({ _id: { $in: allMemberIds }, isBot: true }).select('_id').lean()
        : Promise.resolve([]),
      ChatSummarizerService.getMultiplePodSummaries(podIdStrings).catch((summaryErr: any) => {
        console.warn('[GET /pods] Failed to fetch pod summaries:', summaryErr.message);
        return {};
      }),
    ]);
    const botUserIds = new Set(bots.map((b: any) => b._id.toString()));
    const summaryMap = summaryMapResult;

    const result = pods.map((p: any) => {
      const members = p.members || [];
      const humanMemberCount = members.filter(
        (id: any) => !botUserIds.has(id.toString()),
      ).length;
      const podIdStr = p._id.toString();
      const latestSummary = summaryMap[podIdStr];
      return {
        podId: podIdStr,
        name: p.name,
        description: p.description || null,
        latestSummary: latestSummary ? latestSummary.content : null,
        type: p.type,
        memberCount: members.length,
        humanMemberCount,
        isMember: authorizedPodIds.has(podIdStr),
        updatedAt: p.updatedAt,
      };
    });

    return res.json({ pods: result });
  } catch (error: any) {
    console.error('Error listing pods:', error);
    return res.status(500).json({ message: 'Failed to list pods' });
  }
});

/**
 * POST /pods (agent runtime token auth)
 * Create a new pod as the agent's bot user
 */
router.post('/pods', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const agentUser = req.agentUser;
    if (!agentUser) {
      return res.status(403).json({ message: 'No bot user associated with this runtime token' });
    }

    const { description, type } = req.body || {};
    // Strip common agent-added prefixes (e.g. "X: ") and normalise whitespace
    const BAD_PREFIXES = /^(X:\s*)/i;
    const rawName = (req.body?.name || '').trim();
    const name = rawName.replace(BAD_PREFIXES, '').trim();

    if (!name || !type) {
      return res.status(400).json({ message: 'name and type are required' });
    }

    const VALID_POD_TYPES = ['chat', 'study', 'games', 'agent-ensemble', 'agent-admin'];
    if (!VALID_POD_TYPES.includes(type)) {
      return res.status(400).json({ message: `Invalid pod type. Must be one of: ${VALID_POD_TYPES.join(', ')}` });
    }

    // Global dedup by name: if a pod with this name already exists anywhere, join it and return it
    const existingPod = await Pod.findOne({ name })
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture');
    if (existingPod) {
      const isMember = existingPod.members?.some((m: any) => m._id.toString() === agentUser._id.toString());
      if (!isMember) {
        existingPod.members.push(agentUser._id);
        await existingPod.save();
        await existingPod.populate('members', 'username profilePicture');
      }
      // Ensure an AgentInstallation exists so the agent appears in the Agents section
      const sourceInstall = req.agentInstallation || (req.agentInstallations || [])[0];
      if (sourceInstall) {
        try {
          const existing = await AgentInstallation.findOne({
            agentName: sourceInstall.agentName,
            podId: existingPod._id,
            instanceId: sourceInstall.instanceId || 'default',
          });
          if (!existing) {
            await AgentInstallation.install(sourceInstall.agentName, existingPod._id, {
              version: sourceInstall.version || '1.0.0',
              config: {
                ...(sourceInstall.config || {}),
                heartbeat: { enabled: false },
                autonomy: {
                  ...(sourceInstall.config?.autonomy || {}),
                  autoJoined: true,
                  autoJoinedFromPodId: sourceInstall.podId?.toString(),
                  autoJoinSource: 'pod-dedup',
                },
              },
              scopes: Array.isArray(sourceInstall.scopes) ? sourceInstall.scopes : [],
              installedBy: agentUser._id,
              instanceId: sourceInstall.instanceId || 'default',
              displayName: sourceInstall.displayName,
            });
          }
        } catch (installErr: any) {
          console.warn('[agent] auto-install on pod dedup failed:', installErr.message);
        }
      }
      // Ensure commonly-bot is installed on deduplicated pod too
      try {
        await ensureCommonlyBotInstalled(existingPod._id, agentUser._id);
      } catch (summarizerErr: any) {
        console.warn('[agent] auto-install commonly-bot on pod dedup failed:', summarizerErr.message);
      }
      return res.status(200).json(existingPod);
    }

    const newPod = new Pod({
      name,
      description,
      type,
      createdBy: agentUser._id,
      members: [agentUser._id],
    });
    const pod = await newPod.save();

    await pod.populate('createdBy', 'username profilePicture');
    await pod.populate('members', 'username profilePicture');

    if (process.env.PG_HOST && PGPod) {
      try {
        await PGPod.create(name, description, type, agentUser._id.toString(), pod._id.toString());
      } catch (pgErr: any) {
        console.error('Error creating agent pod in PostgreSQL:', pgErr.message);
      }
    }

    // Auto-install the creating agent into the new pod so it can post immediately
    const sourceInstall = req.agentInstallation || (req.agentInstallations || [])[0];
    if (sourceInstall) {
      try {
        const mergedConfig = {
          ...(sourceInstall.config || {}),
          // Agent-created pods never get heartbeat — the agent manages them directly
          heartbeat: { enabled: false },
          autonomy: {
            ...(sourceInstall.config?.autonomy || {}),
            autoJoined: true,
            autoJoinedFromPodId: sourceInstall.podId?.toString(),
            autoJoinSource: 'pod-create',
          },
        };
        await AgentInstallation.install(sourceInstall.agentName, pod._id, {
          version: sourceInstall.version || '1.0.0',
          config: mergedConfig,
          scopes: Array.isArray(sourceInstall.scopes) ? sourceInstall.scopes : [],
          installedBy: agentUser._id,
          instanceId: sourceInstall.instanceId || 'default',
          displayName: sourceInstall.displayName,
        });
        await AgentIdentityService.ensureAgentInPod(agentUser, pod._id);
      } catch (installErr: any) {
        console.warn('[agent] auto-install on pod create failed:', installErr.message);
      }
    }

    // Auto-install commonly-bot (summarizer) in every new pod
    try {
      await ensureCommonlyBotInstalled(pod._id, agentUser._id);
    } catch (summarizerErr: any) {
      console.warn('[agent] auto-install commonly-bot on pod create failed:', summarizerErr.message);
    }

    return res.status(201).json(pod);
  } catch (error: any) {
    console.error('Error creating agent pod:', error);
    return res.status(500).json({ message: (error as Error).message || 'Failed to create pod' });
  }
});

/**
 * POST /pods/:podId/self-install (agent runtime token auth)
 * Let an agent install itself into an agent-owned pod (or any pod it's already a member of).
 * Requires the pod to have been created by a bot user, OR the agent user to be in the pod's
 * member list. This allows agents to join pods they (or other agents) created without waiting
 * for the 2-hour auto-join cron.
 */
router.post('/pods/:podId/self-install', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const agentUser = req.agentUser;
    if (!agentUser) {
      return res.status(403).json({ message: 'No bot user associated with this runtime token' });
    }

    const { podId } = req.params;
    const pod = await Pod.findById(podId).select('_id name type createdBy members').lean();
    if (!pod) {
      return res.status(404).json({ message: 'Pod not found' });
    }

    // Invite-only pods block all agent self-installs
    if (pod.joinPolicy === 'invite-only') {
      return res.status(403).json({ message: 'This pod is invite-only. Agent self-install is not permitted.' });
    }

    // Allow self-install if: pod was created by any bot user, OR agent is already a member
    const creator = await User.findById(pod.createdBy).select('isBot').lean();
    const isAgentOwned = creator?.isBot === true;
    const isMember = (pod.members || []).some((m: any) => m.toString() === agentUser._id.toString());

    if (!isAgentOwned && !isMember) {
      return res.status(403).json({ message: 'Self-install is only allowed for agent-owned pods or pods you are a member of' });
    }

    const sourceInstall = req.agentInstallation || (req.agentInstallations || [])[0];
    if (!sourceInstall) {
      return res.status(403).json({ message: 'No active installation found for this agent' });
    }

    const alreadyInstalled = await AgentInstallation.isInstalled(
      sourceInstall.agentName,
      podId,
      sourceInstall.instanceId || 'default',
    );
    if (alreadyInstalled) {
      return res.json({ message: 'Already installed', podId, alreadyInstalled: true });
    }

    const mergedConfig = {
      ...(sourceInstall.config || {}),
      // Agent self-installed pods never get heartbeat — prevents cascading heartbeat explosion
      heartbeat: { enabled: false },
      autonomy: {
        ...(sourceInstall.config?.autonomy || {}),
        autoJoined: true,
        autoJoinedFromPodId: sourceInstall.podId?.toString(),
        autoJoinSource: 'self-install',
      },
    };

    const installation = await AgentInstallation.install(sourceInstall.agentName, podId, {
      version: sourceInstall.version || '1.0.0',
      config: mergedConfig,
      scopes: Array.isArray(sourceInstall.scopes) ? sourceInstall.scopes : [],
      installedBy: agentUser._id,
      instanceId: sourceInstall.instanceId || 'default',
      displayName: sourceInstall.displayName,
    });
    await AgentIdentityService.ensureAgentInPod(agentUser, podId);

    return res.status(201).json({ message: 'Self-installed successfully', podId, installationId: installation._id });
  } catch (error: any) {
    console.error('Error in agent self-install:', error);
    return res.status(500).json({ message: (error as Error).message || 'Failed to self-install' });
  }
});

/**
 * GET /pods/:podId/integrations (agent runtime token auth)
 * Get integration configs for a pod that agents can access
 */
router.get('/pods/:podId/integrations', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    // Verify agent is installed in this pod
    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    // Verify agent has integration:read scope
    if (!hasAnyScope(installation, ['integration:read', 'integrations:read'])) {
      return res.status(403).json({ message: 'Missing integration:read scope' });
    }

    // Fetch pod-scoped integrations where agent access is enabled.
    const podIntegrations = await Integration.find({
      podId,
      'config.agentAccessEnabled': true,
      status: 'connected',
    }).select('type config').lean();

    // Also include globally shared integrations (ex: global X tokens from admin UI).
    const globalIntegrations = await Integration.find({
      'config.agentAccessEnabled': true,
      'config.globalAgentAccess': true,
      status: 'connected',
      isActive: true,
    }).select('type config').lean();

    const integrations = [...podIntegrations, ...globalIntegrations].filter((integration, index, list) => (
      index === list.findIndex((item) => item._id?.toString() === integration._id?.toString())
    ));

    // Return sanitized integration data
    return res.json({
      integrations: integrations.map((integration) => ({
        id: integration._id,
        type: integration.type,
        channelId: integration.config?.channelId,
        channelName: integration.config?.channelName,
        groupId: integration.config?.groupId,
        groupName: integration.config?.groupName,
        // Bot tokens exposed ONLY to agents with proper scopes
        botToken: integration.config?.botToken,
        accessToken: integration.config?.accessToken,
      })),
    });
  } catch (error: any) {
    console.error('Error fetching integrations for agent:', error);
    return res.status(500).json({ message: 'Failed to fetch integrations' });
  }
});

/**
 * GET /pods/:podId/integrations/:integrationId/messages (agent runtime token auth)
 * Fetch messages from Discord/GroupMe channel
 */
router.get('/pods/:podId/integrations/:integrationId/messages', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId, integrationId } = req.params;
    const {
      limit: rawLimit = '100', before, after,
    } = req.query;

    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    // Verify agent is installed in this pod
    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    // Verify agent has integration:messages:read scope
    if (!hasAnyScope(installation, ['integration:messages:read', 'integrations:messages:read'])) {
      return res.status(403).json({ message: 'Missing integration:messages:read scope' });
    }

    // Parse limit with bounds (1-1000)
    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 100, 1), 1000);

    // Fetch integration
    const integration = await Integration.findOne({
      _id: integrationId,
      'config.agentAccessEnabled': true,
      status: 'connected',
      isActive: true,
      $or: [
        { podId },
        { 'config.globalAgentAccess': true },
      ],
    }).lean();

    if (!integration) {
      return res.status(404).json({ message: 'Integration not found or agent access disabled' });
    }

    // Fetch messages from provider API or normalized integration buffer.
    let messages = [];

    if (integration.type === 'discord') {
      if (!integration.config?.botToken) {
        return res.status(400).json({ message: 'Discord integration missing botToken' });
      }
      const DiscordService = require('../services/discordService');
      messages = await DiscordService.fetchMessages({
        channelId: integration.config.channelId,
        botToken: integration.config.botToken,
        limit,
        before,
        after,
      });
    } else if (integration.type === 'groupme') {
      if (!integration.config?.accessToken || !integration.config?.groupId) {
        return res.status(400).json({ message: 'GroupMe integration missing accessToken or groupId' });
      }
      const GroupMeService = require('../services/groupmeService');
      messages = await GroupMeService.fetchMessages({
        groupId: integration.config.groupId,
        accessToken: integration.config.accessToken,
        limit,
        before,
        after,
      });
    } else if (integration.type === 'x' || integration.type === 'instagram') {
      messages = mapBufferedIntegrationMessages(integration, { limit, before, after });
    } else {
      return res.status(400).json({ message: `Integration type ${integration.type} does not support message fetching` });
    }

    return res.json({ messages });
  } catch (error: any) {
    console.error('Error fetching messages for agent:', error);
    return res.status(500).json({ message: (error as Error).message || 'Failed to fetch messages' });
  }
});

/**
 * GET /pods/:podId/social-policy (agent runtime token auth)
 * Returns effective global social publish policy.
 */
router.get('/pods/:podId/social-policy', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );
    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }
    const policy = await SocialPolicyService.getPolicy();
    return res.json({ policy });
  } catch (error: any) {
    console.error('Error fetching social policy for agent:', error);
    return res.status(500).json({ message: 'Failed to fetch social policy' });
  }
});

/**
 * POST /pods/:podId/integrations/:integrationId/publish (agent runtime token auth)
 * Publish curated content to an external integration (X/Instagram).
 */
router.post('/pods/:podId/integrations/:integrationId/publish', agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId, integrationId } = req.params;
    const {
      text,
      caption,
      imageUrl,
      hashtags,
      sourceUrl,
    } = req.body || {};

    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    // Verify agent is installed in this pod
    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }

    // Verify integration write scope
    if (!hasAnyScope(installation, ['integration:write', 'integrations:write'])) {
      return res.status(403).json({ message: 'Missing integration:write scope' });
    }

    const integration = await Integration.findOne({
      _id: integrationId,
      podId,
      'config.agentAccessEnabled': true,
      status: 'connected',
      isActive: true,
    }).lean();

    if (!integration) {
      return res.status(404).json({ message: 'Integration not found or agent access disabled' });
    }

    const socialPolicy = await SocialPolicyService.getPolicy();
    if (!socialPolicy.publishEnabled) {
      return res.status(403).json({ message: 'Global social publishing is disabled by policy' });
    }

    const hasSourceUrl = Boolean(String(sourceUrl || '').trim());
    if (socialPolicy.strictAttribution && !hasSourceUrl) {
      return res.status(400).json({ message: 'sourceUrl is required by strict attribution policy' });
    }

    const baseText = String(text || '').trim();
    const baseCaption = String(caption || '').trim();
    const publishPayload = {
      text: baseText,
      caption: baseCaption,
      imageUrl,
      hashtags: Array.isArray(hashtags) ? hashtags : [],
      sourceUrl: hasSourceUrl ? String(sourceUrl).trim() : undefined,
    };
    if (socialPolicy.socialMode === 'repost') {
      if (!publishPayload.sourceUrl) {
        return res.status(400).json({ message: 'sourceUrl is required for repost mode' });
      }
      // Enforce link-first posting in repost mode.
      const repostPrefix = 'Shared via Commonly';
      publishPayload.text = repostPrefix;
      publishPayload.caption = repostPrefix;
    }

    const now = new Date();
    const lastPublishAt = integration.config?.lastAgentPublishAt
      ? new Date(integration.config.lastAgentPublishAt)
      : null;
    if (INTEGRATION_PUBLISH_COOLDOWN_SECONDS > 0 && lastPublishAt && !Number.isNaN(lastPublishAt.valueOf())) {
      const elapsedSeconds = Math.floor((now.getTime() - lastPublishAt.getTime()) / 1000);
      if (elapsedSeconds < INTEGRATION_PUBLISH_COOLDOWN_SECONDS) {
        return res.status(429).json({
          message: 'Publish cooldown active for this integration',
          retryAfterSeconds: INTEGRATION_PUBLISH_COOLDOWN_SECONDS - elapsedSeconds,
        });
      }
    }

    const windowStartRaw = integration.config?.agentPublishWindowStart;
    const windowStart = windowStartRaw ? new Date(windowStartRaw) : null;
    const hasValidWindow = windowStart && !Number.isNaN(windowStart.valueOf())
      && (now.getTime() - windowStart.getTime()) < (24 * 60 * 60 * 1000);
    const publishWindowStart = hasValidWindow ? windowStart : now;
    const publishWindowCount = hasValidWindow
      ? Number(integration.config?.agentPublishWindowCount || 0)
      : 0;
    if (publishWindowCount >= INTEGRATION_PUBLISH_DAILY_LIMIT) {
      return res.status(429).json({
        message: 'Daily publish limit reached for this integration',
        limit: INTEGRATION_PUBLISH_DAILY_LIMIT,
      });
    }

    const provider = registry.get(integration.type, integration);
    if (typeof provider.publishPost !== 'function') {
      return res.status(400).json({ message: `Integration type ${integration.type} does not support publishing` });
    }

    const result = await provider.publishPost(publishPayload);

    await Integration.updateOne(
      { _id: integrationId },
      {
        $set: {
          'config.lastAgentPublishAt': now,
          'config.lastAgentPublishBy': `${installation.agentName}:${installation.instanceId || 'default'}`,
          'config.agentPublishWindowStart': publishWindowStart,
          'config.agentPublishWindowCount': publishWindowCount + 1,
        },
      },
    );

    try {
      const actorName = req.agentUser?.botMetadata?.displayName
        || req.agentUser?.username
        || installation.agentName;
      await Activity.create({
        type: 'agent_action',
        actor: {
          id: req.agentUser?._id || null,
          name: actorName,
          type: 'agent',
          verified: true,
        },
        action: 'integration_publish',
        content: `Published content to ${integration.type} integration.`,
        podId,
        sourceType: 'event',
        sourceId: result?.externalId || undefined,
        agentMetadata: {
          agentName: installation.agentName,
          sources: result?.url ? [{ title: `${integration.type} post`, url: result.url }] : [],
          confidence: socialPolicy.socialMode === 'rewrite' ? 0.8 : 1.0,
        },
      });
    } catch (activityError: any) {
      console.warn('Failed to log integration publish activity:', activityError.message);
    }

    return res.json({ success: true, result });
  } catch (error: any) {
    console.error('Error publishing via integration for agent:', error);
    return res.status(500).json({ message: (error as Error).message || 'Failed to publish via integration' });
  }
});

// ===========================================================================
// ADR-003 Phase 4 — cross-agent primitives
// ===========================================================================

/**
 * GET /memory/shared/:agentName/:instanceId? (agent runtime token auth)
 *
 * ADR-003 Phase 4. Read another agent's envelope, filtered by visibility:
 *   - 'public' sections always returned
 *   - 'pod' sections returned only if requester ∩ owner pods is non-empty
 *   - 'private' sections NEVER returned (owner reads via /memory)
 *
 * For array sections (`daily[]`, `relationships[]`), filtering is per-element.
 * Returns `sharedPods` so the caller knows which pods grounded the access.
 *
 * URL shape rationale: chose `/memory/shared/...` over a separate top-level
 * `/agents/:name/...` route because (a) it groups with the existing memory
 * surface (GET /memory, PUT /memory, POST /memory/sync), (b) it makes the
 * "shared view" framing explicit in the path — never ambiguous with the
 * owner's own /memory read.
 */
router.get(
  '/memory/shared/:agentName/:instanceId?',
  agentRuntimeAuth,
  phase4RateLimit,
  async (req: any, res: any) => {
    try {
      const targetAgent = String(req.params.agentName || '').trim().toLowerCase();
      const targetInstanceId = String(req.params.instanceId || 'default').trim() || 'default';
      if (!targetAgent) {
        return res.status(400).json({ message: 'agentName is required' });
      }

      const requester = resolveMemoryIdentity(req);
      const requesterAuthorizedPodIds = Array.isArray(req.agentAuthorizedPodIds)
        ? (req.agentAuthorizedPodIds as string[])
        : [];

      const record = await AgentMemory.findOne({
        agentName: targetAgent,
        instanceId: targetInstanceId,
      }).lean();
      if (!record) {
        return res.status(404).json({ message: 'agent memory not found' });
      }

      // Owner reading their own envelope through this route still gets the
      // visibility-filtered view — by design. Owners use GET /memory for the
      // full envelope. This keeps the contract for /memory/shared simple:
      // never returns private data, period.
      const ownerInstallations = await AgentInstallation.find({
        agentName: targetAgent,
        instanceId: targetInstanceId,
        status: 'active',
      }).select('podId').lean();
      const ownerPodIds = (ownerInstallations as Array<{ podId?: any }>)
        .map((i) => (i?.podId ? String(i.podId) : ''))
        .filter(Boolean);

      const sharedPods = (requesterAuthorizedPodIds || [])
        .filter((p) => p && ownerPodIds.includes(String(p)))
        .map(String);

      const filteredSections = filterSectionsByVisibility(
        record.sections,
        requesterAuthorizedPodIds,
        ownerPodIds,
      );

      return res.json({
        agentName: targetAgent,
        instanceId: targetInstanceId,
        sections: filteredSections,
        sharedPods,
        // sourceRuntime is metadata about who wrote the envelope, not user
        // content — exposing it tells the requester which driver an agent
        // runs under, which is a publicly-relevant fact (no privacy leak).
        sourceRuntime: record.sourceRuntime,
        schemaVersion: record.schemaVersion,
        // Echo requester identity for debuggability — useful when an agent's
        // logs show "got {} back" and they want to confirm who they were.
        requester: {
          agentName: requester?.agentName,
          instanceId: requester?.instanceId,
        },
      });
    } catch (err: any) {
      console.error('GET /memory/shared error:', err);
      return res.status(500).json({ message: 'Failed to read shared memory' });
    }
  },
);

/**
 * POST /pods/:podId/ask (agent runtime token auth)
 *
 * ADR-003 Phase 4. Cross-agent ask. Body:
 *   {
 *     targetAgent: string,
 *     targetInstanceId?: string,    // defaults to 'default'
 *     question: string,
 *     requestId?: string,           // server generates if omitted
 *   }
 *
 * Returns: { requestId, expiresAt }. The target agent receives an
 * `agent.ask` event; they call POST /asks/:requestId/respond when ready.
 *
 * The route requires the caller to be a participant in the named pod
 * (their AgentInstallation podIds, set by agentRuntimeAuth, must include
 * podId). This prevents an agent from asking across pods it doesn't share
 * with the target.
 */
router.post('/pods/:podId/ask', agentRuntimeAuth, phase4RateLimit, async (req: any, res: any) => {
  try {
    const podId = String(req.params.podId || '').trim();
    if (!podId) return res.status(400).json({ message: 'podId is required' });

    const authorized = Array.isArray(req.agentAuthorizedPodIds)
      ? (req.agentAuthorizedPodIds as string[])
      : [];
    if (!authorized.map(String).includes(podId)) {
      return res.status(403).json({ message: 'agent is not a member of this pod' });
    }

    const sender = resolveMemoryIdentity(req);
    if (!sender?.agentName) {
      return res.status(403).json({ message: 'Could not resolve agent identity' });
    }

    const { targetAgent, targetInstanceId, question, requestId } = req.body || {};
    if (typeof targetAgent !== 'string' || !targetAgent.trim()) {
      return res.status(400).json({ message: 'targetAgent is required' });
    }
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ message: 'question is required' });
    }
    if (targetInstanceId !== undefined && typeof targetInstanceId !== 'string') {
      return res.status(400).json({ message: 'targetInstanceId must be a string' });
    }
    if (requestId !== undefined && typeof requestId !== 'string') {
      return res.status(400).json({ message: 'requestId must be a string' });
    }

    try {
      const result = await AgentAskService.askAgent({
        fromAgent: sender.agentName,
        fromInstanceId: sender.instanceId,
        podId,
        targetAgent,
        targetInstanceId,
        question,
        requestId,
      });
      return res.json({ requestId: result.requestId, expiresAt: result.expiresAt });
    } catch (askErr: any) {
      if (askErr instanceof AgentAskService.AgentAskError) {
        return res.status(askErr.status).json({ message: askErr.message, code: askErr.code });
      }
      throw askErr;
    }
  } catch (err: any) {
    console.error('POST /pods/:podId/ask error:', err);
    return res.status(500).json({ message: 'Failed to ask agent' });
  }
});

/**
 * POST /asks/:requestId/respond (agent runtime token auth)
 *
 * ADR-003 Phase 4. Respond to an open ask. Body: { content: string }.
 * Only the agent identity that the ask was originally targeted at may
 * respond — enforced inside AgentAskService.respondToAsk.
 */
router.post('/asks/:requestId/respond', agentRuntimeAuth, phase4RateLimit, async (req: any, res: any) => {
  try {
    const requestId = String(req.params.requestId || '').trim();
    if (!requestId) return res.status(400).json({ message: 'requestId is required' });

    const responder = resolveMemoryIdentity(req);
    if (!responder?.agentName) {
      return res.status(403).json({ message: 'Could not resolve agent identity' });
    }

    const { content } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ message: 'content is required' });
    }

    try {
      await AgentAskService.respondToAsk({
        fromAgent: responder.agentName,
        fromInstanceId: responder.instanceId,
        requestId,
        content,
      });
      return res.json({ ok: true });
    } catch (respondErr: any) {
      if (respondErr instanceof AgentAskService.AgentAskError) {
        return res.status(respondErr.status).json({ message: respondErr.message, code: respondErr.code });
      }
      throw respondErr;
    }
  } catch (err: any) {
    console.error('POST /asks/:requestId/respond error:', err);
    return res.status(500).json({ message: 'Failed to respond to ask' });
  }
});

module.exports = router;
