// Agent catalog browse routes — extracted from registry.js (GH#112)
const express = require('express');
const mongoose = require('mongoose');
const auth = require('../../middleware/auth');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentIdentityService = require('../../services/agentIdentityService');
const { nextFreeByoName } = require('../../services/byoNameAllocator');
const { readRegistryDisplay, readRegistryDisplayOne } = require('../../services/installable/registryReader');
const {
  getUserId,
  normalizeInstanceId,
  parseVerifiedFilter,
  userHasPodAccess,
} = require('./helpers');

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { rateLimit } = require('express-rate-limit');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { cloudflareIpRateLimitKeyGenerator } = require('../../middleware/ipRateLimit');

const catalogRouter = express.Router();

// ~120 req/min/IP, same shape as agentProfile's limiter: generous for a
// human browsing the catalog, low enough to blunt scrapers now that every
// listing request may also cost a role lookup. Skipped in tests.
//
// Attached per route, never via `catalogRouter.use`: registry.ts mounts this
// router ahead of pod-agents, files, install and the rest, so a router-level
// limiter ran for every /api/registry/* request and spent the catalog budget
// on them. /v2/agents reads `/pods/:podId/agents` once per pod, and a 62-pod
// account hit 429 on every call from its third load (10-28).
const catalogRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: any) => cloudflareIpRateLimitKeyGenerator(req),
  handler: (_req: any, res: any) => res.status(429).json({ code: 'rate_limited' }),
});

/** Suggest a free BYO name across the caller's installable pods. */
catalogRouter.get('/agents/next-free-name', catalogRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const memberId = new mongoose.Types.ObjectId(String(userId));
    const base = req.query.base;
    const selectedPodId = typeof req.query.podId === 'string' ? req.query.podId : '';
    if (typeof base !== 'string' || base.length < 1 || base.length > 64
        || !/^[a-z0-9-]+$/.test(base)) {
      return res.status(400).json({ error: 'Invalid agent name' });
    }

    // The shared rule: the connect card proposes the same name (TASK-329).
    const name = await nextFreeByoName(memberId, base, { podId: selectedPodId });
    return res.json({ name });
  } catch (error) {
    console.error('Error suggesting BYO agent name:', error);
    return res.status(500).json({ error: 'Failed to suggest agent name' });
  }
});

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
 * Pair each installation with its pod, keeping only pods the caller can see.
 * Same rule as /agents/:name/installations: member or creator. Admins see the
 * same list, since these are listing surfaces (admins have /admin/installations).
 */
const filterToVisibleInstallations = async (installations: any[], userId: any) => {
  const podIds = installations.map((i: any) => i.podId).filter(Boolean);
  if (!podIds.length) return [];
  const pods = await Pod.find({ _id: { $in: podIds } })
    .select('name members createdBy')
    .lean();
  const podMap = new Map(pods.map((pod: any) => [pod._id.toString(), pod]));
  return installations
    .map((install: any) => ({ install, pod: podMap.get(install.podId?.toString?.()) as any }))
    .filter(({ pod }: any) => pod && userHasPodAccess(pod, userId));
};

/**
 * GET /api/registry/agents
 * List available agents in the registry
 */
