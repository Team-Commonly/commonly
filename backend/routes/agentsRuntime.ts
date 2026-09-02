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
const HostedRuntimeMeter = require('../services/hostedRuntimeService');
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
const File = require('../models/File');
const { getObjectStore } = require('../services/objectStore');
const { requireApiTokenScopes } = require('../middleware/apiTokenScopes');
const { isGlobalAdminUser } = require('./registry/helpers');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { agentRateLimitKeyGenerator } = require('../middleware/agentRateLimit');

// ADR-003 Phase 4: per-token rate limiter for the cross-agent surface.
// Token-global (covers any pod the token is valid for). Complementary to the
// per-(agent,podId) limit in agentAskService; this is the outer DoS bound.
// 120/60s = generous for legitimate polling, low enough that a compromised
// token can't drain DB read capacity.
//
// Inlined here (not behind a factory) rather than shared from a middleware
// module — that part is fine and worth keeping.
//
// What this comment used to claim is not: that CodeQL's
// `js/missing-rate-limiting` query "only recognises direct express-rate-limit
// invocations in the same file as the route registration." That is refuted by
// the routes below. `/memory` and `/memory/sync` follow the recipe exactly —
// limiter declared in this file, applied inline — and both carry open
// high-severity alerts. The belief also spread from here into
// registry/{install,provision,files}.ts.
//
// The discriminator is ORDER, not location. The query anchors to the first
// middleware in the chain; `agentRuntimeAuth` does a Mongo lookup, so a
// limiter placed after it leaves that lookup unprotected and the route
// flagged. Cross-tab against main on 2026-08-04: ~37 routes with the limiter
// before auth, none flagged; 9 with it after, 6 flagged — including every
// `agentRuntimeAuth, phase4RateLimit` route in this file.
//
// The routes below are therefore genuinely under-protected, not
// false-positived. The fix is to move phase4RateLimit ahead of
// agentRuntimeAuth on each.
//
// That is safe, and agentRateLimitKeyGenerator was already built for it:
// its first branch reads `req.agentTokenHash` (set by agentRuntimeAuth, so
// post-auth only), but it falls through to a sha256 of the Authorization /
// x-commonly-agent-token header, which is present before any middleware
// runs. Running the limiter first just takes the header branch — same
// per-caller isolation, different key prefix. No key-generator change needed.
//
// Not done in this PR only because it is 8 route registrations in a
// different subsystem from the one this PR fixes, and it deserves its own
// diff. It is specified, not blocked.
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

// Dual-auth dispatcher (mirrors `backend/routes/tasksApi.ts:34-36`). Routes
// that accept BOTH human JWTs and agent runtime tokens use this — the token
// prefix distinguishes the two. `cm_agent_*` → `agentRuntimeAuth` (stamps
// `req.agentUser`), anything else → `auth` (stamps `req.userId`/`req.user`).
//
// Both `Authorization: Bearer <token>` and `x-commonly-agent-token: <token>`
// are checked because `agentRuntimeAuth` accepts either; missing one would
// silently route the alternate-header caller to the human path and 401.
//
// Per ADR-010, MCP tools wrap routes the agent runtime token can already
// authenticate against; for `/room` (the agent-room endpoint) that means
// adding the agent path without breaking the existing human path.
const dualAuth = (req: any, res: any, next: any) => {
  const bearer = ((req.header?.('Authorization') || '').replace('Bearer ', '')).trim();
  const altHeader = (req.header?.('x-commonly-agent-token') || '').trim();
  const token = bearer || altHeader;
  if (token.startsWith('cm_agent_')) return agentRuntimeAuth(req, res, next);
  return auth(req, res, next);
};

const Integration = require('../models/Integration');
const AgentMemory = require('../models/AgentMemory');
const {
  mirrorContentFromSections,
  stampSectionsForWrite,
  decorateSectionsWithProvenance,
  mergePatchSections,
  computeSyncDedupKey,
  isValidYMD,
  filterSectionsByVisibility,
  appendCycle,
  describeCycleMutation,
} = require('../services/agentMemoryService');
const AgentAskService = require('../services/agentAskService');
const DecisionRequestService = require('../services/decisionRequestService');
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

const { stripInlineAvatars } = require('../services/avatarService');
const { DIRECTLY_JOINABLE_QUERY } = require('../services/podListing');

const router = express.Router();

// Every response on this router is bound for an agent's context window, so no
// inline base64 avatar may ride along. Enforcing it here rather than at each
// handler is deliberate: the leak was spread across getRecentMessages, the
// post-message echo, thread comments and the create-pod member list, there is
// no shared user serializer to fix instead, and a per-handler fix would not
// cover the next endpoint someone adds. Measured before this: a 20-message
// read returned 230,170 chars, 71% of it image data (#758).
//
// Only `data:` values are dropped — URLs are cheap and stay useful. The
// original objects are never mutated, because the same message object is
// reused for the human-facing Socket.io broadcast where avatars ARE rendered.
router.use((_req: any, res: any, next: any) => {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => originalJson(stripInlineAvatars(body));
  next();
});
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

// Moved to services/agentPodScope so the service layer can enforce pod scope
// with the SAME implementation the routes use. It had zero tests while gating
// 9 routes; propose-action made it load-bearing for a consent surface, and a
// consent gate that only a route can call is a gate only a route can test.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensurePodMatch, resolveInstallationForPod } = require('../services/agentPodScope');

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
/**
 * ADR-018 attention claims. POST claims-or-renews (one CAS — a holder wins
 * against itself, which IS renewal); DELETE releases. The kernel never
 * refuses an unclaimed post (D3): these routes only arbitrate the lease.
 * Pod membership is checked the same way posting is — an active
 * AgentInstallation — so an agent cannot claim its way into rooms it is
 * not in.
 */
const resolveClaimIdentity = (req: any) => ({
  agentName: String(
    req.agentInstallation?.agentName
    || req.agentUser?.botMetadata?.agentName
    || req.agentUser?.username || '',
  ).toLowerCase(),
  instanceId: String(
    req.agentInstallation?.instanceId
    || req.agentUser?.botMetadata?.instanceId || 'default',
  ),
});

router.post('/messages/:messageId/claim', agentRuntimeAuth, phase4RateLimit, async (req: any, res: any) => {
  try {
    const { agentName, instanceId } = resolveClaimIdentity(req);
    const podId = String(req.body?.podId || '');
    if (!agentName || !podId) return res.status(400).json({ error: 'agentName and podId are required' });
    const installed = await AgentInstallation.findOne({ agentName, podId, status: 'active' });
    if (!installed) return res.status(403).json({ error: 'no active installation in this pod' });
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const MessageClaimService = require('../services/messageClaimService');
    const result = await MessageClaimService.claim({
      messageId: req.params.messageId,
      podId,
      agentName,
      instanceId,
      leaseSeconds: req.body?.leaseSeconds,
    });
    // ADR-018 D7: a won (or renewed) claim IS "someone's on it" — surface it
    // through the typing indicator humans already read that way, for exactly
    // the life of the lease. No new UI, no new event type. Best-effort: a
    // socket hiccup must never fail the claim itself.
    if (result?.claimed) {
      try {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const agentTypingService = require('../services/agentTypingService');
        const leaseMs = result.expiresAt
          ? new Date(result.expiresAt).getTime() - Date.now()
          : undefined;
        agentTypingService.emitAgentTypingStart({
          podId,
          agentName,
          instanceId,
          displayName: req.agentInstallation?.displayName
            || req.agentUser?.botMetadata?.displayName
            || agentName,
        }, leaseMs);
      } catch (typingErr) {
        console.warn('[claims] typing indicator failed:', (typingErr as Error).message);
      }
    }
    return res.json(result);
  } catch (err) {
    console.error('[claims] claim failed:', (err as Error).message);
    return res.status(500).json({ error: 'claim_failed' });
  }
});

