/**
 * Public read-only agent PROFILE — the identity showcase (the "meet the agent"
 * surface, as opposed to the owner-only Configuration control panel).
 *
 * SECURITY-CRITICAL, same posture as routes/showcase.ts. Anonymous read path,
 * mounted WITHOUT auth; every field is whitelisted. Invariants:
 *   - GET-only, no side effects.
 *   - Serves ONLY agent (isBot) identities; humans 404 (no user-profile oracle).
 *   - Whitelisted serialization: NEVER email, tokens, credentials, private pod
 *     names, or private/pod-scoped memory.
 *   - Memory: reuses filterSectionsByVisibility with an EMPTY requester-pods set,
 *     so ONLY `public` sections are ever returned (pod-scoped needs an
 *     intersection that is empty here; private is never returned). The raw v1
 *     `content` blob is intentionally NOT read — only the filtered sections.
 *   - Pods: only publicRead pod NAMES are listed; everything else is a count, so
 *     private pod names never leak.
 *   - IP-keyed rate limit as the FIRST middleware to blunt scraping.
 */

// ESM import so CodeQL's js/missing-rate-limiting query sees the limiter.
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';
import { filterSectionsByVisibility } from '../services/agentMemoryService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentMemory = require('../models/AgentMemory');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentRun = require('../models/AgentRun');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PodAsset = require('../models/PodAsset');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveAgentDisplayLabel } = require('../services/agentIdentityService');

interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => Res | void;
}
interface Req {
  ip?: string;
  params?: { agentName?: string; instanceId?: string };
}

// ~120 req/min/IP — generous for a human, low enough to blunt scrapers. Skipped
// in tests. FIRST middleware on the router.
const profileRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: Req) => cloudflareIpRateLimitKeyGenerator(req as never),
  handler: (_req: unknown, res: Res) => res.status(429).json({ code: 'rate_limited' }),
});

const router: ReturnType<typeof express.Router> = express.Router();
router.use(profileRateLimit);

// GET /api/agent-profile/:agentName/:instanceId? — public identity card.
router.get('/:agentName/:instanceId?', async (req: Req, res: Res) => {
  try {
    const agentName = String(req.params?.agentName || '').trim().toLowerCase();
    const instanceId = String(req.params?.instanceId || 'default').trim() || 'default';
    if (!agentName) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Resolve the agent's User row (bots only — humans 404, no oracle). Whitelist
    // projection: identity + persona fields, NEVER email/password/tokens.
    const user = await User.findOne({
      isBot: true,
      'botMetadata.agentName': agentName,
      'botMetadata.instanceId': instanceId,
    })
      .select('username profilePicture isBot botMetadata agentConfig createdAt')
      .lean();
    if (!user) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const bm = (user.botMetadata || {}) as Record<string, unknown>;
    const persona = ((user.agentConfig || {}) as Record<string, unknown>).personality as
      | Record<string, unknown>
      | undefined;

    // ── Installed skills (scope=agent) ──────────────────────────────────────
    const skillDocs = await PodAsset.find({
      'metadata.scope': 'agent',
      'metadata.agentName': agentName,
      'metadata.instanceId': instanceId,
    })
      .select('title metadata.skillName metadata.description')
      .lean();
    const skills = (skillDocs as Array<Record<string, unknown>>).map((s) => {
      const meta = (s.metadata || {}) as Record<string, unknown>;
      return {
        name: String(meta.skillName || s.title || 'skill'),
        description: meta.description ? String(meta.description) : undefined,
      };
    });

    // ── Pod memberships ─────────────────────────────────────────────────────
    // Count everything; list only publicRead pod NAMES (never leak private pods).
    const installs = await AgentInstallation.find({
      agentName,
      instanceId,
      status: 'active',
    })
      .select('podId')
      .lean();
    const ownerPodIds = (installs as Array<{ podId?: { toString(): string } }>)
      .map((i) => (i?.podId ? String(i.podId) : ''))
      .filter(Boolean);
    const publicPods = ownerPodIds.length
      ? await Pod.find({ _id: { $in: ownerPodIds }, publicRead: true }).select('name').lean()
      : [];
    const publicPodNames = (publicPods as Array<{ name?: string }>)
      .map((p) => p.name)
      .filter(Boolean);

    // ── Memory (public sections only) ───────────────────────────────────────
    // Empty requester-pods ⇒ filterSectionsByVisibility returns ONLY public
    // sections. Never read record.content (the unfiltered v1 blob).
    // The profile is public, so it shows the memory LAYER as a stat (entry count
    // + last-updated — safe, non-content) plus any explicitly-public sections.
    // Entry counts reveal size, never content. Private/pod memory never leaks.
    let publicMemory: unknown = {};
    let hasMemory = false;
    let memoryUpdatedAt: unknown = null;
    let memoryEntryCount = 0;
    const memRecord = await AgentMemory.findOne({ agentName, instanceId })
      .select('sections updatedAt')
      .lean();
    if (memRecord) {
      const sections = (memRecord as Record<string, unknown>).sections;
      hasMemory = true;
      memoryUpdatedAt = (memRecord as Record<string, unknown>).updatedAt || null;
      // Count entries across sections (size only — never content).
      for (const v of Object.values((sections || {}) as Record<string, unknown>)) {
        if (Array.isArray(v)) memoryEntryCount += v.length;
        else if (v && typeof v === 'object') memoryEntryCount += 1;
      }
      publicMemory = filterSectionsByVisibility(
        sections,
        [], // requester has no shared pods → public-only
        ownerPodIds,
      );
    }

    // ── Recent activity (outcome-level, no message content) ─────────────────
    const runs = await AgentRun.find({ agentName, instanceId })
      .sort({ startedAt: -1 })
      .limit(6)
      .select('status trigger startedAt turns errorKind')
      .lean();
    const activity = (runs as Array<Record<string, unknown>>).map((r) => ({
      status: String(r.status || 'unknown'),
      trigger: r.trigger ? String(r.trigger) : undefined,
      startedAt: r.startedAt,
      turns: Array.isArray(r.turns) ? (r.turns as unknown[]).length : 0,
      errorKind: r.errorKind ? String(r.errorKind) : undefined,
    }));

    res.json({
      agent: {
        agentName,
        instanceId,
        displayName: resolveAgentDisplayLabel(user, user.username),
        profilePicture: user.profilePicture || 'default',
        runtime: bm.runtimeId ? String(bm.runtimeId) : (bm.agentName ? String(bm.agentName) : null),
        officialAgent: !!bm.officialAgent,
        description: bm.description ? String(bm.description) : undefined,
        capabilities: Array.isArray(bm.capabilities) ? (bm.capabilities as string[]) : [],
        personality: persona
          ? {
            tone: persona.tone ? String(persona.tone) : undefined,
            interests: Array.isArray(persona.interests) ? (persona.interests as string[]) : [],
          }
          : undefined,
        createdAt: user.createdAt,
      },
      skills,
      pods: { count: ownerPodIds.length, publicNames: publicPodNames },
      memory: {
        has: hasMemory,
        entryCount: memoryEntryCount,
        updatedAt: memoryUpdatedAt,
        sections: publicMemory,
      },
      activity,
    });
  } catch (err) {
    console.error('[agent-profile] error:', (err as Error).message);
    res.status(500).json({ error: 'Server Error' });
  }
});

module.exports = router;
export {};
