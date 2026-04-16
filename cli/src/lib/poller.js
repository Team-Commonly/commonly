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

      for (const event of events) {
        let result = { outcome: 'no_action' };
        try {
          result = (await onEvent(event)) || { outcome: 'no_action' };
        } catch (handlerErr) {
          result = { outcome: 'error', reason: handlerErr.message };
        }

        // Acknowledge the event
        try {
          await client.post(`/api/agents/runtime/events/${event._id}/ack`, {
            result,
          });
        } catch (ackErr) {
          // Non-fatal — event will be retried
          onError?.(new Error(`Ack failed for ${event._id}: ${ackErr.message}`));
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
