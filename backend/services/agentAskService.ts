// ADR-003 Phase 4: cross-agent ask/respond primitive.
//
// Surface (called from routes; not directly by drivers):
//   askAgent({ fromAgent, fromInstanceId, podId, targetAgent, targetInstanceId?, question, requestId?, timeoutMs? })
//   respondToAsk({ fromAgent, fromInstanceId, requestId, content })
//
// Failure modes (all thrown as AgentAskError so the route can map to HTTP):
//   - target agent not installed in pod                           → 404
//   - self-ask (fromAgent === targetAgent within same instanceId) → 400
//   - rate limit exceeded                                         → 429
//   - respond() called with unknown / expired requestId           → 404 / 410
//   - respond() called by an agent other than the original target → 403
//
// Self-ask guard: replicates the `agentMentionService.enqueueMentions`
// pattern. Both agentName and instanceId are normalized — agentName via
// .toLowerCase(), instanceId by defaulting null/undefined to 'default'. An
// agent cannot ask itself (would create the same chat.mention → reply loop
// the mention service guards against).

import crypto from 'crypto';

// eslint-disable-next-line global-require
const AgentEventService = require('./agentEventService');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const AgentAsk = require('../models/AgentAsk');

// Per-(fromAgent, podId) cap to prevent runaway loops between agents. Keyed
// only by agent NAME (not name+instance) so an attacker can't trivially
// bypass the cap by varying instanceId on the from side. The pod is part of
// the key so a chatty agent in one pod doesn't block its work in another.
const ASK_RATE_LIMIT_PER_HOUR = Math.max(
  1,
  Number.parseInt(process.env.AGENT_ASK_RATE_LIMIT_PER_HOUR || '', 10) || 30,
);
const ASK_RATE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

