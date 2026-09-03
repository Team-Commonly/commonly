// Agent file routes — extracted from registry.js (GH#112)
// Handles: persona/generate, heartbeat-file (R/W), identity-file (R/W)
// ESM import for express-rate-limit, keyed per caller so limits stay isolated.
//
// PLACEMENT IS LOAD-BEARING: the limiter must come BEFORE `auth` in the
// middleware chain, not after it.
//
// Two earlier versions of this comment got the reason wrong, so here is the
// evidence rather than the conclusion. CodeQL's `js/missing-rate-limiting`
// anchors its alert to the FIRST middleware in the chain — and `auth` does a
// Mongo lookup, so a limiter placed after `auth` leaves that lookup
// unprotected and the route still flagged. Cross-tabbed against main on
// 2026-08-04: of ~37 routes with the limiter placed BEFORE auth, zero are
// flagged; of the 9 with it placed after, 6 are flagged — including the
// a2a-dms route below (#1658, open since 2026-05-11 with `inspectorRateLimit`
// applied the whole time) and the heartbeat POST (#1720, which I created by
// copying that same shape). The 3 after-auth routes that escaped are
// unexplained; I did not chase them.
//
// So the scanner was reporting something true. The cost of reordering is that
// `req.userId` is not set yet, which is why the key generators below hash the
// Authorization header instead — the idiom `routes/messages.ts` already uses
// for its pre-auth limiters, and the reason those are clean.
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
const { createHash } = require('crypto');

// Per-caller key that works BEFORE `auth` has run. Hashing the raw header
// keeps one token's budget isolated from another's without leaking the token
// into rate-limiter state; unauthenticated callers fall back to
// ipKeyGenerator so IPv6 clients can't rotate within their /64
// (ERR_ERL_KEY_GEN_IPV6, #652).
const preAuthCallerKey = (req: any) => {
  const authHeader = req.get?.('authorization');
  if (authHeader) {
    return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
  }
  return req.ip ? ipKeyGenerator(req.ip) : 'anon';
};

const express = require('express');
const auth = require('../../middleware/auth');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const AgentIdentityService = require('../../services/agentIdentityService');
const DMService = require('../../services/dmService').default;
const User = require('../../models/User');
const { generateText } = require('../../services/llmService');
const {
  writeOpenClawHeartbeatFile,
  readOpenClawHeartbeatFile,
  readOpenClawIdentityFile,
  writeWorkspaceIdentityFile,
  ensureWorkspaceIdentityFile,
} = require('../../services/agentProvisionerService');
const {
  getUserId,
  normalizeInstanceId,
  resolveInstallation,
  buildAgentProfileId,
  buildIdentityContent,
  userHasPodAccess,
  parseJsonFromText,
} = require('./helpers');

const filesRouter = express.Router({ mergeParams: true });

// Inline rate limiter for the inspector a2a-DM read surface. 120/min mirrors
// the agentsRuntime phase4 cap.
const inspectorRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: preAuthCallerKey,
  handler: (_req: any, res: any) => res.status(429).json({
    message: 'rate limit exceeded: 120 requests per 60s',
    code: 'rate_limited',
  }),
});

// Workspace-file writes (HEARTBEAT.md) touch the gateway PVC via an exec into
// the pod AND write two Mongo documents, so they are more expensive than the
// read surface above.
//
// 120/min, matching inspectorRateLimit, and NOT a tighter cap — 30 was the
// first number here and it was a guess. Measured (@sprint-review): the UI has
// five call sites, all single-agent from an open dialog, so no human reaches
// 30 by clicking. The path that can is a scripted fleet-wide heartbeat repair
// — the operation this endpoint exists to make correct — which is one POST
// per agent under one operator token. The fleet is 27 agents today. 27 of 30
// is not headroom, it is a coincidence that expires when the fleet passes 30,
// and it fails by killing a repair script partway and leaving a split
// population. Behind `auth` and keyed per caller, 120 is as un-DoS-able as 30.
const workspaceWriteRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: preAuthCallerKey,
  handler: (_req: any, res: any) => res.status(429).json({
    message: 'rate limit exceeded: 120 requests per 60s',
    code: 'rate_limited',
  }),
});

