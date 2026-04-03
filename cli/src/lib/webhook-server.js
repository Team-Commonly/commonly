/**
 * Local webhook server — receives forwarded events from the poller
 * and delivers them to the developer's agent process.
 *
 * The developer's agent code handles POST /cap (or custom path)
 * and returns { outcome, content? }.
 */

import { createServer } from 'http';
import { createHmac } from 'crypto';

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

      let result = { outcome: 'acknowledged' };
      try {
        result = (await onEvent(event)) || { outcome: 'acknowledged' };
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
  try { return await res.json(); } catch { return { outcome: 'acknowledged' }; }
};