catalogRouter.get('/agents', catalogRateLimit, auth, async (req: any, res: any) => {
  try {
    const {
      q, category, verified, registry, limit = 20, offset = 0,
    } = req.query;

    // ADR-022 leak, Phase 0 fix: 31 of 45 active registry rows are smoke
    // seats, fleet internals, and personal wrappers — never a hire option.
    // The verified flag is already the curation boundary in the data, so
    // non-admins get verified-only REGARDLESS of query params; only admins
    // (registry ops tooling) may list the rest. Role comes from the DB, not
    // req.user — JWT sessions carry { id } only (the #1065 lesson).
    let verifiedFilter = parseVerifiedFilter(verified);
    if (verifiedFilter !== true) {
      const caller = await User.findById(req.userId).select('role').lean();
      if ((caller as { role?: string } | null)?.role !== 'admin') verifiedFilter = true;
    }

    const agents = await AgentRegistry.search(q, {
      category,
      verified: verifiedFilter,
      registry: registry || null,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });

    // The moltbot tier is PARKED (#1050): its gateway runs at zero replicas
    // and its credentials died 2026-07-02. Offering its agents in the hire
    // catalog sells a seat nothing will ever answer from — a user installs
    // NewsHound, mentions it, and gets the exact silent-dead-seat experience
    // the park exists to stop pretending about. Registry rows carry no runtime
    // discriminator (all 45 are unset), so the canonical AGENT_TYPES map is
    // the filter. When the pi/OpenCode adapters revive these identities under
    // a new runtime, the map entry changes and they reappear here on their
    // own — deprecation follows the runtime, not a hand-kept list.
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentIdentityService = require('../../services/agentIdentityService');
    const listable = agents.filter((a: any) => {
      const cfg = AgentIdentityService.getAgentTypeConfig(a.agentName);
      return !cfg || cfg.runtime !== 'moltbot';
    });
    // The gates above stay on AgentRegistry; only the returned rows' display
    // fields go through the read-path flag (ADR-001 Phase 3).
    const shown = await readRegistryDisplay(listable, 'catalog.list');

    res.json({
      agents: shown.map((a: any) => ({
        name: a.agentName,
        displayName: a.displayName,
        description: a.description,
        version: a.latestVersion,
        verified: a.verified,
        categories: a.categories,
        stats: a.stats,
        iconUrl: a.iconUrl,
      })),
      total: shown.length,
    });
  } catch (error) {
    console.error('Error listing agents:', error);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

/**
 * GET /api/registry/agents/:name
 * Get agent details
 */
catalogRouter.get('/agents/:name', catalogRateLimit, auth, async (req: any, res: any) => {
  try {
    const agent = await readRegistryDisplayOne(
      await AgentRegistry.getByName(req.params.name),
      'catalog.detail',
    );

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({
      name: agent.agentName,
      displayName: agent.displayName,
      description: agent.description,
      readme: agent.readme,
      version: agent.latestVersion,
      versions: agent.versions.map((v: any) => ({
        version: v.version,
        publishedAt: v.publishedAt,
        deprecated: v.deprecated,
      })),
      manifest: agent.manifest,
      status: agent.status,
      registry: agent.registry,
      ephemeral: agent.ephemeral === true,
      verified: agent.verified,
      publisher: agent.publisher,
      categories: agent.categories,
      tags: agent.tags,
      stats: agent.stats,
      iconUrl: agent.iconUrl,
    });
  } catch (error) {
    console.error('Error getting agent:', error);
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

/**
 * GET /api/registry/agents/:name/instances/:instanceId
 * Check if an agent instance exists, listing the pods the caller can see.
 */
catalogRouter.get('/agents/:name/instances/:instanceId', catalogRateLimit, auth, async (req: any, res: any) => {
  try {
    const { name, instanceId } = req.params;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const normalizedInstanceId = normalizeInstanceId(instanceId);
    const globalAgent = await findExistingAgentInstance(name, normalizedInstanceId);

    if (!globalAgent.exists) {
      return res.json({ exists: false });
    }

    // Only installations in pods the caller can see, the same rule as
    // /agents/:name/installations below. `exists` stays global so a caller
    // never reads a taken name as free; the runtime details go out only to a
    // caller who shares at least one pod with the instance.
    const visible = await filterToVisibleInstallations(globalAgent.installations, userId);
    const body: any = {
      exists: true,
      installations: visible.map(({ install: i, pod }: any) => ({
        podId: i.podId.toString(),
        podName: pod.name,
        displayName: i.displayName,
        instanceId: i.instanceId,
        provisionedAt: i.config?.runtime?.provisionedAt || null,
      })),
    };
    if (visible.length > 0) {
      body.hasRuntimeToken = (globalAgent.agentUser?.agentRuntimeTokens?.length || 0) > 0;
      body.agentUsername = globalAgent.agentUser?.username || null;
    }
    return res.json(body);
  } catch (error) {
    console.error('Error checking agent instance:', error);
    return res.status(500).json({ error: 'Failed to check agent instance' });
  }
});

/**
 * GET /api/registry/agents/:name/instances
 * List the instances of an agent type in pods the caller can see.
 */
catalogRouter.get('/agents/:name/instances', catalogRateLimit, auth, async (req: any, res: any) => {
  try {
    const { name } = req.params;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const installations = await AgentInstallation.find({
      agentName: name.toLowerCase(),
      status: 'active',
    }).lean();

    // Only pods the caller can see; an instance with none is left out.
    const visible = await filterToVisibleInstallations(installations, userId);
    const instanceMap = new Map();
    visible.forEach(({ install: i, pod }: any) => {
      const key = i.instanceId || 'default';
      if (!instanceMap.has(key)) {
        instanceMap.set(key, {
          instanceId: key,
          displayName: i.displayName,
          pods: [],
        });
      }
      instanceMap.get(key).pods.push({ podId: i.podId.toString(), podName: pod.name });
    });

    const instances = Array.from(instanceMap.values());

    return res.json({ instances });
  } catch (error) {
    console.error('Error listing agent instances:', error);
    return res.status(500).json({ error: 'Failed to list agent instances' });
  }
});

/**
 * GET /api/registry/categories
 * List agent categories
 */
catalogRouter.get('/categories', catalogRateLimit, auth, async (req: any, res: any) => {
  try {
    const categories = await AgentRegistry.distinct('categories');
    res.json({ categories });
  } catch (error) {
    console.error('Error listing categories:', error);
    res.status(500).json({ error: 'Failed to list categories' });
  }
});

/**
 * GET /api/registry/agents/:name/installations
 * List pods where an agent instance is installed (user-visible only)
 */
catalogRouter.get('/agents/:name/installations', catalogRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const agentName = String(req.params.name || '').toLowerCase();
    const instanceId = normalizeInstanceId(req.query.instanceId);
    const installations = await AgentInstallation.find({
      agentName,
      instanceId,
      status: 'active',
    }).lean();
    if (!installations.length) {
      return res.json({ installations: [] });
    }
    const podIds = installations.map((i: any) => i.podId).filter(Boolean);
    const pods = await Pod.find({ _id: { $in: podIds } })
      .select('name members createdBy')
      .lean();
    const podMap = new Map(pods.map((pod: any) => [pod._id.toString(), pod]));
    const results = installations
      .map((install: any) => {
        const pod = podMap.get(install.podId?.toString?.()) as any;
        if (!pod || !userHasPodAccess(pod, userId)) return null;
        return {
          podId: pod._id,
          podName: pod.name,
          instanceId: install.instanceId,
        };
      })
      .filter(Boolean);
    return res.json({ installations: results });
  } catch (error) {
    console.error('Error listing agent installations:', error);
    return res.status(500).json({ error: 'Failed to list installations' });
  }
});

module.exports = catalogRouter;

export {};
