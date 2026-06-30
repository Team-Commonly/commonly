/**
 * Public read-only showcase — the launch front-door.
 *
 * SECURITY-CRITICAL. This is the ONLY anonymous (unauthenticated) read path
 * in the API, and it is hard-gated: it serves exactly ONE flagged pod
 * (`pod.publicRead === true`) and nothing else. It is mounted WITHOUT the
 * auth middleware on purpose — every handler self-gates on `publicRead`.
 *
 * Invariants defended here:
 *   - GET-only, no side effects.
 *   - Same 404 for "pod missing" and "pod not public" — no existence oracle.
 *   - Whitelisted serialization: NEVER email, memory, persona/skills, or any
 *     field beyond the SHARED API CONTRACT shape.
 *   - Messages pass through the NOISE-FILTER (isShowcaseWorthy) so the public
 *     view is substantive human + agent turns only — no errors / heartbeat
 *     cruft / failover spam / empty turns.
 *   - IP-keyed rate limit as the FIRST middleware to blunt scraping.
 *
 * It does NOT relax auth on any generic route; it is a dedicated endpoint.
 */

// ESM import (not require) so CodeQL's js/missing-rate-limiting query
// recognises the limiter on the router — same pattern as routes/uploads.ts.
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mongoose = require('mongoose');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MongoMessage = require('../models/Message');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PGMessage = require('../models/pg/Message');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentMessageService = require('../services/agentMessageService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveAgentDisplayLabel } = require('../services/agentIdentityService');

interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => Res | void;
}
interface Req {
  ip?: string;
  params?: { podId?: string };
  query?: { limit?: string; before?: string };
}

// ── NOISE-FILTER ──────────────────────────────────────────────────────────
// Public view must be clean — "not full of errors and bs". Drop any message
// that isn't a substantive turn. Conservative by design: when unsure, hide.
//
// Markers (sourced from the live message pipeline, not invented here):
//   - empty / whitespace-only content
//   - system messages (messageType/message_type === 'system' — join/leave,
//     install banners, etc.)
//   - NO_REPLY sentinels (silent-turn marker the runtimes emit)
//   - heartbeat housekeeping cruft (AgentMessageService.isHeartbeatHousekeepingContent
//     — "HEARTBEAT_OK", "no new activity to report", "let me try a different
//     approach", etc.)
//   - runtime model-failure / failover errors (AgentMessageService.isRuntimeModelFailure
//     — "⚠️ Agent failed before reply: All models failed ...")
//   - generic error / stack-trace content (AgentMessageService.isErrorContent)
//
// Exported for unit testing.
interface ShowcaseMessageLike {
  content?: unknown;
  messageType?: unknown;
  message_type?: unknown;
}
function isShowcaseWorthy(message: ShowcaseMessageLike): boolean {
  if (!message) return false;
  const content = String(message.content ?? '').trim();
  if (!content) return false;

  const type = String(message.messageType ?? message.message_type ?? 'text').toLowerCase();
  if (type === 'system') return false;

  // Bare NO_REPLY sentinel (silent turn). A message that merely contains
  // NO_REPLY among real prose is rare and is left to the heartbeat/error
  // predicates below; here we only drop the pure sentinel.
  if (/^no_reply$/i.test(content)) return false;

  if (AgentMessageService.isHeartbeatHousekeepingContent(content)) return false;
  if (AgentMessageService.isRuntimeModelFailure(content)) return false;
  if (AgentMessageService.isErrorContent(content)) return false;

  return true;
}

// IP-keyed limiter, FIRST middleware on the router. ~120 req/min/IP — generous
// for a human browsing the showcase, low enough to blunt scrapers. Skipped in
// tests so the suite isn't throttled.
const showcaseRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: Req) => (req.ip ? ipKeyGenerator(req.ip) : 'anon'),
  handler: (_req: unknown, res: Res) => res.status(429).json({ code: 'rate_limited' }),
});

const router: ReturnType<typeof express.Router> = express.Router();

router.use(showcaseRateLimit);

// Load the full pod doc (NOT a narrow .select that could omit publicRead) and
// enforce the gate. Returns the pod when public, else null — callers emit the
// SAME 404 for "missing" and "not public" so there's no existence oracle.
const loadPublicPod = async (podId: string | undefined) => {
  if (!podId || !mongoose.Types.ObjectId.isValid(podId)) return null;
  const pod = await Pod.findById(podId).populate(
    'members',
    // Whitelist — NEVER email. botMetadata carries only display identity
    // (displayName / agentName / instanceId), no secrets.
    'username profilePicture isBot botMetadata',
  );
  if (!pod || pod.publicRead !== true) return null;
  return pod;
};

interface MemberDoc {
  _id?: { toString(): string };
  username?: string;
  profilePicture?: string;
  isBot?: boolean;
  botMetadata?: { displayName?: string; agentName?: string; instanceId?: string };
}

const serializeMember = (m: MemberDoc) => {
  const isBot = !!m.isBot;
  const base = {
    username: m.username || '',
    displayName: isBot
      ? resolveAgentDisplayLabel(m, m.username)
      : (m.botMetadata?.displayName || m.username || ''),
    profilePicture: m.profilePicture || 'default',
    isBot,
  };
  if (isBot) {
    return {
      ...base,
      agentName: m.botMetadata?.agentName,
      instanceId: m.botMetadata?.instanceId,
    };
  }
  return base;
};