filesRouter.post('/pods/:podId/agents/:name/persona/generate', auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { instanceId } = req.body;
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

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const resolved = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });

    if (!resolved.installation) {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const profile = await AgentProfile.findOne({
      agentId: buildAgentProfileId(name, resolved.instanceId),
      podId,
    }).lean();

    const displayName = resolved.installation.displayName || profile?.name || name;
    const purpose = profile?.purpose || resolved.installation?.displayName || name;
    const seed = Math.floor(Math.random() * 1000000);

    const prompt = [
      'You are generating a random but useful persona for an AI agent in a team workspace.',
      `Seed: ${seed}.`,
      `Agent name: ${displayName}.`,
      `Agent purpose/summary: ${purpose}.`,
      'Return ONLY JSON with this shape:',
      '{',
      '  "tone": "string",',
      '  "specialties": ["string", "..."],',
      '  "boundaries": ["string", "..."],',
      '  "customInstructions": "1-2 sentences.",',
      '  "exampleInstructions": "3-6 short bullet lines as plain text, no markdown."',
      '}',
      'Keep specialties and boundaries concrete and short. Avoid emojis.',
    ].join('\n');

    let generated: Record<string, unknown> | null = null;
    try {
      const text = await generateText(prompt, { temperature: 0.7 });
      generated = parseJsonFromText(text) as Record<string, unknown> | null;
    } catch (error: unknown) {
      console.error('Persona generation failed:', (error as Error).message);
      return res.status(503).json({ error: 'Persona generation is temporarily unavailable. Please try again.' });
    }

    if (!generated || typeof generated !== 'object') {
      console.error('Persona generation returned invalid JSON');
      return res.status(502).json({ error: 'Persona generation returned an invalid response. Please try again.' });
    }

    return res.json({
      success: true,
      seed,
      persona: {
        tone: generated.tone || 'friendly',
        specialties: Array.isArray(generated.specialties) ? generated.specialties : [],
        boundaries: Array.isArray(generated.boundaries) ? generated.boundaries : [],
        customInstructions: generated.customInstructions || '',
      },
      exampleInstructions: generated.exampleInstructions || '',
    });
  } catch (error) {
    console.error('Error generating agent persona:', error);
    return res.status(500).json({ error: 'Failed to generate persona' });
  }
});

/**
 * GET /pods/:podId/agents/:name/heartbeat-file
 * Read the agent's current HEARTBEAT.md from workspace (or AgentProfile cache)
 */
filesRouter.get('/pods/:podId/agents/:name/heartbeat-file', auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { instanceId } = req.query;
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const pod = await Pod.findById(podId).lean();
    if (!pod) return res.status(404).json({ error: 'Pod not found' });

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });
    if (!membership && !isCreator) return res.status(403).json({ error: 'Access denied' });

    const resolved = await resolveInstallation({ agentName: name, podId, instanceId });
    if (!resolved.installation) return res.status(404).json({ error: 'Agent not installed in this pod' });

    const accountId = normalizeInstanceId(resolved.instanceId);

    // Try reading live from PVC first; fall back to AgentProfile cached copy
    let content = '';
    let readFromWorkspace = false;
    try {
      content = await readOpenClawHeartbeatFile(accountId);
      readFromWorkspace = Boolean(String(content || '').trim());
    } catch (_) { /* fall through */ }

    if (!content) {
      const profile = await AgentProfile.findOne({
        podId,
        agentName: name.toLowerCase(),
        instanceId: resolved.instanceId,
      }).select('heartbeatContent').lean();
      content = profile?.heartbeatContent || '';
    } else if (readFromWorkspace) {
      AgentProfile.updateMany(
        { podId, agentName: name.toLowerCase(), instanceId: resolved.instanceId },
        { $set: { heartbeatContent: content } },
      ).catch((profileErr: any) => {
        console.warn('[heartbeat-file] Failed to sync AgentProfile cache from workspace:', profileErr.message);
      });
    }

    return res.json({ content, accountId });
  } catch (error) {
    console.error('Error reading heartbeat file:', error);
    return res.status(500).json({ error: 'Failed to read heartbeat file' });
  }
});