export class AgentAskError extends Error {
  status: number;

  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface AskAgentOptions {
  fromAgent: string;
  fromInstanceId?: string;
  podId: string;
  targetAgent: string;
  targetInstanceId?: string;
  question: string;
  requestId?: string;
  timeoutMs?: number;
}

interface AskAgentResult {
  requestId: string;
  expiresAt: Date;
}

interface RespondToAskOptions {
  fromAgent: string;        // the responder — the original ASK TARGET
  fromInstanceId?: string;
  requestId: string;
  content: string;
}

const normalizeAgent = (s: string): string => String(s || '').trim().toLowerCase();
const normalizeInstance = (s: string | undefined | null): string => {
  const v = String(s ?? '').trim();
  return v || 'default';
};

const sameIdentity = (
  a: { agentName: string; instanceId: string },
  b: { agentName: string; instanceId: string },
): boolean => (
  a.agentName === b.agentName && a.instanceId === b.instanceId
);

export async function askAgent(opts: AskAgentOptions): Promise<AskAgentResult> {
  const fromAgent = normalizeAgent(opts.fromAgent);
  const fromInstanceId = normalizeInstance(opts.fromInstanceId);
  const targetAgent = normalizeAgent(opts.targetAgent);
  const targetInstanceId = normalizeInstance(opts.targetInstanceId);
  const podId = String(opts.podId || '').trim();
  const question = String(opts.question || '').trim();

  if (!fromAgent) throw new AgentAskError('fromAgent is required', 400, 'fromAgent_required');
  if (!targetAgent) throw new AgentAskError('targetAgent is required', 400, 'targetAgent_required');
  if (!podId) throw new AgentAskError('podId is required', 400, 'podId_required');
  if (!question) throw new AgentAskError('question is required', 400, 'question_required');

  // Self-ask guard. Mirrors agentMentionService self-mention pattern: any
  // agent whose reply echoes its own handle would otherwise trigger an
  // infinite ask → respond → ask loop. Refuse at the source.
  if (sameIdentity(
    { agentName: fromAgent, instanceId: fromInstanceId },
    { agentName: targetAgent, instanceId: targetInstanceId },
  )) {
    throw new AgentAskError(
      'cannot ask yourself — sender and target resolve to the same agent identity',
      400,
      'self_ask',
    );
  }

  // Same-pod requirement: target must have an active AgentInstallation in
  // this pod. Without this, agents could send asks across pods they aren't
  // members of together — that breaks the social model where pod
  // membership is the authorization unit (see ADR-001).
  const targetInstallation = await AgentInstallation.findOne({
    agentName: targetAgent,
    instanceId: targetInstanceId,
    podId,
    status: 'active',
  }).lean();
  if (!targetInstallation) {
    throw new AgentAskError(
      `target agent ${targetAgent}:${targetInstanceId} is not installed in this pod`,
      404,
      'target_not_in_pod',
    );
  }

  // Rate limit. Keyed by (fromAgent, podId) — NOT (fromAgent, instanceId,
  // podId). The instanceId is excluded from the key so a misbehaving agent
  // can't churn through instanceIds to bypass.
  const since = new Date(Date.now() - ASK_RATE_WINDOW_MS);
  const recentCount = await AgentAsk.countDocuments({
    fromAgent,
    podId,
    createdAt: { $gte: since },
  });
  if (recentCount >= ASK_RATE_LIMIT_PER_HOUR) {
    throw new AgentAskError(
      `rate limit exceeded: ${ASK_RATE_LIMIT_PER_HOUR} asks per hour from ${fromAgent} in this pod`,
      429,
      'rate_limited',
    );
  }

  const requestId = String(opts.requestId || '').trim() || crypto.randomUUID();
  // Bound the requestId before the DB write. Mongo's unique index would
  // happily store a 10MB string supplied by a compromised agent token;
  // 128 chars is plenty for UUIDs, ULIDs, or short human-readable ids.
  // Also reject control characters — they break log scanning + URL paths.
  if (requestId.length > 128) {
    throw new AgentAskError(
      `requestId must be ≤128 chars (got ${requestId.length})`,
      400,
      'invalid_request_id',
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(requestId)) {
    throw new AgentAskError(
      'requestId must not contain control characters',
      400,
      'invalid_request_id',
    );
  }
  const expiresAt = new Date(Date.now() + Math.max(60_000, opts.timeoutMs || DEFAULT_EXPIRY_MS));

  // Create the ask record first. If the create succeeds but the event
  // enqueue fails, the ask is still recorded — TTL will GC it. Better to
  // have a record without delivery than the reverse.
  let ask;
  try {
    ask = await AgentAsk.create({
      requestId,
      podId,
      fromAgent,
      fromInstanceId,
      targetAgent,
      targetInstanceId,
      question,
      status: 'open',
      expiresAt,
    });
  } catch (err: any) {
    // Duplicate requestId → caller supplied a clashing one. Map to 409.
    if (err?.code === 11000) {
      throw new AgentAskError(
        'requestId already exists; use a fresh one',
        409,
        'duplicate_request',
      );
    }
    throw err;
  }

  await AgentEventService.enqueue({
    agentName: targetAgent,
    instanceId: targetInstanceId,
    podId,
    type: 'agent.ask',
    payload: {
      requestId,
      fromAgent,
      fromInstanceId,
      question,
      podId: String(podId),
      expiresAt: expiresAt.toISOString(),
    },
  });

  return { requestId: ask.requestId, expiresAt: ask.expiresAt };
}

export async function respondToAsk(opts: RespondToAskOptions): Promise<void> {
  const responderAgent = normalizeAgent(opts.fromAgent);
  const responderInstance = normalizeInstance(opts.fromInstanceId);
  const requestId = String(opts.requestId || '').trim();
  const content = String(opts.content || '').trim();

  if (!requestId) throw new AgentAskError('requestId is required', 400, 'requestId_required');
  if (!content) throw new AgentAskError('content is required', 400, 'content_required');

  const ask = await AgentAsk.findOne({ requestId });
  if (!ask) {
    throw new AgentAskError('no ask found for that requestId', 404, 'ask_not_found');
  }

  if (ask.status === 'expired' || ask.expiresAt < new Date()) {
    // Defensive: status may still be 'open' if the TTL hasn't fired yet.
    if (ask.status !== 'expired') {
      ask.status = 'expired';
      try { await ask.save(); } catch { /* best-effort */ }
    }
    throw new AgentAskError('ask has expired', 410, 'ask_expired');
  }
  if (ask.status === 'responded') {
    throw new AgentAskError('ask has already been responded to', 409, 'already_responded');
  }

  // Authorization: only the original target can respond. Reject if the
  // responder identity doesn't match the targetAgent + targetInstanceId
  // recorded on the ask. This is a defense-in-depth check on top of
  // agentRuntimeAuth — the route handler should already have the
  // authenticated agent's identity, but we check again here so callers of
  // respondToAsk() from anywhere in the codebase get the same guarantee.
  if (responderAgent !== ask.targetAgent || responderInstance !== ask.targetInstanceId) {
    throw new AgentAskError(
      'only the original target agent may respond to this ask',
      403,
      'not_target',
    );
  }

  ask.status = 'responded';
  ask.response = content;
  ask.respondedAt = new Date();
  await ask.save();

  // Fan response back to the original sender. If this enqueue fails, the
  // ask record itself still reflects the response — the sender can poll
  // GET /asks/:id (future) to recover. Matches the
  // create-record-then-enqueue ordering in askAgent().
  await AgentEventService.enqueue({
    agentName: ask.fromAgent,
    instanceId: ask.fromInstanceId,
    podId: ask.podId,
    type: 'agent.ask.response',
    payload: {
      requestId: ask.requestId,
      fromAgent: ask.targetAgent,
      fromInstanceId: ask.targetInstanceId,
      question: ask.question,
      response: content,
      podId: String(ask.podId),
    },
  });
}

export const __testing__ = {
  ASK_RATE_LIMIT_PER_HOUR,
  ASK_RATE_WINDOW_MS,
  DEFAULT_EXPIRY_MS,
};

const exported = { askAgent, respondToAsk, AgentAskError, __testing__ };
export default exported;
// CJS compat: let require() return the exported helpers directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exported;
module.exports.askAgent = askAgent;
module.exports.respondToAsk = respondToAsk;
module.exports.AgentAskError = AgentAskError;
module.exports.__testing__ = __testing__;
module.exports.default = exported;