router.delete('/messages/:messageId/claim', agentRuntimeAuth, phase4RateLimit, async (req: any, res: any) => {
  try {
    const { agentName, instanceId } = resolveClaimIdentity(req);
    if (!agentName) return res.status(400).json({ error: 'agent identity unresolved' });
    const outcome = req.body?.outcome;
    if (outcome !== undefined && outcome !== 'declined' && outcome !== 'completed') {
      return res.status(400).json({ error: 'outcome must be declined or completed' });
    }
    // An explicit decline advances a human wake to exactly one original
    // listener. Completion is terminal; omitting outcome retains the legacy
    // holder-only DELETE for old drivers and failed turns.
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const ClaimReleaseService = outcome === 'declined'
      ? require('../services/messageClaimHandoffService')
      : require('../services/messageClaimService');
    const result = await ClaimReleaseService.release({
      messageId: req.params.messageId, agentName, instanceId, ...(outcome ? { outcome } : {}),
    });
    // D7 mirror: releasing the lease ends "someone's on it" immediately
    // (claim-then-decline is a normal, frequent path per D6 — the indicator
    // must not linger through the lease timeout after an explicit release).
    if (result?.released && result.podId) {
      try {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const agentTypingService = require('../services/agentTypingService');
        agentTypingService.emitAgentTypingStop({ podId: result.podId, agentName, instanceId });
      } catch (typingErr) {
        console.warn('[claims] typing stop failed:', (typingErr as Error).message);
      }
    }
    return res.json(result);
  } catch (err) {
    console.error('[claims] release failed:', (err as Error).message);
    return res.status(500).json({ error: 'release_failed' });
  }
});

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

    // Hosted-runtime meter (ADR-023 D3.1): once a hosted agent has used its
    // daily turn budget the feed goes empty for it — the worker idles instead
    // of spending. Events stay pending and deliver after the UTC reset.
    if (installation && HostedRuntimeMeter.isHostedInstallation(installation)) {
      const meter = await HostedRuntimeMeter.meterAllowsTurn(agentName, instanceId);
      if (!meter.allowed) {
        return res.json({ events: [], meter });
      }
    }

    const { events, inboxCount } = await AgentEventService.listInboxPage({
      agentName,
      instanceId,
      podId: fallbackPodId,
      podIds,
      limit,
    });

    // Fire the typing indicator now — at gateway-fetch time, not
    // backend-enqueue time. The chat header shows "X is thinking…"
    // only while the gateway is actually processing the event in real
    // time, so it tracks real LLM work instead of a queued promise
    // that may never run.
    if (Array.isArray(events) && events.length > 0) {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const { signalAgentTyping } = require('../services/agentEventService');
      for (const ev of events) {
        // Best-effort, fire-and-forget — typing is cosmetic.
        Promise.resolve(signalAgentTyping(ev)).catch(() => null);
      }
    }

    return res.json({ events, inboxCount });
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
 * Dual-auth (ADR-010 Phase 1):
 *   - Human path (JWT): existing semantics — caller must be the agent's
 *     installer or a member of an installed pod, then opens a human↔agent
 *     room with the target agent.
 *   - Agent path (`cm_agent_*` runtime token): caller is identified by the
 *     token's resolved User row (`req.agentUser`). No installation match
 *     required — any agent can open a 1:1 with any other agent. The 1:1
 *     invariant in `getOrCreateAgentRoom` is the correctness guard, and the
 *     only side effect is a new pod with two agent members. Self-DMs are
 *     refused because they would degenerate the 1:1.
 *
 * Request: { agentName, instanceId?, podId? }
 * Response: { room: Pod }
 */
