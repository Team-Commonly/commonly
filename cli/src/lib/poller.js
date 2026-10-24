/**
 * Event poller — polls GET /api/agents/runtime/events and forwards
 * each event to a local handler (webhook server or callback).
 *
 * Used by `commonly agent connect` when running against any instance,
 * since localhost webhooks can't receive inbound calls from remote GKE.
 */

import { createClient } from './api.js';

// Delivery failures that must stop a consumer rather than fall through to the
// normal at-least-once retry path. A stale delivery belongs to a replacement
// runner; a missing required nonce means this runner is misconfigured. Neither
// can become healthy by immediately fetching and retrying more work.
export const terminalDeliveryAckError = (ackErr, eventId, runner = 'poller') => {
  if (ackErr?.status === 409 && ackErr?.body?.code === 'stale_delivery') {
    return Object.assign(
      new Error(`Delivery ${eventId} was superseded — stopping ${runner}.`),
      { code: 'stale_delivery' },
    );
  }
  if (ackErr?.status === 400 && ackErr?.body?.code === 'delivery_id_required') {
    return Object.assign(
      new Error(`Delivery ${eventId} requires deliveryId — stopping ${runner}; update its configuration.`),
      { code: 'delivery_id_required' },
    );
  }
  return null;
};

const digestFrame = (events) => {
  const counts = new Map();
  const seen = new Set();
  for (const event of events) {
    const payload = event.payload || {};
    const sourceId = payload.messageId != null ? `message:${payload.messageId}`
      : (typeof payload.taskId === 'string'
        ? `task:${payload.taskId}:${String(payload.taskKind || '')}:${String(payload.content || '')}` : null);
    if (sourceId && seen.has(sourceId)) continue;
    if (sourceId) seen.add(sourceId);
    const thread = payload.threadRootId;
    const task = payload.taskId;
    const label = Number.isInteger(thread) && thread > 0 ? `thread ${thread}`
      : (typeof task === 'string' && /^TASK-\d+$/.test(task) ? task : 'pod conversation');
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const lines = [...counts].slice(0, 8).map(([label, count]) => `- ${label}: ${count} unread`);
  if (counts.size > 8) lines.push(`- ${counts.size - 8} more conversations omitted`);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return `[Since you last looked: ${total} ambient update${total === 1 ? '' : 's'} in ${counts.size} conversation${counts.size === 1 ? '' : 's'}; context only, no reply needed.]\n`
    + `${lines.join('\n')}\nPull relevant messages with commonly_get_messages. On resume, read oldest unread first; at most 8 conversations, 5 messages each, 20 messages total.`;
};

export const startPoller = ({
  instanceUrl,
  token,
  agentName,
  instanceId = 'default',
  intervalMs = 5000,
  onEvent,          // async (event) => { outcome, content? }
  onError,          // (err) => void
}) => {
  const client = createClient({ instance: instanceUrl, token });
  let running = true;
  let consecutiveErrors = 0;
  // Stop-after-N-auth-failures: without this, a revoked token leaves the
  // poller hammering 401s forever at 60s backoff, invisible to the user.
  // 3 is deliberate — 1 would churn on a token-rotation race during
  // reprovision-all; 5+ wastes rate-limit budget after the real-revoke case.
  let consecutiveAuthErrors = 0;
  const MAX_AUTH_ERRORS = 3;

  const poll = async () => {
    if (!running) return;

    try {
      const { events = [] } = await client.get('/api/agents/runtime/events', {
        agentName,
        instanceId,
        limit: 10,
      });

      // A digest is received context, not a webhook invocation. The runtime
      // inbox claims it only alongside a wake from the same pod.
      const wakeEvents = events.filter((event) => event.deliveryMode !== 'digest');
      const digestEvents = events.filter((event) => event.deliveryMode === 'digest'
        && wakeEvents[0] && String(event.podId) === String(wakeEvents[0].podId));
      const frame = digestEvents.length > 0 ? digestFrame(digestEvents) : null;
      let digestConsumed = false;
      for (const [index, event] of wakeEvents.entries()) {
        const attachedDigest = index === 0 && digestEvents.length > 0;
        const forwarded = attachedDigest ? {
          ...event,
          payload: {
            ...(event.payload || {}),
            digestSummary: frame,
            ...(typeof event.payload?.content === 'string' ? {
              content: `${event.payload.content}\n\n${frame}`,
            } : {}),
          },
        } : event;
        let result = { outcome: 'no_action' };
        try {
          result = (await onEvent(forwarded)) || { outcome: 'no_action' };
        } catch (handlerErr) {
          result = { outcome: 'error', reason: handlerErr.message };
        }

        // Acknowledge the event
        try {
          const deliveryId = event.payload?.deliveryId;
          await client.post(`/api/agents/runtime/events/${event._id}/ack`, {
            result,
            ...(typeof deliveryId === 'string' && deliveryId ? { deliveryId } : {}),
          });
          if (attachedDigest && (result.outcome === 'posted'
            || result.outcome === 'acknowledged'
            || (result.outcome === 'no_action' && !result.reason))) {
            digestConsumed = true;
          }
        } catch (ackErr) {
          const terminalError = terminalDeliveryAckError(ackErr, event._id);
          if (terminalError) {
            running = false;
            onError?.(terminalError);
            return;
          }
          // Non-fatal — event will be retried
          onError?.(new Error(`Ack failed for ${event._id}: ${ackErr.message}`));
        }
      }

      if (digestConsumed) {
        for (const event of digestEvents) {
          try {
            const deliveryId = event.payload?.deliveryId;
            await client.post(`/api/agents/runtime/events/${event._id}/ack`, {
              result: { outcome: 'no_action', reason: 'digest-read' },
              ...(typeof deliveryId === 'string' && deliveryId ? { deliveryId } : {}),
            });
          } catch (ackErr) {
            const terminalError = terminalDeliveryAckError(ackErr, event._id);
            if (terminalError) {
              running = false;
              onError?.(terminalError);
              return;
            }
            onError?.(new Error(`Ack failed for ${event._id}: ${ackErr.message}`));
          }
        }
      }

      consecutiveErrors = 0;
      consecutiveAuthErrors = 0;
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        consecutiveAuthErrors += 1;
        if (consecutiveAuthErrors >= MAX_AUTH_ERRORS) {
          onError?.(new Error(
            `Runtime token rejected ${consecutiveAuthErrors} times in a row — stopping poller. `
            + `The token is likely revoked.`,
          ));
          running = false;
          return;
        }
      }
      consecutiveErrors++;
      onError?.(err);
      // Back off on repeated errors (max 60s)
      const backoff = Math.min(intervalMs * consecutiveErrors, 60_000);
      await new Promise((r) => setTimeout(r, backoff));
    }

    if (running) setTimeout(poll, intervalMs);
  };

  // Start immediately
  poll();

  return {
    stop: () => { running = false; },
  };
};
