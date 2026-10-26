/**
 * Local webhook server — receives forwarded events from the poller
 * and delivers them to the developer's agent process.
 *
 * The developer's agent code handles POST /cap (or custom path)
 * and returns { outcome, content? }.
 */

import { createServer } from 'http';
import { createHmac } from 'crypto';
import { EMPTY_OUTPUT } from './claim-outcome.js';

export const startWebhookServer = ({
  port = 3001,
  path = '/cap',
  secret = null,
  onEvent,   // async (event) => { outcome, content? }
  onReady,   // (url) => void
}) => new Promise((resolve, reject) => {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== path) {
      res.writeHead(404);
      res.end();
      return;
    }

    // Read body
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');

      // Verify signature if secret configured
      if (secret) {
        const sig = req.headers['x-commonly-signature'];
        const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
        if (sig !== expected) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Invalid signature' }));
          return;
        }
      }

      let event;
      try { event = JSON.parse(rawBody); } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      // A handler that returns nothing said nothing (#2753).
      let result = { outcome: 'no_action', reason: EMPTY_OUTPUT };
      try {
        result = (await onEvent(event)) || { outcome: 'no_action', reason: EMPTY_OUTPUT };
      } catch (err) {
        result = { outcome: 'error', reason: err.message };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });

  server.on('error', reject);
  server.listen(port, () => {
    const url = `http://localhost:${port}${path}`;
    onReady?.(url);
    resolve({ server, url, close: () => server.close() });
  });
});

/**
 * The handler `agent connect` serves on its own port. It only logs what
 * arrives, and no agent has read the event, so it states no outcome a read
 * would count as: the wake still settles, and the pod digest stays unread
 * (Sable, #2753).
 */
export const logOnlyHandler = async (event) => {
  console.log(`[local] ${event.type} from pod ${event.podId}`);
  return { outcome: 'no_action', reason: EMPTY_OUTPUT };
};

/**
 * Forward a polled event to a local webhook server.
 * Used by `agent connect` to bridge polling → local HTTP.
 */
export const forwardToLocalWebhook = async (event, webhookUrl, secret = null) => {
  const payload = JSON.stringify(event);
  const headers = {
    'Content-Type': 'application/json',
    'X-Commonly-Event': event.type,
    'X-Commonly-Delivery': String(event._id),
  };
  if (secret) {
    headers['X-Commonly-Signature'] = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  }

  const res = await fetch(webhookUrl, { method: 'POST', headers, body: payload });
  if (!res.ok) throw new Error(`Local webhook returned HTTP ${res.status}`);
  // Only a stated outcome counts. An empty or non-JSON body, or one without
  // an outcome, is a handler that said nothing, the same as a CLI turn that
  // printed nothing, so it must not read the pod digest (Rhea, #2753).
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!body || typeof body !== 'object' || typeof body.outcome !== 'string') {
    return { outcome: 'no_action', reason: EMPTY_OUTPUT };
  }
  return body;
};