router.post('/room', dualAuth, phase4RateLimit, async (req: any, res: any) => {
  try {
    // Agent-initiated path — caller authorized purely by their runtime token.
    // `agentRuntimeAuth` populates `req.agentUser` for User-row tokens
    // (`User.agentRuntimeTokens`) but NOT for the legacy installation-token
    // path (`AgentInstallation.runtimeTokens`, line 119-122 in the middleware).
    // For Phase 1 we resolve the missing User row from the installation's
    // (agentName, instanceId) so both shapes work.
    let callerAgentUser = req.agentUser;
    if (!callerAgentUser && req.agentInstallation) {
      callerAgentUser = await AgentIdentityService.getOrCreateAgentUser(
        req.agentInstallation.agentName,
        { instanceId: req.agentInstallation.instanceId || 'default' },
      );
    }
    const callerAgentUserId = callerAgentUser?._id;
    if (callerAgentUserId) {
      const {
        agentName: rawAgentName,
        instanceId: rawInstanceId,
      } = req.body || {};
      // Sanitize agent identity from the request body via the strip-then-
      // compare pattern CodeQL recognises as a SqlSanitizer for js/sql-injection
      // (same shape as routes/registry/install.ts). Usernames are [a-z0-9-],
      // instanceIds [a-z0-9-]; anything else is invalid input, not one of our
      // agents.
      const agentName = String(rawAgentName || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      const instanceId = (String(rawInstanceId || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '')) || 'default';
      if (!agentName) {
        return res.status(400).json({ message: 'agentName is required' });
      }

      // Resolve the target agent WITHOUT upserting — a misspelled or made-up
      // agentName must 404, not materialise a ghost bot User row (unbounded
      // User-table pollution from a leaked token). Only real, already-existing
      // agents are DM-able.
      const targetUsername = String(AgentIdentityService.buildAgentUsername(agentName, instanceId))
        .replace(/[^a-z0-9-]/g, '');
      const targetAgentUser = await User.findOne({ username: targetUsername, isBot: true }).select('_id');
      if (!targetAgentUser) {
        return res.status(404).json({ message: 'target agent not found' });
      }

      if (String(targetAgentUser._id) === String(callerAgentUserId)) {
        return res.status(400).json({ message: 'Cannot DM yourself' });
      }

      // §3.7 co-pod-member rule — an agent may only open a DM with another
      // agent it already shares a pod with. The /agent-dm route enforces this;
      // the /room agent path previously did not, letting any agent token DM
      // any agent (cross-tenant collaboration bypass).
      const shared = await DMService.sharePod(callerAgentUserId, targetAgentUser._id);
      if (!shared) {
        return res.status(403).json({
          message: 'No shared pod with target — refused per co-pod-member rule',
          rule: 'sharePod',
        });
      }

      const room = await DMService.getOrCreateAgentRoom(
        targetAgentUser._id,
        callerAgentUserId,
        { agentName, instanceId },
      );

      return res.json({ room });
    }

    // Human path — existing implementation, unchanged below this line.
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

    // Authorization: user must be installer or a member of an installed
    // pod. Global admins bypass — they can DM any agent for ops/debug
    // (the resulting agent-room is still strictly 1:1 between admin
    // and agent per ADR-001 §3.10, just as for regular pod members).
    const isAdmin = await isGlobalAdminUser(userId);
    const candidatePodIds = installations
      .map((i: any) => i.podId).filter(Boolean);
    const accessiblePods = await Pod.find({
      _id: { $in: candidatePodIds },
      members: userId,
    }).select('_id').lean();
    const accessibleSet = new Set(accessiblePods.map((p: any) => p._id.toString()));

    const authorized = isAdmin
      ? installations
      : installations.filter((i: any) => (
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
 * POST /agent-dm
 *
 * Open or fetch a 2-member `agent-dm` pod between the caller (an agent
 * runtime token) and a target agent. Generalization of `/room` for the
 * bot ↔ bot case; the §3.7 co-pod-member rule gates creation so we
 * don't grant arbitrary fan-out reach.
 *
 * Request: { target: { agentName, instanceId? } | { userId } | { alias }, originPodId? }
 * Response: { room, autoJoined: bool }
 */
router.post('/agent-dm', agentRuntimeAuth, phase4RateLimit, async (req: any, res: any) => {
  try {
    // Caller is the agent owning the runtime token.
    let callerAgentUser = req.agentUser;
    if (!callerAgentUser && req.agentInstallation) {
      callerAgentUser = await AgentIdentityService.getOrCreateAgentUser(
        req.agentInstallation.agentName,
        { instanceId: req.agentInstallation.instanceId || 'default' },
      );
    }
    if (!callerAgentUser) {
      return res.status(401).json({ message: 'Agent runtime token required' });
    }

    const { target, originPodId } = req.body || {};
    if (!target || typeof target !== 'object') {
      return res.status(400).json({ message: 'target is required' });
    }

    // Resolve the target User row. Accept three shapes:
    //   { agentName, instanceId? } → look up the bot User row directly.
    //   { userId }                 → human or already-resolved bot.
    //   { alias }                  → resolve via caller's contact list.
    let targetUser: { _id: unknown; isBot?: boolean; username?: string; botMetadata?: { agentName?: string; instanceId?: string } } | null = null;
    let targetMeta: { agentName?: string; instanceId?: string; displayName?: string; isBot: boolean } = { isBot: false };

    if (target.agentName) {
      const agentName = String(target.agentName).trim().toLowerCase();
      const instanceId = String(target.instanceId || 'default').trim();
      if (!agentName) return res.status(400).json({ message: 'target.agentName is empty' });
      // Probe before upsert. Without this, a typo materializes a permanent
      // ghost bot User row via getOrCreateAgentUser. Existence-check first
      // and 404 on miss; the legacy /room endpoint had the same pattern
      // and we explicitly choose stricter behavior on the new endpoint.
      const expectedUsername = AgentIdentityService.buildAgentUsername(agentName, instanceId);
      const existing = await User.findOne({
        $or: [
          { 'botMetadata.agentName': agentName, 'botMetadata.instanceId': instanceId },
          { username: expectedUsername },
        ],
      }).select('_id isBot username botMetadata').lean();
      if (!existing) {
        return res.status(404).json({
          message: `No agent found for ${agentName} (instance "${instanceId}"). Install the agent first.`,
          agentName,
          instanceId,
        });
      }
      // Resolve via the identity service so the User row is in canonical
      // shape (handles legacy bot rows that pre-date botMetadata).
      targetUser = await AgentIdentityService.getOrCreateAgentUser(agentName, { instanceId });
      // displayName resolution prefers the curated `botMetadata.displayName`
      // ("Pixel", "Strategist (Aria)") over the runtime-leaning agentName.
      // See `resolveAgentDisplayLabel` — same fallback every agent-display
      // surface should use to avoid "openclaw ↔ openclaw" pod names.
      targetMeta = {
        agentName,
        instanceId,
        displayName: AgentIdentityService.resolveAgentDisplayLabel(
          targetUser as { username?: string; botMetadata?: { displayName?: string; instanceId?: string; agentName?: string } } | null,
          agentName,
        ),
        isBot: true,
      };
    } else if (target.userId) {
      const lookup = await User.findById(String(target.userId)).select('_id isBot username botMetadata').lean();
      if (!lookup) return res.status(404).json({ message: 'target user not found' });
      targetUser = lookup as { _id: unknown; isBot?: boolean; username?: string; botMetadata?: { agentName?: string; instanceId?: string } };
      // For human targets `botMetadata` is empty — resolveAgentDisplayLabel
      // falls through to `username`, the right answer.
      targetMeta = {
        isBot: !!lookup.isBot,
        agentName: lookup.botMetadata?.agentName || undefined,
        instanceId: lookup.botMetadata?.instanceId || 'default',
        displayName: AgentIdentityService.resolveAgentDisplayLabel(
          lookup,
          lookup.username,
        ),
      };
    } else if (target.alias) {
      // §3.2: resolve via caller's own contacts. Pod-level binding takes
      // priority but only when an originPodId is given.
      const alias = String(target.alias).trim().toLowerCase();
      let bound: { agentName: string; instanceId: string } | null = null;
      // Coerce to string before findById so a malicious request body of
      // `{ originPodId: { $gt: '' } }` can't slip through Mongoose's
      // implicit object-as-query interpretation. CodeQL flagged this.
      const originPodIdStr = originPodId ? String(originPodId) : '';
      if (originPodIdStr) {
        const originPod = await Pod.findById(originPodIdStr).select('contacts members').lean();
        const fromPod = originPod?.contacts?.[alias];
        if (fromPod && fromPod.agentName) bound = { agentName: fromPod.agentName, instanceId: fromPod.instanceId || 'default' };
      }
      if (!bound) {
        const callerContacts = (callerAgentUser as { contacts?: Array<{ alias: string; agentName?: string; instanceId?: string }> }).contacts || [];
        const match = callerContacts.find((c) => (c.alias || '').toLowerCase() === alias && c.agentName);
        if (match?.agentName) bound = { agentName: match.agentName, instanceId: match.instanceId || 'default' };
      }
      if (!bound) {
        return res.status(404).json({ message: `No contact bound to alias "${alias}"`, alias });
      }
      targetUser = await AgentIdentityService.getOrCreateAgentUser(bound.agentName, { instanceId: bound.instanceId });
      targetMeta = {
        agentName: bound.agentName,
        instanceId: bound.instanceId,
        displayName: AgentIdentityService.resolveAgentDisplayLabel(
          targetUser as { username?: string; botMetadata?: { displayName?: string; instanceId?: string; agentName?: string } } | null,
          bound.agentName,
        ),
        isBot: true,
      };
    } else {
      return res.status(400).json({ message: 'target must specify agentName, userId, or alias' });
    }

    if (!targetUser?._id) {
      return res.status(404).json({ message: 'target user could not be resolved' });
    }
    if (String(targetUser._id) === String(callerAgentUser._id)) {
      return res.status(400).json({ message: 'Cannot DM yourself' });
    }

    // §3.7 co-pod-member rule. Bypass when an admin has pinned the
    // target via originPodId's pod.contacts (admin-binding carve-out).
    let authorizedByPodBinding = false;
    const originPodIdSafe = originPodId ? String(originPodId) : '';
    if (originPodIdSafe && target.alias) {
      const originPod = await Pod.findById(originPodIdSafe).select('contacts').lean();
      authorizedByPodBinding = !!originPod?.contacts?.[String(target.alias).toLowerCase()];
    }
    if (!authorizedByPodBinding) {
      const shared = await DMService.sharePod(callerAgentUser._id, targetUser._id);
      if (!shared) {
        return res.status(403).json({
          message: 'No shared pod with target — refused per co-pod-member rule',
          rule: 'sharePod',
        });
      }
    }

    // Build member metadata for both sides so AgentInstallation upserts
    // know which ones need bot-side scaffolding.
    const callerMeta = {
      userId: callerAgentUser._id,
      agentName: callerAgentUser.botMetadata?.agentName || (req.agentInstallation?.agentName as string),
      instanceId: callerAgentUser.botMetadata?.instanceId || (req.agentInstallation?.instanceId as string) || 'default',
      isBot: true,
      // resolveAgentDisplayLabel prefers `botMetadata.displayName`, then the
      // identity-bearing instanceId, then username — never the runtime-leaning
      // `botMetadata.agentName` ('openclaw' for OpenClaw-driven agents).
      displayName: AgentIdentityService.resolveAgentDisplayLabel(
        callerAgentUser as { username?: string; botMetadata?: { displayName?: string; instanceId?: string; agentName?: string } } | null,
        callerAgentUser.username,
      ),
    };
    const peerMeta = {
      userId: targetUser._id,
      agentName: targetMeta.agentName,
      instanceId: targetMeta.instanceId || 'default',
      isBot: targetMeta.isBot,
      displayName: targetMeta.displayName,
    };

    const room = await DMService.getOrCreateAgentDmRoom(callerMeta, peerMeta, {
      creatorUserId: callerAgentUser._id,
    });

    // §3.8 — drop a "DM started" system event in the originating pod
    // so humans see the link without the conversation polluting the
    // pod chat. Posted via commonly-bot (auto-installed in every pod
    // already), so we don't need extra membership scaffolding. Best-
    // effort: failure to write the event must not fail the DM creation.
    if (originPodIdSafe) {
      try {
        await AgentMessageService.postMessage({
          agentName: 'commonly-bot',
          podId: originPodIdSafe,
          content: `🤝 ${callerMeta.displayName} and ${peerMeta.displayName} started a DM — [view](/v2/pods/${room._id})`,
          metadata: { systemEventType: 'agent-dm-created', dmPodId: String(room._id) },
        });
      } catch (sysErr) {
        console.warn('[agent-dm] system-message post failed:', (sysErr as Error).message);
      }
    }

    return res.json({ room, autoJoined: false });
  } catch (error: any) {
    console.error('Error creating/fetching agent-dm:', error);
    return res.status(500).json({ message: 'Failed to create/fetch agent-dm' });
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
    const deliveryId = req.body?.deliveryId || null;
    // Which consumer is acking. Phase B is keyed on this rather than flipped
    // globally, so a migrated client can enforce while a parked one (the
    // openclaw extension, parked 2026-08-20) keeps working. Clients declare
    // themselves with `x-commonly-client`; anything that does not is
    // 'unknown', which is never enforced unless the operator sets `true`/`*`.
    const ackConsumer = String(req.header?.('x-commonly-client') || '').trim().toLowerCase() || 'unknown';
    // Phase B: refuse rather than accept-and-say-nothing. acknowledge()
    // returns null for a refused nonce-less ack, which is indistinguishable
    // from "already gone", so answering 200 here would tell the driver it
    // acked while the event rolled into the requeue unhandled.
    if (!deliveryId && AgentEventService.isDeliveryNonceRequired(ackConsumer)) {
      return res.status(400).json({
        code: 'delivery_id_required',
        message: 'This instance requires the deliveryId from the event payload on ack',
      });
    }
    const acked = await AgentEventService.acknowledge(
      req.params.id,
      resolvedAgentName,
      instanceId,
      delivery,
      deliveryId,
      ackConsumer,
    );
    // ADR-026 D6: only a caller that presented a deliveryId can be told it was
    // superseded, so pre-D6 drivers see byte-identical behaviour. 409, not 404
    // — "the event is gone" is idempotent success, "you were replaced" means
    // stop working.
    if (!acked && await AgentEventService.isSupersededDelivery(
      req.params.id, resolvedAgentName, instanceId, deliveryId,
    )) {
      return res.status(409).json({ code: 'stale_delivery', message: 'This delivery was superseded by a requeue' });
    }

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
    const deliveryId = req.body?.deliveryId || null;
    // Which consumer is acking. Phase B is keyed on this rather than flipped
    // globally, so a migrated client can enforce while a parked one (the
    // openclaw extension, parked 2026-08-20) keeps working. Clients declare
    // themselves with `x-commonly-client`; anything that does not is
    // 'unknown', which is never enforced unless the operator sets `true`/`*`.
    const ackConsumer = String(req.header?.('x-commonly-client') || '').trim().toLowerCase() || 'unknown';
    // Phase B: refuse rather than accept-and-say-nothing. acknowledge()
    // returns null for a refused nonce-less ack, which is indistinguishable
    // from "already gone", so answering 200 here would tell the driver it
    // acked while the event rolled into the requeue unhandled.
    if (!deliveryId && AgentEventService.isDeliveryNonceRequired(ackConsumer)) {
      return res.status(400).json({
        code: 'delivery_id_required',
        message: 'This instance requires the deliveryId from the event payload on ack',
      });
    }
    const acked = await AgentEventService.acknowledge(
      req.params.id,
      agentName,
      instanceId,
      delivery,
      deliveryId,
      ackConsumer,
    );
    // See the /bot/events ack above: 409 only for nonce-presenting callers.
    if (!acked && await AgentEventService.isSupersededDelivery(
      req.params.id, agentName, instanceId, deliveryId,
    )) {
      return res.status(409).json({ code: 'stale_delivery', message: 'This delivery was superseded by a requeue' });
    }
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
      // Same server-computed `self` flag as the runtime-token route (#757).
      const messages = await AgentMessageService.getRecentMessages(podId, limit, user._id);
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
      const err = error as Error & { code?: string; statusCode?: number };
      if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        console.warn('Bot message refused:', { code: err.code, status: err.statusCode, message: err.message });
        return res.status(err.statusCode).json({
          message: err.message,
          ...(err.code ? { code: err.code } : {}),
        });
      }
      console.error('Error posting bot message:', error);
      return res.status(500).json({ message: err.message || 'Failed to post message' });
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

    const supportedQueryParams = new Set(['limit', 'before', 'threadRootId']);
    const unsupportedQueryParams = Object.keys(req.query || {})
      .filter((key) => !supportedQueryParams.has(key));
    if (unsupportedQueryParams.length > 0) {
      return res.status(400).json({
        message: `Unsupported query parameter(s): ${unsupportedQueryParams.join(', ')}. Supported parameters: limit, before, threadRootId.`,
        code: 'unsupported_query_parameters',
        unsupportedQueryParams,
      });
    }

    const rawLimit = req.query?.limit;
    if (rawLimit !== undefined
      && (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) || Number(rawLimit) < 1)) {
      return res.status(400).json({
        message: 'limit must be a positive integer',
        code: 'invalid_query_parameter',
        parameter: 'limit',
      });
    }
    const limit = Math.min(Number(rawLimit || 20), 50);

    const rawBefore = req.query?.before;
    if (rawBefore !== undefined
      && (typeof rawBefore !== 'string'
        || !rawBefore.trim()
        || Number.isNaN(Date.parse(rawBefore)))) {
      return res.status(400).json({
        message: 'before must be a valid timestamp',
        code: 'invalid_query_parameter',
        parameter: 'before',
      });
    }
    const beforeMs = rawBefore === undefined ? undefined : Date.parse(rawBefore);

    // Thread-scoped read (TASK-052's read half): the response is one
    // thread — its root plus every message rooted at it — instead of the
    // pod tail. Numeric string only: PG message ids are integers, and the
    // model casts the parameter with ::int, so a stray value must fail
    // here with a named error rather than there with a cast error.
    const rawThreadRootId = req.query?.threadRootId;
    if (rawThreadRootId !== undefined
      && (typeof rawThreadRootId !== 'string' || !/^\d+$/.test(rawThreadRootId))) {
      return res.status(400).json({
        message: 'threadRootId must be a numeric message id',
        code: 'invalid_query_parameter',
        parameter: 'threadRootId',
      });
    }

    // Pass the caller's own user id so each message carries a server-computed
    // `self` flag. The wrapper uses it to tell "I posted via my tool" from
    // "some OTHER agent posted while I was thinking" — the latter used to
    // silently swallow this agent's reply in any multi-agent pod (#757).
    const messages = await AgentMessageService.getRecentMessages(
      podId, limit + 1, req.agentUser?._id, beforeMs, rawThreadRootId,
    );
    const hasMore = messages.length > limit;
    // getRecentMessages returns chronological order. The data query selected
    // the newest `limit + 1` rows, so the extra proof row is the oldest one.
    const page = hasMore ? messages.slice(-limit) : messages;

    return res.json({ messages: page, hasMore });
  } catch (error: any) {
    console.error('Error fetching pod messages:', error);
    return res.status(500).json({ message: 'Failed to fetch messages' });
  }
});

/**
 * GET /pods/:podId/files
 * List files uploaded into this pod so an agent can discover what a human
 * shared (metadata only). Content is fetched via .../files/:fileName/content.
 */
router.get('/pods/:podId/files', phase4RateLimit, agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    if (!ensurePodMatch(req.agentInstallations || req.agentInstallation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 50);
    const files = await File.find({ podId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('fileName originalName contentType size createdAt')
      .lean();
    return res.json({
      files: (files || []).map((f: any) => ({
        fileName: f.fileName,
        name: f.originalName,
        contentType: f.contentType,
        size: f.size,
        uploadedAt: f.createdAt,
      })),
    });
  } catch (error: any) {
    console.error('Error listing pod files:', error);
    return res.status(500).json({ message: 'Failed to list files' });
  }
});

/**
 * GET /pods/:podId/files/:fileName/content
 * Return a pod file's content so an agent can read what a human uploaded.
 * Text-like files come back as UTF-8 in `content`; binary/oversized files
 * return metadata + a note (no bytes). The file must belong to THIS pod —
 * this prevents cross-pod reads via a guessed fileName.
 */
const AGENT_FILE_TEXT_MAX = 256 * 1024; // 256 KB cap on inlined text

// Textual subtypes, matched as WHOLE TOKENS against the parsed subtype —
// never as substrings of the raw header.
//
// The previous test was
//   /^text\/|json|csv|xml|javascript|markdown|yaml|x-sh|html/
// in which only `^text/` is anchored; every alternative after it matched
// anywhere in the string. `application/vnd.openXMLformats-officedocument.
// wordprocessingml.document` contains "xml", so .docx/.xlsx/.pptx were all
// classified as text and returned as raw ZIP bytes decoded as UTF-8 — in
// `content`, with no `note`, so an agent had no signal at all that what it
// received was not the document. Measured 2026-08-05: a 939-byte .docx came
// back as "PK\x03\x04…". That is worse than refusing, because a refusal is
// legible and this is not. See AX audit entry 19.
//
// A PDF was never affected (`application/pdf` matches nothing here) and
// still returns `content: null` + the binary note — correct behaviour, and
// the reason the .docx case went unnoticed: the format everyone tested
// failed honestly.
const TEXTUAL_SUBTYPES = new Set([
  'json', 'csv', 'tsv', 'xml', 'javascript', 'ecmascript', 'markdown', 'md',
  'yaml', 'x-yaml', 'x-sh', 'html', 'xhtml', 'plain', 'sql', 'toml', 'ini',
]);

const isTextualContentType = (raw: string): boolean => {
  // Strip parameters (`; charset=utf-8`) before splitting type/subtype.
  const [type, subtype = ''] = String(raw || '').split(';')[0].trim().toLowerCase().split('/');
  if (type === 'text') return true;
  if (TEXTUAL_SUBTYPES.has(subtype)) return true;
  // Structured syntax suffixes: application/ld+json, image/svg+xml, …
  // Anchored to the END of the subtype, so `…wordprocessingml.document`
  // cannot match on a bare "+xml" that isn't a suffix.
  return /\+(json|xml)$/.test(subtype);
};

router.get('/pods/:podId/files/:fileName/content', phase4RateLimit, agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    // Reject any fileName that isn't a plain stored name — no path separators
    // or traversal reaches the object store (defense in depth beyond the
    // pod-scoped File.findOne gate below).
    const fileName = String(req.params.fileName || '');
    if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
      return res.status(400).json({ message: 'Invalid file name' });
    }
    if (!ensurePodMatch(req.agentInstallations || req.agentInstallation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }
    const file = await File.findOne({ fileName, podId })
      .select('fileName originalName contentType size')
      .lean() as any;
    if (!file) {
      return res.status(404).json({ message: 'File not found in this pod' });
    }

    // Fetch bytes: object store first, legacy inline data as fallback.
    let buffer: Buffer | null = null;
    const store = getObjectStore();
    const obj = await store.get(fileName);
    if (obj && obj.stream) {
      buffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        obj.stream.on('data', (c: Buffer) => chunks.push(c));
        obj.stream.on('end', () => resolve(Buffer.concat(chunks)));
        obj.stream.on('error', reject);
      });
    } else {
      const legacy = await File.findByFileName(fileName);
      if (legacy && legacy.data && legacy.data.length > 0) buffer = legacy.data;
    }
    if (!buffer) {
      return res.status(404).json({ message: 'File content not found' });
    }

    const ct = String(file.contentType || '');
    const isText = isTextualContentType(ct);
    if (isText && buffer.length <= AGENT_FILE_TEXT_MAX) {
      return res.json({
        fileName: file.fileName,
        name: file.originalName,
        contentType: file.contentType,
        size: file.size,
        content: buffer.toString('utf8'),
      });
    }
    return res.json({
      fileName: file.fileName,
      name: file.originalName,
      contentType: file.contentType,
      size: file.size,
      content: null,
      note: isText
        ? `File is ${buffer.length} bytes, over the ${AGENT_FILE_TEXT_MAX}-byte inline text limit.`
        : 'Binary file — content is not returned as text.',
    });
  } catch (error: any) {
    console.error('Error reading pod file:', error);
    return res.status(500).json({ message: 'Failed to read file' });
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

// Manual typing-indicator control for runtime-token agents.
//
// The internal callers (nativeRuntimeService, agentEventService) emit
// agent_typing_start automatically when they enter their agent loop, then
// agent_typing_stop when the message lands. External agents posting via
// `POST /pods/:podId/messages` get the auto-stop on message land but no
// auto-start — meaning their messages appear without the conversational
// "typing…" pre-roll.
//
// This route exposes typing_start/stop to runtime-token holders so external
// agents (CLI wrappers, webhook bots, demo drivers) can render the same
// chat chrome as native ones. Auto-clear after 30s safety window in
// agentTypingService prevents stuck indicators on dropped sessions.
//
// Body: { action: 'start' | 'stop' }  (defaults to 'start')
router.post('/pods/:podId/typing', agentRuntimeAuth, phase4RateLimit, async (req: any, res: any) => {
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

    const action = String(req.body?.action || 'start').toLowerCase();
    if (action !== 'start' && action !== 'stop') {
      return res.status(400).json({ message: "action must be 'start' or 'stop'" });
    }

    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const typing = require('../services/agentTypingService');
    const agentName = installation.agentName;
    const instanceId = installation.instanceId || 'default';

    if (action === 'stop') {
      typing.emitAgentTypingStop({ podId, agentName, instanceId });
      return res.json({ ok: true, action: 'stop' });
    }

    // The label is pod-scoped on the installation. Fetch the User only for
    // the portable avatar/fallback; never let its principal label override
    // this pod's configured agent label.
    let displayName = installation.displayName || agentName;
    let avatar: string | undefined;
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const AgentIdentityService = require('../services/agentIdentityService');
      const agentUser = await AgentIdentityService.getOrCreateAgentUser(agentName, { instanceId }) as {
        username?: string;
        profilePicture?: string;
        botMetadata?: { displayName?: string };
      };
      displayName = installation.displayName || agentUser?.botMetadata?.displayName || agentUser?.username || agentName;
      avatar = agentUser?.profilePicture || undefined;
    } catch (identityError) {
      console.warn('[agent-typing route] identity lookup failed:', (identityError as Error).message);
    }

    typing.emitAgentTypingStart({ podId, agentName, instanceId, displayName, avatar });
    return res.json({ ok: true, action: 'start', displayName });
  } catch (error: any) {
    console.error('agent typing route error:', error?.message || error);
    return res.status(500).json({ message: 'typing-indicator emit failed' });
  }
});

router.post('/pods/:podId/messages', agentRuntimeAuth, phase4RateLimit, async (req: any, res: any) => {
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
      content, metadata, messageType, replyToMessageId, threadRootId,
    } = req.body || {};
    const result = await AgentMessageService.postMessage({
      agentName: installation.agentName,
      instanceId: installation.instanceId || 'default',
      displayName: installation.displayName,
      podId,
      content,
      metadata,
      messageType,
      replyToMessageId: replyToMessageId || null,
      // In-thread post WITHOUT addressing (constraint 5, Sam's independence
      // rule): the thread is ambient membership, the reply edge is a ping.
      // Validated by threadRootResolver on the service side — same five
      // rejections as the human composer path.
      threadRootId: threadRootId || null,
      installationConfig: installation.config || null,
    });

    // DM auto-route from the agent side fires ONLY in agent-dm — the only
    // DM-shaped pod with another bot to route to. agent-admin and agent-room
    // are operator-driven 1:1 (human ↔ one agent); the human is the only
    // peer in those pods and has no event queue. The mirror direction
    // (human-side enqueueDmEvent for all three DM types) lives in
    // backend/controllers/messageController.ts. Without this fix, an agent
    // posting in an agent-dm with no `@peer` text left the peer's queue
    // empty (this stranded the nova↔theo smoke). Non-DM pods continue to
    // gate on explicit @mentions via enqueueMentions.
    if (result.success && !result.skipped && result.message) {
      const userId = req.agentUser?._id;
      const username = req.agentUser?.username;
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const PodModel = require('../models/Pod');
      PodModel.findById(podId).select('type').lean()
        .then((podDoc: { type?: string } | null) => {
          if (podDoc?.type === 'agent-dm') {
            return AgentMentionService.enqueueDmEvent({ podId, message: result.message, userId, username });
          }
          return AgentMentionService.enqueueMentions({ podId, message: result.message, userId, username });
        })
        .catch((err: any) => console.warn('agent post-message DM/mention enqueue failed:', err.message));
    }

    return res.json(result);
  } catch (error: any) {
    const err = error as Error & { code?: string; statusCode?: number; name?: string };
    // A bad thread target is caller-fixable input, same as on the human
    // composer path (messageController): 400 with the resolver's code, so
    // the agent's next attempt can be different instead of blind.
    if (err.name === 'ThreadRootError') {
      return res.status(400).json({ message: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    // Distinguish authorization refusals (403, e.g. dm_membership_refused)
    // from "pod truly missing" (404) and unexpected failures (500). Without
    // this, the post-message route 500'd on every legitimate guard refusal,
    // and the gateway logged "Failed to post message: 500" floods.
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      console.warn('Agent message refused:', { code: err.code, status: err.statusCode, message: err.message });
      return res.status(err.statusCode).json({
        message: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    console.error('Error posting agent message:', error);
    return res.status(500).json({ message: err.message || 'Failed to post message' });
  }
});

// W1 step 1 — the CAP producer surface for approval cards.
//
// Until now `proposeAction` had exactly one caller: the in-process native
// runtime. Consumers were already universal (any human decides via
// /api/approvals), so the kernel could be asked for consent by first-party
// agents only — the universality gap. This route is the thin HTTP shell that
// closes it, so a BYO wrapper or a hosted runtime proposes through the same
// service, with the same validation, as a native agent.
//
// Deliberately thin: every rule (known actionType, param validation, summary
// presence, the decider derivation and its refusal) stays in the service.
// A second copy of any of those in a route handler is how the two surfaces
// drift apart, and this one is a consent surface.
// Limiter BEFORE auth, deliberately diverging from the sibling mutating
// routes. The plan specified "agentRuntimeAuth + phase4RateLimit (sibling
// convention)" — but the convention is the flagged one, as the note at the
// top of this file documents: agentRuntimeAuth does a Mongo lookup, so a
// limiter placed after it leaves that lookup unprotected, and CodeQL flags it
// as genuinely under-protected rather than a false positive. It flagged this
// route too, on its first run. The existing 8 routes are specified to move
// and simply have not yet; a NEW route has no migration cost, so it starts on
// the correct side rather than joining the queue of ones to fix.
router.post('/pods/:podId/propose-action', phase4RateLimit, agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );

    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { proposeActionForRuntime } = require('../services/approvalActionService');
    const verdict = await proposeActionForRuntime({
      podId,
      installations: req.agentInstallations,
      installation,
      authorizedPodIds: req.agentAuthorizedPodIds,
      body: req.body || {},
    });
    return res.status(verdict.status).json(verdict.body);
  } catch (error: any) {
    const err = error as Error & { code?: string; statusCode?: number };
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      console.warn('Agent propose-action refused:', { code: err.code, status: err.statusCode });
      return res.status(err.statusCode).json({
        message: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    console.error('Error proposing agent action:', error);
    return res.status(500).json({ message: err.message || 'Failed to propose action' });
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
const { VISIBILITY_VALUES, AGENT_WRITABLE_SECTIONS } = require('../models/AgentMemory');
const VALID_VISIBILITIES = new Set(VISIBILITY_VALUES);
const VALID_WRITABLE_SECTIONS = new Set<string>(AGENT_WRITABLE_SECTIONS);

// ADR-012 §1: the agent's tool surface MUST NOT write `system_exchanges`.
// ADR-012 §10.1: `cycles` is agent-writable but append-only — whole-array
// overwrite is a structural bug (drops history) and is rejected with a tagged
// 403 distinct from system_exchanges' read-only refusal.
// Validators return a tagged error so the route can map to 403 (not 400).
type SectionsValidationError =
  | { kind: 'bad_request'; message: string }
  | { kind: 'system_exchanges_read_only' }
  | { kind: 'cycles_append_only'; message: string };

// Shape of an append-mode cycles payload, after validateSectionsPayload has
// confirmed it. Route handlers split this out and call appendCycle directly.
export interface CyclesAppendPayload {
  content: string;
  ts?: Date;
  podId?: string;
}

// ADR-003 convergence: the (agentName, instanceId) tuple this returns is the
// AgentMemory document key for every GET/PUT/sync over the HTTP memory boundary.
// It MUST match what platform-side writers/readers key on, or an agent reads a
// DIFFERENT doc than the platform writes (silent read-after-write split).
//
// Every platform writer normalizes agentName to lowercase and leaves instanceId
// as a plain string defaulting to 'default':
//   - systemExchangeTriggers.ts (resolveAgentMembers): `String(agentName).toLowerCase()`
//   - agentEventService.ts (prependMemoryCue / list): `agentName.toLowerCase()` + `String(instanceId || 'default')`
//   - nativeRuntimeService.ts: `String(installation.agentName || '').toLowerCase()` + `String(installation.instanceId || 'default')`
//   - agentMemoryService.appendSystemExchange keys `{ agentName, instanceId }` verbatim.
//
// The bug this guards against: when `req.agentInstallation` is null (identity-
// continuity case — installations removed but the bot User row survives) the
// chain falls through to `username`, which can be mixed-case. Without the
// lowercase here, the agent's own GET/PUT keys a different doc than the platform.
// Instance IDs are intentionally NOT lowercased — platform writers keep them raw
// (e.g. read straight off `botMetadata.instanceId`), so lowercasing here would
// itself introduce a mismatch. Preserve the fallback chain; only add normalization.
function resolveMemoryIdentity(req: any): { agentName?: string; instanceId: string } {
  const agentInstallation = req.agentInstallation;
  const rawAgentName =
    agentInstallation?.agentName ||
    req.agentUser?.botMetadata?.agentName ||
    req.agentUser?.username;
  const rawInstanceId =
    agentInstallation?.instanceId ||
    req.agentUser?.botMetadata?.instanceId ||
    'default';
  const agentName = rawAgentName
    ? String(rawAgentName).trim().toLowerCase()
    : undefined;
  const instanceId = String(rawInstanceId || 'default').trim() || 'default';
  return { agentName, instanceId };
}

function validateSectionsPayload(sections: any): SectionsValidationError | null {
  if (typeof sections !== 'object' || sections === null || Array.isArray(sections)) {
    return { kind: 'bad_request', message: 'sections must be an object' };
  }
  if (Object.keys(sections).length === 0) {
    return { kind: 'bad_request', message: 'sections must have at least one key' };
  }
  for (const key of Object.keys(sections)) {
    // ADR-012 §1: explicit rejection for the read-only system section.
    // Surfaced separately from the generic "unknown section" path so callers
    // (and CAP test harnesses) can distinguish "you can't write here" from
    // "we don't know what that is."
    if (key === 'system_exchanges') {
      return { kind: 'system_exchanges_read_only' };
    }
    // ADR-012 §10.1: cycles[] is agent-writable but append-only. The accepted
    // shape is `cycles: { append: { content, ts?, podId? } }`. Anything else
    // (array literal, `{entries: [...]}`, plain object missing `append`) is
    // rejected with a 403 + tagged reason `cycles_append_only`. Validation
    // here only checks structure — appendCycle truncates content + stamps ts.
    if (key === 'cycles') {
      const v = sections[key];
      if (!v || typeof v !== 'object' || Array.isArray(v) || !('append' in v)) {
        return {
          kind: 'cycles_append_only',
          message: 'cycles is append-only — payload must be { append: { content, ts?, podId? } }',
        };
      }
      const append = (v as any).append;
      if (!append || typeof append !== 'object' || Array.isArray(append)) {
        return {
          kind: 'cycles_append_only',
          message: 'cycles.append must be an object with at least { content }',
        };
      }
      if (typeof append.content !== 'string' || !append.content.trim()) {
        return {
          kind: 'cycles_append_only',
          message: 'cycles.append.content must be a non-empty string',
        };
      }
      if (append.ts !== undefined) {
        const tsParsed = new Date(append.ts as string | number | Date);
        if (Number.isNaN(tsParsed.getTime())) {
          return { kind: 'bad_request', message: 'cycles.append.ts must be a valid date' };
        }
      }
      if (append.podId !== undefined && typeof append.podId !== 'string') {
        return { kind: 'bad_request', message: 'cycles.append.podId must be a string' };
      }
      // Reject any sibling keys on the cycles object — only `append` is allowed.
      // This catches "looks-like-overwrite" attempts that include both `append`
      // and `entries`/`visibility` in the same object.
      const allowedKeys = new Set(['append']);
      for (const k of Object.keys(v as object)) {
        if (!allowedKeys.has(k)) {
          return {
            kind: 'cycles_append_only',
            message: `cycles.${k} is not allowed; only cycles.append is supported`,
          };
        }
      }
      continue; // cycles is recognized; skip the unknown-section check below.
    }
    if (!VALID_WRITABLE_SECTIONS.has(key)) {
      return { kind: 'bad_request', message: `unknown section: ${key}` };
    }
  }
  const singleSectionKeys = ['soul', 'long_term', 'dedup_state', 'shared', 'runtime_meta'];
  for (const key of singleSectionKeys) {
    const s = sections[key];
    if (s === undefined) continue;
    if (typeof s !== 'object' || s === null) return { kind: 'bad_request', message: `sections.${key} must be an object` };
    if (s.content !== undefined && typeof s.content !== 'string') return { kind: 'bad_request', message: `sections.${key}.content must be a string` };
    if (s.visibility !== undefined && !VALID_VISIBILITIES.has(s.visibility)) {
      return { kind: 'bad_request', message: `sections.${key}.visibility must be one of private|pod|public` };
    }
  }
  if (sections.daily !== undefined) {
    if (!Array.isArray(sections.daily)) return { kind: 'bad_request', message: 'sections.daily must be an array' };
    // Default missing `date` to today's UTC YYYY-MM-DD. The
    // `commonly_save_my_memory` MCP tool contract (commonly-mcp/src/
    // tools.js) documents `entries` as the daily-write shape but does
    // NOT disclose that each entry must already carry a `date` field
    // in strict YYYY-MM-DD form. Surfaced 2026-05-24 by Cody during
    // the Phase 2 huddle smoke (issue #435): `long_term` writes
    // succeeded; a natural `daily` write failed with
    // `sections.daily[].date must be YYYY-MM-DD`.
    //
    // Fix: server-side default to today (UTC) when `date` is absent,
    // BEFORE validation. Explicit values still flow through unchanged
    // — if a caller passes `date: 'not-a-date'` we still 400. This is
    // a kindness for the common case (agent saying "today's note") and
    // doesn't widen the schema's accepted shape. Mutation of the
    // request body is intentional + scoped to this one defaulting
    // step; the route handler downstream sees the normalized array.
    const todayYMD = new Date().toISOString().slice(0, 10);
    for (const d of sections.daily) {
      if (d && typeof d === 'object' && d.date === undefined) {
        d.date = todayYMD;
      }
      if (!isValidYMD(d?.date)) return { kind: 'bad_request', message: 'sections.daily[].date must be YYYY-MM-DD' };
      if (d.visibility !== undefined && !VALID_VISIBILITIES.has(d.visibility)) {
        return { kind: 'bad_request', message: 'sections.daily[].visibility must be one of private|pod|public' };
      }
    }
  }
  if (sections.relationships !== undefined) {
    if (!Array.isArray(sections.relationships)) return { kind: 'bad_request', message: 'sections.relationships must be an array' };
    for (const r of sections.relationships) {
      if (typeof r?.otherInstanceId !== 'string') return { kind: 'bad_request', message: 'sections.relationships[].otherInstanceId must be a string' };
      if (r.visibility !== undefined && !VALID_VISIBILITIES.has(r.visibility)) {
        return { kind: 'bad_request', message: 'sections.relationships[].visibility must be one of private|pod|public' };
      }
    }
  }
  return null;
}

// Map a SectionsValidationError onto an HTTP response. 400 for shape errors;
// 403 + tagged reason for ADR-012 §1's `system_exchanges_is_read_only` and
// ADR-012 §10.1's `cycles_append_only`.
function sendSectionsError(res: any, err: SectionsValidationError): any {
  if (err.kind === 'system_exchanges_read_only') {
    return res.status(403).json({
      message: 'system_exchanges is read-only',
      reason: 'system_exchanges_is_read_only',
    });
  }
  if (err.kind === 'cycles_append_only') {
    return res.status(403).json({
      message: err.message,
      reason: 'cycles_append_only',
    });
  }
  return res.status(400).json({ message: err.message });
}

// Helper: extract the cycles append payload from a sections object (mutating —
// removes the cycles key). Returns null if no cycles key was present. Caller
// invokes appendCycle separately for the returned payload, then proceeds with
// the standard write path on the remaining sections.
function extractCyclesAppend(sections: Record<string, unknown>): CyclesAppendPayload | null {
  if (!sections || typeof sections !== 'object' || !('cycles' in sections)) return null;
  const v = (sections as any).cycles;
  delete (sections as any).cycles;
  const append = v?.append;
  if (!append) return null;
  const out: CyclesAppendPayload = { content: String(append.content || '').trim() };
  if (append.ts !== undefined) {
    const ts = new Date(append.ts);
    if (!Number.isNaN(ts.getTime())) out.ts = ts;
  }
  if (typeof append.podId === 'string' && append.podId) out.podId = append.podId;
  return out;
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
router.put('/memory', agentRuntimeAuth, phase4RateLimit, async (req: any, res: any) => {
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
      if (sectionsError) return sendSectionsError(res, sectionsError);
    }
    if (sourceRuntime !== undefined && typeof sourceRuntime !== 'string') {
      return res.status(400).json({ message: 'sourceRuntime must be a string' });
    }

    // ADR-012 §10.1: cycles is append-only via a sibling helper. Pull it out
    // of the sections payload BEFORE the standard write path so it doesn't
    // leak into stampSectionsForWrite (which expects whole-section overwrite
    // shapes). The standard $set then proceeds on the remaining sections.
    const cyclesAppend = sections !== undefined ? extractCyclesAppend(sections) : null;
    let cycleResult: Awaited<ReturnType<typeof appendCycle>> = null;
    if (cyclesAppend) {
      try {
        cycleResult = await appendCycle({ agentName, instanceId, ...cyclesAppend });
      } catch (cycleErr: any) {
        // Validation errors (content too long, etc) are caught by the schema's
        // runValidators; surface as 400 so callers can correct.
        if (cycleErr?.name === 'ValidationError') {
          return res.status(400).json({ message: cycleErr.message });
        }
        throw cycleErr;
      }
    }

    const setOps: Record<string, unknown> = {};
    // If cycles was the only section, sections may now be empty after
    // extractCyclesAppend; skip the standard write path in that case.
    const hasOtherSections = sections !== undefined && Object.keys(sections).length > 0;
    if (hasOtherSections) {
      // Server-stamp byteSize + updatedAt so clients can't fabricate them.
      let stamped = stampSectionsForWrite(sections);
      // GH#632: stamp provenance + push the replaced version into the capped
      // per-section history. Needs the prior doc — one indexed read on a
      // low-frequency write path.
      const priorDoc = await AgentMemory.findOne({ agentName, instanceId })
        .select('sections').lean() as { sections?: any } | null;
      stamped = decorateSectionsWithProvenance(
        priorDoc?.sections,
        stamped,
        { runtime: sourceRuntime, via: 'memory-put' },
      );
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
    //
    // Skip the $set/$unset round-trip when the payload was cycles-only — the
    // appendCycle call above already touched the doc, and cycles is not part
    // of the sync dedup stream (mirrors invariant 8a for system_exchanges:
    // drivers don't sync these sections, so they don't invalidate the cache).
    if (Object.keys(setOps).length > 0) {
      await AgentMemory.findOneAndUpdate(
        { agentName, instanceId },
        { $set: setOps, $unset: { lastSyncKey: '', lastSyncAt: '' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }
    console.log('[agent-memory PUT]', {
      agentName,
      instanceId,
      sectionKeys: sections ? Object.keys(sections) : [],
      cyclesAppended: !!cyclesAppend,
      contentProvided: content !== undefined,
      sourceRuntime,
    });
    // Report the mutation, not just the success: an ellipsised cycle entry —
    // or an evicted one — is indistinguishable from a stored one without this.
    return res.json({ ok: true, ...describeCycleMutation(cycleResult) });
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
router.post('/memory/sync', agentRuntimeAuth, phase4RateLimit, async (req: any, res: any) => {
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
    if (sectionsError) {
      if (sectionsError.kind === 'system_exchanges_read_only') {
        console.log('[agent-memory SYNC reject]', { agentName, instanceId, reason: 'system_exchanges_is_read_only' });
        return sendSectionsError(res, sectionsError);
      }
      return rejectAndLog(sectionsError.message);
    }
    if (sourceRuntime !== undefined && typeof sourceRuntime !== 'string') {
      return rejectAndLog('sourceRuntime must be a string');
    }
    if (mode !== 'full' && mode !== 'patch') {
      return rejectAndLog("mode must be 'full' or 'patch'");
    }

    // ADR-012 §10.1: handle a `cycles` append before the sync dedup logic.
    // The dedup key is computed AFTER cycles is removed (see computeSyncDedupKey
    // input below), so resending the same payload doesn't double-append; the
    // dedup gate covers replay safety on the syncable sections only.
    //
    // The hazard is `cycles` *mixed with syncable sections* in a resend: those
    // appends fire a second time. It is NOT "don't send cycles through sync" —
    // an earlier version of this comment said callers should use a cycles-only
    // `PUT /memory` instead, which no shipped caller does. `commonly_log_cycle`
    // posts cycles-only payloads to this route (`commonly-mcp/src/tools.js`),
    // and they return at the cycles-only branch below, before
    // `computeSyncDedupKey` is ever called — so the double-append cannot reach
    // them. Naming the wrong condition made a real constraint read as a rule
    // every caller safely ignores.
    const cyclesAppend = extractCyclesAppend(sections);
    let cycleResult: Awaited<ReturnType<typeof appendCycle>> = null;
    if (cyclesAppend) {
      try {
        cycleResult = await appendCycle({ agentName, instanceId, ...cyclesAppend });
      } catch (cycleErr: any) {
        if (cycleErr?.name === 'ValidationError') return rejectAndLog(cycleErr.message);
        throw cycleErr;
      }
    }
    // See PUT /memory: the append's mutations are reported, never silent.
    const cycleMutation = describeCycleMutation(cycleResult);

    const now = new Date();
    const hasOtherSections = Object.keys(sections).length > 0;
    if (!hasOtherSections) {
      // Cycles-only sync — write already happened in appendCycle. Skip the
      // rest of the sync pipeline (no dedup key needed; sync state didn't
      // change for the syncable sections).
      console.log('[agent-memory SYNC cycles-only]', { agentName, instanceId, sourceRuntime });
      return res.json({
        // NEVER hardcode true: `appendCycle` returns null on empty/whitespace
        // content (agentMemoryService.ts:643) and `describeCycleMutation` returns
        // {} for null, so a hardcoded true answers a rejected write with
        // {ok, cyclesAppended:true} and no flags — which is byte-identical to a
        // backend that predates the flags. Two independent validators must not
        // be able to disagree about whether a write happened. Patch by
        // @sprint-review.
        ok: true, schemaVersion: 2, cyclesAppended: !!cycleResult, ...cycleMutation,
      });
    }
    const dedupKey = computeSyncDedupKey(sections, sourceRuntime, mode, now);

    const existing = await AgentMemory.findOne({ agentName, instanceId }).lean();
    if (existing?.lastSyncKey === dedupKey) {
      console.log('[agent-memory SYNC deduped]', { agentName, instanceId, mode, sourceRuntime });
      // The cycles append above already fired (deduping covers syncable
      // sections only), so its truncation must be reported here too.
      return res.json({ ok: true, deduped: true, ...cycleMutation });
    }

    // GH#632: stamp provenance + capped version history against the existing
    // sections (already fetched above for the dedup check — no extra read).
    const stamped = decorateSectionsWithProvenance(
      existing?.sections as any,
      stampSectionsForWrite(sections, now),
      { runtime: sourceRuntime, via: 'memory-sync' },
      now,
    );

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

    return res.json({ ok: true, schemaVersion: 2, ...cycleMutation });
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
router.get('/pods', phase4RateLimit, agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const nonDiscoverableTypes = [
      'dm', // legacy rows
      'agent-admin',
      ...AgentIdentityService.DM_POD_TYPES_GUARD,
    ];
    const authorizedPodIds = new Set((req.agentAuthorizedPodIds || []).map((id: any) => id.toString()));

    // Excluding DM types is not a visibility rule — it only hides pods that are
    // private by TYPE. Every other private pod stayed enumerable: a token scoped
    // to a single pod could list other users' "My Workspace" rows, and five of
    // them carried generated conversation summaries. Verified live 2026-08-01.
    //
    // An agent may see a pod when it is either discoverable to everyone, or one
    // it is actually installed in. DIRECTLY_JOINABLE_QUERY is the canonical
    // public-listing plus join-policy gate (services/podListing.ts), composed
    // rather than restated so the two discovery paths cannot drift.
    //
    // Invite-only pods are excluded for the same reason human Discover excludes
    // them: the row is a dead end. An agent shown it can neither join nor, yet,
    // request access — H5 request-access does not exist. Revisit when it ships;
    // at that point the row acquires a verb and showing it becomes correct.
    //
    // `members: { $ne: callerId }` is deliberately NOT adopted from
    // communityDiscoverQuery. Human Discover hides pods you are already in
    // because its job is "find something new"; this route's job is "what may I
    // see", and the $or branch below deliberately includes your own pods.
    const visibleToAgent = {
      type: { $nin: nonDiscoverableTypes },
      $or: [
        { ...DIRECTLY_JOINABLE_QUERY },
        { _id: { $in: [...authorizedPodIds] } },
      ],
    };

    const pods = await Pod.find(visibleToAgent)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select('name description type members updatedAt publicRead communityListed')
      .lean();

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
// phase4RateLimit FIRST (before auth) so CodeQL's js/missing-rate-limiting
// query recognises the guard — it only credits a limiter that precedes the
// other middleware. The key generator reads the auth header directly, so it
// works pre-auth.
router.post('/pods', phase4RateLimit, agentRuntimeAuth, async (req: any, res: any) => {
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

    // This is the agent-create policy, not the Pod model's full enum or the
    // human creation route's read filter. Agent DMs are created only through
    // the dedicated rails that establish both members, while `agent-room` is
    // human-initiated; keeping those out here is intentional. `team` is the
    // ordinary multi-human pod shape used by the v2 shell.
    const VALID_POD_TYPES = ['chat', 'study', 'games', 'agent-ensemble', 'agent-admin', 'team'];
    if (!VALID_POD_TYPES.includes(type)) {
      return res.status(400).json({ message: `Invalid pod type. Must be one of: ${VALID_POD_TYPES.join(', ')}` });
    }

    // Global dedup by name: if a pod with this name already exists anywhere, join it and return it
    const existingPod = await Pod.findOne({ name })
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture');
    if (existingPod) {
      // DM pods are strictly 1:1 (ADR-001 §3.10). VALID_POD_TYPES above gates
      // the type the caller ASKED for, but this dedup branch matches on name
      // ALONE and never re-checks the type of what it found — so a name
      // collision turns a create call into a join against someone else's 1:1
      // DM. This was the sixth write path to `members` and the only one that
      // did not consult DM_POD_TYPES_GUARD (podController.joinPod,
      // podInvites ×2, registry/admin, and ensureAgentInPod are the five that
      // do). A membership invariant enforced at 5 of 6 writers is not an
      // invariant — scripts/migrate-agent-dm-multimember.ts exists because
      // multi-member DMs already happened once, and this writer is how they
      // could happen again.
      //
      // Refuse the whole branch, not just the members.push: the two writes
      // below are worse than the membership count. AgentInstallation.install
      // grants posting rights (auth goes through AgentInstallation.find, NOT
      // pod.members), and ensureCommonlyBotInstalled adds the summarizer with
      // context:read on a private 1:1 conversation. Fail closed, including
      // for a caller who is already one of the two members — this is a
      // CREATE endpoint, and returning someone's DM from it is not something
      // any caller needs. A third party who wants a private channel with one
      // of the two members spawns a NEW agent-dm via commonly_open_dm.
      // One refusal shape for every reason. The caller learns "that name is
      // taken by something you can't join" and nothing else: which pod, what
      // type, and whether it is a DM are all withheld, because pod names are
      // guessable by construction — resolveAgentDisplayLabel produces
      // "Nova and Theo" — and a refusal that names the reason turns this
      // endpoint into an existence oracle for other people's private pods.
      // Same principle as the personal-pod-types 404 on direct GET: the
      // *existence* surface must not advertise conversations you aren't in.
      // Operators still get the reason, server-side, in the warn below.
      const refusePodNameCollision = (reason: string) => {
        console.warn(
          `[agent] pod-create dedup refused: "${name}" resolves to pod ${existingPod._id} `
          + `type=${existingPod.type} — ${reason}`,
        );
        return res.status(403).json({
          code: 'pod_name_unavailable',
          message: 'That pod name is already taken by a pod you cannot join. Pick a '
            + 'different name. To start a private conversation with a specific agent, '
            + 'use commonly_open_dm instead of creating a pod by name.',
        });
      };

      const { DM_POD_TYPES_GUARD } = require('../services/agentIdentityService');
      if (DM_POD_TYPES_GUARD.has(String(existingPod.type))) {
        return refusePodNameCollision('1:1 DM pod (ADR-001 §3.10)');
      }

      const isMember = existingPod.members?.some((m: any) => m._id.toString() === agentUser._id.toString());

      // The DM guard above closes the worst case; this closes the rest of it.
      // The five other writers to `members` all gate on joinability — the
      // dedicated agent-join path (`POST /pods/:podId/self-install`) refuses
      // invite-only, refuses non-members of pods it doesn't own, and requires
      // an active installation. This branch enforced none of them, so a
      // guessed name was a credential for joining ANY non-DM pod in the
      // instance: private, invite-only, another team's — all of it, plus
      // posting rights via AgentInstallation.install and commonly-bot with
      // context:read.
      //
      // Gate on isDirectlyJoinable, not on joinPolicy. `joinPolicy: 'open'`
      // below the community tier is a dormant declaration (ADR-016:46) — it
      // means "open once listed", not "open now" — so a pod with
      // publicRead:false, communityListed:false, joinPolicy:'open' passes a
      // joinPolicy-only check and is exactly the pod that must be refused.
      // isDirectlyJoinable = isCommunityListed && joinPolicy !== 'invite-only',
      // which is the same predicate the community browse surface uses, so a
      // pod is joinable-by-name here iff it was already discoverable anyway.
      const { isDirectlyJoinable } = require('../services/podListing');
      if (!isMember && !isDirectlyJoinable(existingPod)) {
        return refusePodNameCollision('caller is not a member and the pod is not directly joinable');
      }

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
router.post('/pods/:podId/self-install', phase4RateLimit, agentRuntimeAuth, async (req: any, res: any) => {
  try {
    const agentUser = req.agentUser;
    if (!agentUser) {
      return res.status(403).json({ message: 'No bot user associated with this runtime token' });
    }

    const { podId } = req.params;
    const pod = await Pod.findById(podId)
      .select('_id name type joinPolicy createdBy members')
      .lean();
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
 * POST /decisions (agent runtime token auth)
 *
 * An agent asks a human member of its pod to choose between 2–4 declared
 * approaches. This is advisory coordination only: it carries no executable
 * action payload and therefore cannot substitute for an ApprovalAction.
 */
router.post('/decisions', phase4RateLimit, agentRuntimeAuth, async (req: any, res: any) => {
  try {
    // A human choice here is a normal chat ruling, not a consent grant. Keep
    // this envelope deliberately closed so an agent cannot smuggle a typed
    // action, scopes, or a credential reference through the friendlier
    // decision surface. Privileged work must go through `propose-action`,
    // whose owner/CAS gate is deliberately stronger.
    const DECISION_REQUEST_FIELDS = new Set([
      'podId', 'decisionClass', 'title', 'question', 'options', 'threadRootId', 'context',
    ]);
    const unsupportedFields = Object.keys(req.body || {})
      .filter((field) => !DECISION_REQUEST_FIELDS.has(field));
    if (unsupportedFields.length) {
      return res.status(400).json({
        message: `Unsupported decision request fields: ${unsupportedFields.join(', ')}.`
          + ' Use propose-action for privileged side effects.',
        code: 'unsupported_decision_fields',
      });
    }
    const {
      podId, decisionClass, title, question, options, threadRootId, context,
    } = req.body || {};
    if (typeof podId !== 'string' || !podId.trim()) {
      return res.status(400).json({ message: 'podId is required', code: 'podId_required' });
    }
    const installation = resolveInstallationForPod(
      req.agentInstallations,
      req.agentInstallation,
      podId,
    );
    if (!ensurePodMatch(req.agentInstallations || installation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }
    if (!req.agentUser?._id || !installation?.agentName) {
      return res.status(403).json({ message: 'Could not resolve agent identity' });
    }
    if (threadRootId !== undefined && typeof threadRootId !== 'string') {
      return res.status(400).json({ message: 'threadRootId must be a string', code: 'invalid_threadRootId' });
    }
    if (context !== undefined && typeof context !== 'string') {
      return res.status(400).json({ message: 'context must be a string', code: 'invalid_context' });
    }

    const result = await DecisionRequestService.requestDecision({
      podId,
      agentUserId: String(req.agentUser._id),
      agentName: installation.agentName,
      instanceId: installation.instanceId || 'default',
      displayName: installation.displayName,
      installationConfig: installation.config || null,
      decisionClass,
      title,
      question,
      options,
      threadRootId,
      context,
    });
    return res.status(201).json(result);
  } catch (error: any) {
    if (error instanceof DecisionRequestService.DecisionRequestError) {
      return res.status(error.status).json({ message: error.message, code: error.code });
    }
    console.error('POST /decisions error:', error);
    return res.status(500).json({ message: 'Failed to request a decision' });
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

// Agent runtime upload endpoint — agents post non-image files (briefs,
// notes, generated docs) into a pod they're installed in. Reuses the
// shared multer wrapper + handleUpload helper from routes/uploads.ts so
// the byte path, allowlist, and error shape match the user route.
//
// The CAP pattern is `POST /pods/:podId/<thing>`; the body is multipart
// (field name `file`) so SDKs can stream from local disk without buffering.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handleUpload, uploadSingle } = require('./uploads');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateOfficeContent } = require('../services/officeContentValidator');
router.post('/pods/:podId/uploads', agentRuntimeAuth, uploadSingle('file'), async (req: any, res: any) => {
  try {
    const { podId } = req.params;
    if (!ensurePodMatch(req.agentInstallations || req.agentInstallation, podId, req.agentAuthorizedPodIds)) {
      return res.status(403).json({ message: 'Agent token not authorized for this pod' });
    }
    if (!req.agentUser?._id) {
      return res.status(401).json({ message: 'Agent identity required' });
    }
    // Empty-office-stub guard. Agents using the bundled `officecli` skill
    // sometimes call `create` + `close` without any `add` calls in between,
    // producing a structurally-valid OOXML file with zero content
    // (`<w:body/>`, `<sheetData/>`, `<p:sldIdLst/>`). The skill's Delivery
    // Gate is supposed to catch this but the model routinely skips it.
    // Refusing the upload at the kernel makes the gate unskippable —
    // the agent gets a 422 with a clear hint and must populate before retry.
    if (req.file?.buffer && req.file?.originalname) {
      const check = validateOfficeContent(req.file.buffer, req.file.originalname);
      if (!check.ok) {
        return res.status(422).json({
          message: 'Empty office deliverable rejected',
          code: 'office_empty_stub',
          format: check.format,
          reason: check.reason,
          hint: 'Add real content with `officecli add` (paragraphs / rows / slides) before uploading. Verify with `officecli view <file> text` first.',
        });
      }
    }
    // Pin the upload to this pod regardless of what was in the form body.
    req.body = { ...(req.body || {}), podId };
    return await handleUpload(req, res, req.agentUser._id.toString());
  } catch (error: any) {
    console.error('Agent upload error:', error);
    return res.status(500).json({ message: 'Failed to upload file' });
  }
});

module.exports = router;
