/**
 * One-seat recovery for ADR-018's claim-then-decline path.
 *
 * A wake-on-message fan-out has already delivered one event per opted-in
 * installation. If the winner declines, those other deliveries have normally
 * stood down and acknowledged. Re-enqueueing the entire fan-out would make
 * every seat race again; doing nothing makes the human's message disappear.
 *
 * Instead, reuse one of the original, human-authored wake payloads and enqueue
 * it for the next distinct seat only. `message_claims.declined_by` makes the
 * chain finite: every seat that actually declines is excluded from every later
 * handoff, including across a CLI wrapper and the native runtime.
 */

// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const AgentEvent = require('../models/AgentEvent');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const AgentEventService = require('./agentEventService');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const MessageClaimService = require('./messageClaimService');

type HandoffResult = {
  queued: boolean;
  agentName?: string;
  instanceId?: string;
  reason?: 'no_remaining_wake_target' | 'enqueue_failed';
};

const identityKey = (agentName: unknown, instanceId: unknown): string => (
  // agentName is canonicalized by both Mongo schemas and the claim service;
  // instanceId is not. Lowercasing it here would make `seat:Blue` from the
  // PostgreSQL decline history fail to exclude the `Blue` Mongo installation,
  // reopening a decline loop for a mixed-case instance id.
  `${String(agentName || '').toLowerCase()}:${String(instanceId || 'default')}`
);

/**
 * Re-offer one human wake to the next original target that has not declined.
 * Old events without `senderIsHuman` deliberately do not qualify: treating an
 * unknown sender as human would turn a compatibility gap into an agent loop.
 */
async function enqueueNextDeclineHandoff({
  messageId,
  podId,
  declinedBy,
}: {
  messageId: string;
  podId: string;
  declinedBy: string[];
}): Promise<HandoffResult> {
  const sourceEvents = await AgentEvent.find({
    podId,
    type: 'message.posted',
    'payload.messageId': String(messageId),
    'payload.wakeOnMessage': true,
    'payload.senderIsHuman': true,
    'payload.claimHandoff': { $exists: false },
  }).sort({ createdAt: 1, _id: 1 }).lean();

  const declined = new Set((declinedBy || []).map(String));
  const seen = new Set<string>();
  for (const sourceEvent of sourceEvents) {
    const agentName = String(sourceEvent.agentName || '').toLowerCase();
    const instanceId = String(sourceEvent.instanceId || 'default');
    const key = identityKey(agentName, instanceId);
    if (!agentName || declined.has(key) || seen.has(key)) continue;
    seen.add(key);

    // An original wake is evidence that this seat once opted in. Recheck the
    // live installation before re-offering: a user who turned wake-off (or
    // uninstalled the seat) while the first agent was thinking must not be
    // resurrected by an old event payload.
    const installation = await AgentInstallation.findOne({
      agentName,
      instanceId,
      podId,
      status: 'active',
      'config.wakeOnMessage.enabled': true,
    }).lean();
    if (!installation) continue;

    const payload = (sourceEvent.payload && typeof sourceEvent.payload === 'object')
      ? sourceEvent.payload
      : {};
    try {
      await AgentEventService.enqueue({
        agentName,
        instanceId,
        podId,
        type: 'message.posted',
        payload: {
          ...payload,
          claimHandoff: { attempt: declined.size },
        },
      });
      return { queued: true, agentName, instanceId };
    } catch (err) {
      console.warn('[message-claim] handoff enqueue failed', {
        agent: key,
        messageId,
        error: (err as Error).message,
      });
      return { queued: false, reason: 'enqueue_failed' };
    }
  }

  return { queued: false, reason: 'no_remaining_wake_target' };
}

/**
 * Release a claim and, only for an explicit human-message decline, advance it
 * to one remaining original wake target. `completed` is deliberately terminal
 * and the omitted outcome retains legacy DELETE semantics for older drivers
 * and failure paths that must still be eligible for normal event redelivery.
 */
async function release(options: {
  messageId: string;
  agentName: string;
  instanceId?: string;
  outcome?: 'declined' | 'completed';
}): Promise<Record<string, unknown>> {
  const result = await MessageClaimService.release(options);
  if (!result?.released || options.outcome !== 'declined' || !result.podId) return result;

  try {
    const handoff = await enqueueNextDeclineHandoff({
      messageId: String(options.messageId),
      podId: String(result.podId),
      declinedBy: Array.isArray(result.declinedBy) ? result.declinedBy : [],
    });
    return { ...result, handoff };
  } catch (err) {
    // A release must remain successful even if Mongo is unavailable: holding a
    // 90-second typing indicator is worse than missing a best-effort handoff.
    // The structured result makes the loss observable to the caller and logs.
    console.warn('[message-claim] handoff lookup failed:', (err as Error).message);
    return { ...result, handoff: { queued: false, reason: 'enqueue_failed' } };
  }
}

module.exports = {
  release,
  enqueueNextDeclineHandoff,
};
export {};
