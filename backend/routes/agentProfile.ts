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
const AgentProfile = require('../models/AgentProfile');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentMemory = require('../models/AgentMemory');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentRun = require('../models/AgentRun');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PodAsset = require('../models/PodAsset');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PGMessage = require('../models/pg/Message');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveAgentDisplayLabel } = require('../services/agentIdentityService');
// eslint-disable-next-line global-require
const AgentIdentityService = require('../services/agentIdentityService');
// eslint-disable-next-line global-require
const authMiddleware = require('../middleware/auth');
// eslint-disable-next-line global-require
const { AgentRegistry } = require('../models/AgentRegistry');

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

    // ── Installed skills (agent-scoped skill assets) ────────────────────────
    // MUST filter type:'skill' — scope:'agent' alone also matches the agent's
    // memory / daily-log PodAssets, which are NOT skills. Agent-scoped skills are
    // rare today (skills are mostly pod-scoped), so this is usually empty and the
    // frontend hides the section; capabilities carry the "what it does" story.
    const skillDocs = await PodAsset.find({
      type: 'skill',
      status: 'active',
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
      // A public profile is identity-wide, while these two label fields are
      // pod-scoped. Sort so the first active attachment is deterministic; its
      // profile label has the same precedence as the Your Team payload.
      .sort({ createdAt: 1, _id: 1 })
      .select('podId displayName')
      .lean();
    const ownerPodIds = (installs as Array<{ podId?: { toString(): string } }>)
      .map((i) => (i?.podId ? String(i.podId) : ''))
      .filter(Boolean);
    // AgentProfile.name and AgentInstallation.displayName are the curated
    // labels written at install time. The User row's username is a stable
    // runtime seat identifier, not necessarily a human-facing name. Pair each
    // profile with its active installation so a stale, detached profile cannot
    // affect this public identity card.
    const scopedProfiles = ownerPodIds.length
      ? await AgentProfile.find({
        podId: { $in: ownerPodIds },
        agentName,
        instanceId,
        status: 'active',
      }).select('podId name').lean()
      : [];
    const profileNameByPodId = new Map(
      (scopedProfiles as Array<{ podId?: unknown; name?: string }>).map((profile) => [
        String(profile.podId),
        typeof profile.name === 'string' ? profile.name.trim() : '',
      ]),
    );
    const scopedDisplayName = (installs as Array<{ podId?: unknown; displayName?: string }>)
      .map((installation) => (
        profileNameByPodId.get(String(installation.podId))
        || (typeof installation.displayName === 'string' ? installation.displayName.trim() : '')
      ))
      .find(Boolean);
    const publicPodDocs = ownerPodIds.length
      ? await Pod.find({ _id: { $in: ownerPodIds }, publicRead: true }).select('name').lean()
      : [];
    // Enrich public pods with last-activity so the list can sort by "most active".
    // Only publicRead pods here — private pod names never leak on the public view.
    const publicPodIds = (publicPodDocs as Array<{ _id?: unknown }>).map((p) => String(p._id));
    let activityByPod = new Map<string, unknown>();
    if (publicPodIds.length) {
      try {
        const acts = await PGMessage.findMostRecentPodActivity(publicPodIds, new Date(0));
        activityByPod = new Map((acts as Array<{ podId: string; lastAt: unknown }>).map((a) => [String(a.podId), a.lastAt]));
      } catch { /* PG unavailable — pods still list, just unsorted by activity */ }
    }
    const publicPods = (publicPodDocs as Array<{ _id?: unknown; name?: string }>)
      .map((p) => ({ id: String(p._id), name: p.name || 'pod', lastActive: activityByPod.get(String(p._id)) || null }))
      .sort((a, b) => (new Date((b.lastActive as string) || 0).getTime()) - (new Date((a.lastActive as string) || 0).getTime()));

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
        sections as Parameters<typeof filterSectionsByVisibility>[0],
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
        displayName: scopedDisplayName || resolveAgentDisplayLabel(user, user.username),
        profilePicture: user.profilePicture || 'default',
        // agentName is a legacy identity field, not a runtime descriptor. Falling
        // back to it rendered the raw seat name as a misleading runtime badge.
        runtime: bm.runtimeId ? String(bm.runtimeId) : null,
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
      pods: { count: ownerPodIds.length, public: publicPods },
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


// ── Owner-editable agent avatar (Sam, 2026-08-20) ───────────────────────────
//
// "If created by someone" — the gate is creation-shaped: the caller must be an
// admin or the installer of an active installation of this agent. Accepts the
// deterministic robot scheme ('bottts:<seed>') or an uploaded-image reference;
// never raw AI generation, which is deprecated.
//
// Writes go through the ONE sanctioned door for the dual-store problem:
// Mongo User first, then AgentIdentityService.syncUserToPostgreSQL — the July
// half-write incident is why no code path may touch pg users directly. If the
// mirror is retired (#1062), the sync call becomes a no-op and this endpoint
// stays correct unchanged. The registry iconUrl (the Your-Team card source)
// moves in the same request so the three icon surfaces cannot drift.

const canEditAgentAvatar = async (req: any, agentName: string, instanceId: string): Promise<boolean> => {
  const callerId = req.userId || req.user?._id || req.user?.id;
  if (!callerId) return false;
  // JWT auth populates req.user = { id } WITHOUT role (middleware/auth.ts:81)
  // — only the cm_ API-token branch carries role. Trusting req.user.role here
  // silently disabled the admin path for every browser session, so load it.
  if (req.user?.role === 'admin') return true;
  const caller = await User.findById(callerId).select('role').lean();
  if (caller?.role === 'admin') return true;
  const owned = await AgentInstallation.findOne({
    agentName,
    instanceId,
    status: 'active',
    installedBy: callerId,
  }).select('_id').lean();
  return Boolean(owned);
};

const AGENT_AVATAR_SCHEME = /^bottts:[\w:.-]{1,120}$/;
const isUploadRef = (v: string): boolean => (
  v.startsWith('/api/uploads/') || v.startsWith('/uploads/') || /^https:\/\/[^\s]+\/(api\/)?uploads\//.test(v)
);

router.get('/:agentName/:instanceId?/avatar/can-edit', authMiddleware, async (req: any, res: Res) => {
  const agentName = String(req.params?.agentName || '').trim().toLowerCase();
  const instanceId = String(req.params?.instanceId || 'default').trim() || 'default';
  res.json({ canEdit: await canEditAgentAvatar(req, agentName, instanceId) });
});

router.put('/:agentName/:instanceId?/avatar', authMiddleware, async (req: any, res: Res) => {
  try {
    const agentName = String(req.params?.agentName || '').trim().toLowerCase();
    const instanceId = String(req.params?.instanceId || 'default').trim() || 'default';
    const avatar = String(req.body?.avatar || '').trim();

    if (!AGENT_AVATAR_SCHEME.test(avatar) && !isUploadRef(avatar)) {
      res.status(400).json({ error: 'avatar must be a bottts:<seed> preset or an uploaded image reference' });
      return;
    }
    if (!(await canEditAgentAvatar(req, agentName, instanceId))) {
      res.status(403).json({ error: "Only the agent's installer or an admin can edit its avatar" });
      return;
    }

    const user = await User.findOneAndUpdate(
      { isBot: true, 'botMetadata.agentName': agentName, 'botMetadata.instanceId': instanceId },
      { $set: { profilePicture: avatar } },
      { new: true },
    );
    if (!user) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // The chat stream reads the PG mirror; skipping this line is exactly the
    // July incident. Fire-and-log rather than fail the request: Mongo is the
    // source of truth.
    try {
      await AgentIdentityService.syncUserToPostgreSQL(user);
    } catch (syncErr) {
      console.warn('[agent-avatar] pg mirror sync failed (mongo committed):', (syncErr as Error).message);
    }

    // Your-Team cards read AgentRegistry.iconUrl; move it in the same request.
    try {
      await AgentRegistry.updateOne({ agentName }, { $set: { iconUrl: avatar } });
    } catch (regErr) {
      console.warn('[agent-avatar] registry iconUrl update failed:', (regErr as Error).message);
    }

    res.json({ ok: true, avatar });
  } catch (err) {
    console.error('[agent-avatar] update failed:', err);
    res.status(500).json({ error: 'Failed to update avatar' });
  }
});

module.exports = router;
export {};