// GET /api/showcase/:podId — pod meta + whitelisted members + agent identities.
router.get('/:podId', async (req: Req, res: Res) => {
  try {
    const pod = await loadPublicPod(req.params?.podId);
    if (!pod) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const members = (pod.members || []) as MemberDoc[];
    const serializedMembers = members.map(serializeMember);
    const agents = members
      .filter((m) => !!m.isBot)
      .map((m) => ({
        displayName: resolveAgentDisplayLabel(m, m.username),
        agentName: m.botMetadata?.agentName,
        instanceId: m.botMetadata?.instanceId,
        profilePicture: m.profilePicture || 'default',
      }));

    res.json({
      pod: {
        id: pod._id.toString(),
        name: pod.name,
        description: pod.description,
        type: pod.type,
        memberCount: members.length,
        createdAt: pod.createdAt,
      },
      members: serializedMembers,
      agents,
    });
  } catch (err) {
    console.error('[showcase] GET /:podId error:', (err as Error).message);
    res.status(500).json({ error: 'Server Error' });
  }
});

interface RawMessage {
  id: string;
  content: string;
  messageType: string;
  createdAt: unknown;
  userId: string;
}

// Read newest-`limit` messages before the cursor, ascending (chronological),
// PG-first with a Mongo fallback (mirrors messageController.getMessages). The
// raw read is store-agnostic; display identity + the noise-filter + the
// whitelist serializer are applied uniformly afterwards so neither store can
// leak a non-whitelisted field.
const readRawMessages = async (
  podId: string,
  limit: number,
  before?: string,
): Promise<{ raw: RawMessage[]; hasMore: boolean }> => {
  try {
    const rows = await PGMessage.findByPodId(podId, limit, before || null);
    const raw = (rows as Array<Record<string, unknown>>).map((r) => {
      const uid = r.user_id
        || (r.userId && typeof r.userId === 'object'
          ? (r.userId as { _id?: { toString(): string } })._id
          : r.userId);
      return {
        id: String(r.id ?? r._id ?? ''),
        content: String(r.content ?? ''),
        messageType: String(r.messageType ?? r.message_type ?? 'text'),
        createdAt: r.createdAt ?? r.created_at,
        userId: uid ? String(uid) : '',
      };
    });
    return { raw, hasMore: rows.length === limit };
  } catch (pgErr) {
    console.warn('[showcase] PG unavailable, falling back to Mongo:', (pgErr as Error).message);
  }

  const query: Record<string, unknown> = { podId };
  if (before) query.createdAt = { $lt: new Date(before) };
  const docs = await MongoMessage.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  const raw = (docs as Array<Record<string, unknown>>)
    .slice()
    .reverse()
    .map((m) => ({
      id: String(m._id),
      content: String(m.content ?? ''),
      messageType: String(m.messageType ?? 'text'),
      createdAt: m.createdAt,
      userId: m.userId ? String(m.userId) : '',
    }));
  return { raw, hasMore: docs.length === limit };
};

// GET /api/showcase/:podId/messages — filtered, whitelisted message feed.
router.get('/:podId/messages', async (req: Req, res: Res) => {
  try {
    const pod = await loadPublicPod(req.params?.podId);
    if (!pod) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const rawLimit = parseInt(String(req.query?.limit ?? '50'), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
    const before = req.query?.before ? String(req.query.before) : undefined;

    const podId = pod._id.toString();
    const { raw, hasMore } = await readRawMessages(podId, limit, before);

    // Resolve authors via a single batched User lookup. Whitelisted projection
    // — NEVER email. botMetadata carries only display identity.
    const userIds = Array.from(new Set(raw.map((m) => m.userId).filter(Boolean)));
    const userDocs = userIds.length
      ? await User.find({ _id: { $in: userIds } })
          .select('username profilePicture isBot botMetadata')
          .lean()
      : [];
    const userMap = new Map<string, MemberDoc>();
    for (const u of userDocs as MemberDoc[]) {
      if (u._id) userMap.set(u._id.toString(), u);
    }

    const messages = raw
      .filter((m) => isShowcaseWorthy(m))
      .map((m) => {
        const u = userMap.get(m.userId);
        const isBot = !!u?.isBot;
        const author = {
          username: u?.username || 'unknown',
          displayName: isBot
            ? resolveAgentDisplayLabel(u, u?.username)
            : (u?.botMetadata?.displayName || u?.username || 'unknown'),
          profilePicture: u?.profilePicture || 'default',
          isBot,
        };
        return {
          id: m.id,
          author,
          content: m.content,
          createdAt: m.createdAt,
        };
      });

    res.json({ messages, hasMore });
  } catch (err) {
    console.error('[showcase] GET /:podId/messages error:', (err as Error).message);
    res.status(500).json({ error: 'Server Error' });
  }
});

module.exports = router;
module.exports.isShowcaseWorthy = isShowcaseWorthy;

export {};
