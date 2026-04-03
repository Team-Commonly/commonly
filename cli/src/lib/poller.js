/**
 * Event poller — polls GET /api/agents/runtime/events and forwards
 * each event to a local handler (webhook server or callback).
 *
 * Used by `commonly agent connect` when running against any instance,
 * since localhost webhooks can't receive inbound calls from remote GKE.
 */

import { createClient } from './api.js';

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
  let consecutive_errors = 0;

  const poll = async () => {
    if (!running) return;

    try {
      const { events = [] } = await client.get('/api/agents/runtime/events', {
        agentName,
        instanceId,
        limit: 10,
      });

      for (const event of events) {
        let result = { outcome: 'no_action' };
        try {
          result = (await onEvent(event)) || { outcome: 'no_action' };
        } catch (handlerErr) {
          result = { outcome: 'error', reason: handlerErr.message };
        }

        // Acknowledge the event
        try {
          await client.post('/api/agents/runtime/events/acknowledge', {
            eventId: event._id,
            result,
          });
        } catch (ackErr) {
          // Non-fatal — event will be retried
          onError?.(new Error(`Ack failed for ${event._id}: ${ackErr.message}`));
        }
      }

      consecutive_errors = 0;
    } catch (err) {
      consecutive_errors++;
      onError?.(err);
      // Back off on repeated errors (max 60s)
      const backoff = Math.min(intervalMs * consecutive_errors, 60_000);
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