filesRouter.post('/pods/:podId/agents/:name/heartbeat-file', workspaceWriteRateLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, content, reset } = req.body;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (name.toLowerCase() !== 'openclaw') {
      return res.status(400).json({ error: 'Heartbeat file updates are only supported for OpenClaw agents.' });
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
      return res.status(403).json({ error: 'Access denied' });
    }

    const resolved = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });

    if (!resolved.installation) {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const normalizedInstanceId = normalizeInstanceId(resolved.instanceId);
    const accountId = normalizedInstanceId;
    const trimmed = String(content || '').trim();
    const normalized = trimmed
      ? (trimmed.startsWith('#') ? `${trimmed}\n` : `# HEARTBEAT.md\n\n${trimmed}\n`)
      : '# HEARTBEAT.md\n\n';

    const filePath = await writeOpenClawHeartbeatFile(accountId, normalized, { allowEmpty: true });

    // Persist to AgentProfile so config card can read it without PVC access
    try {
      await AgentProfile.updateMany(
        { podId, agentName: name.toLowerCase(), instanceId: resolved.instanceId },
        { $set: { heartbeatContent: normalized } },
      );
    } catch (profileErr: unknown) {
      console.warn('[heartbeat-file] Failed to persist to AgentProfile:', (profileErr as Error).message);
    }

    // Record the file as user-owned. `customizations.heartbeat` is the flag the
    // provisioner checks before overwriting HEARTBEAT.md (`skipHeartbeat` in
    // agentProvisionerServiceK8s), and until now NOTHING set it — this endpoint
    // wrote the file and left the installation looking un-customized, so the
    // next reprovision was free to clobber a hand-authored template. The flag
    // belongs here because this is where the customization actually happens;
    // setting it only at install time protected the one case that never needed
    // protecting. A `reset` clears it: the user is asking for the default back,
    // which is precisely the state in which the provisioner should own the file.
    try {
      await AgentInstallation.updateOne(
        { _id: resolved.installation._id },
        { $set: { 'config.customizations.heartbeat': !reset } },
      );
    } catch (flagErr: unknown) {
      console.warn('[heartbeat-file] Failed to record heartbeat customization flag:', (flagErr as Error).message);
    }

    return res.json({ success: true, path: filePath, reset: Boolean(reset) });
  } catch (error) {
    console.error('Error updating heartbeat file:', error);
    return res.status(500).json({ error: 'Failed to update heartbeat file' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name/identity-file
 * Read IDENTITY.md from agent workspace
 */
filesRouter.get('/pods/:podId/agents/:name/identity-file', auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { instanceId } = req.query;
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const pod = await Pod.findById(podId).lean();
    if (!pod) return res.status(404).json({ error: 'Pod not found' });

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });
    if (!membership && !isCreator) return res.status(403).json({ error: 'Access denied' });

    const resolved = await resolveInstallation({ agentName: name, podId, instanceId });
    if (!resolved.installation) return res.status(404).json({ error: 'Agent not installed in this pod' });

    const accountId = normalizeInstanceId(resolved.instanceId);

    let content = '';
    try {
      content = await readOpenClawIdentityFile(accountId);
    } catch (_) { /* fall through */ }

    return res.json({ content, accountId });
  } catch (error) {
    console.error('Error reading identity file:', error);
    return res.status(500).json({ error: 'Failed to read identity file' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/identity-file
 * Write IDENTITY.md to agent workspace
 */
filesRouter.post('/pods/:podId/agents/:name/identity-file', auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, content } = req.body;
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    if (name.toLowerCase() !== 'openclaw') {
      return res.status(400).json({ error: 'Identity file updates are only supported for OpenClaw agents.' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) return res.status(404).json({ error: 'Pod not found' });

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });
    if (!membership && !isCreator) return res.status(403).json({ error: 'Access denied' });

    const resolved = await resolveInstallation({ agentName: name, podId, instanceId });
    if (!resolved.installation) return res.status(404).json({ error: 'Agent not installed in this pod' });

    const accountId = normalizeInstanceId(resolved.instanceId);
    const normalized = String(content || '').trim();
    const filePath = await writeWorkspaceIdentityFile(accountId, normalized);

    return res.json({ success: true, path: filePath });
  } catch (error) {
    console.error('Error updating identity file:', error);
    return res.status(500).json({ error: 'Failed to update identity file' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name/a2a-dms?instanceId=...
 *
 * List `agent-dm` pods involving the (name, instanceId) agent. Sprint B1
 * surface — used by V2 pod inspector member-detail to render clickable
 * "Direct messages" links so humans can observe agent ↔ agent
 * conversations happening between agents in their team pods.
 *
 * Auth: caller must be a member of :podId (to scope the surface to "the
 * agent that's in this pod"). Each returned DM is then filtered through
 * `DMService.canViewPod` (the §3.7 co-pod-member rule) — humans see DMs
 * where they share at least one pod with both members.
 */
filesRouter.get('/pods/:podId/agents/:name/a2a-dms', inspectorRateLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { instanceId } = req.query;
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const pod = await Pod.findById(podId).lean();
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (!(await userHasPodAccess(pod, userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Resolve the (agentName, instanceId) agent to its User row. READ-ONLY
    // lookup — we never mint a User on this inspector surface (read-path
    // upserts violate identity continuity per CLAUDE.md). If the User row
    // doesn't exist yet, return empty.
    const resolved = await resolveInstallation({ agentName: name, podId, instanceId });
    if (!resolved.installation) return res.json({ a2aDms: [] });

    const agentUsername = AgentIdentityService.buildAgentUsername(name, resolved.instanceId);
    const agentUser = await User.findOne({ username: agentUsername }).select('_id username').lean();
    if (!agentUser) return res.json({ a2aDms: [] });

    // Find every agent-dm pod containing this User. Members are stored as
    // ObjectId references in lean results; match against the User's _id
    // directly. `canViewPod` accepts the same shape so the filter loop is
    // consistent.
    const dms = await Pod.find({
      type: 'agent-dm',
      members: agentUser._id,
    })
      .select('_id name members type updatedAt latestSummary')
      .lean() as Array<{ _id: unknown; name?: string; members?: unknown[]; type?: string; updatedAt?: Date; latestSummary?: unknown }>;

    // Batched lookup of every "other" member across all DMs — avoids the
    // N+1 User.find pattern. agent-dm pods are strictly 1:1 per ADR-001
    // §3.10 so we expect at most one other per DM, but we don't enforce
    // that here; the loop below picks the first non-self member.
    const allOtherIds = new Set<string>();
    const selfId = String(agentUser._id);
    for (const dm of dms) {
      for (const m of dm.members || []) {
        const id = String((m as { _id?: unknown })?._id || m || '');
        if (id && id !== selfId) allOtherIds.add(id);
      }
    }
    const otherUserMap = new Map<string, { _id: unknown; username?: string; botMetadata?: { displayName?: string; instanceId?: string; agentName?: string }; isBot?: boolean }>();
    if (allOtherIds.size > 0) {
      const otherUsers = await User.find({ _id: { $in: Array.from(allOtherIds) } })
        .select('username botMetadata isBot')
        .lean() as Array<{ _id: unknown; username?: string; botMetadata?: { displayName?: string; instanceId?: string; agentName?: string }; isBot?: boolean }>;
      for (const u of otherUsers) otherUserMap.set(String(u._id), u);
    }

    const a2aDms: Array<Record<string, unknown>> = [];
    for (const dm of dms) {
      // §3.7 viewer-access gate. canViewPod's countDocuments is one round
      // trip per DM; for the demo surface (bounded DM count per agent)
      // this is fine. If this becomes a paginated surface, batch via a
      // single aggregation against the viewer's shared-pods set.
      // eslint-disable-next-line no-await-in-loop
      const canView = await DMService.canViewPod(userId, dm);
      if (!canView) continue;

      const otherId = (dm.members || [])
        .map((m: any) => String(m?._id || m || ''))
        .find((id: string) => id && id !== selfId) || '';
      const otherMember = otherUserMap.get(otherId) || null;
      const otherDisplay = otherMember
        ? AgentIdentityService.resolveAgentDisplayLabel(otherMember, otherMember.username || 'peer')
        : 'peer';

      a2aDms.push({
        podId: String(dm._id),
        name: dm.name || `${agentUser.username || name} ↔ ${otherDisplay}`,
        // NOTE: `botMetadata.agentName` is the runtime tag (per
        // `feedback-runtime-leak-in-display-paths`), not a display
        // surface. We intentionally do NOT include `agentName` /
        // `instanceId` in the response — frontend renders via
        // `displayName` only. Future callers should add fields with
        // care if they need them.
        otherMember: otherMember
          ? {
            userId: String(otherMember._id),
            displayName: otherDisplay,
            isBot: Boolean(otherMember.isBot),
          }
          : null,
        memberCount: Array.isArray(dm.members) ? dm.members.length : 0,
        updatedAt: dm.updatedAt,
        latestSummary: dm.latestSummary || null,
      });
    }

    return res.json({ a2aDms });
  } catch (error) {
    console.error('Error listing a2a-dms:', error);
    return res.status(500).json({ error: 'Failed to list agent-DM pods' });
  }
});

module.exports = filesRouter;

export {};
