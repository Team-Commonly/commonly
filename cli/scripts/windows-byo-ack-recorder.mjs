/**
 * D164 prod walk: loaded into the CLI with NODE_OPTIONS=--import, so the walk
 * can see which events the CLI was handed and which it acked. The server has
 * no read of an event's state that does not also claim it, and a second
 * poller would take the @mention away from the agent under test.
 *
 * Observation only: it wraps the global fetch, records the event poll's ids
 * and each ack's status to COMMONLY_BYO_ACK_LOG as JSON lines, and passes
 * every response through untouched. It never records a header, a body other
 * than the event ids, or message content. Claude Code never loads it: a
 * public seat's environment is an allowlist that drops NODE_OPTIONS.
 */
import { appendFileSync } from 'fs';

const out = process.env.COMMONLY_BYO_ACK_LOG;
const realFetch = globalThis.fetch;

if (out && typeof realFetch === 'function') {
  const record = (row) => {
    try {
      appendFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
    } catch { /* the walk reports a missing ack; the CLI keeps running */ }
  };
  globalThis.fetch = async (input, init = {}) => {
    const res = await realFetch(input, init);
    try {
      const url = new URL(String(input?.url || input));
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const ack = /^\/api\/agents\/runtime\/events\/([^/]+)\/ack$/.exec(url.pathname);
      if (method === 'POST' && ack) {
        record({ kind: 'ack', eventId: decodeURIComponent(ack[1]), status: res.status });
      } else if (method === 'GET' && url.pathname === '/api/agents/runtime/events' && res.ok) {
        res.clone().json().then((body) => {
          (Array.isArray(body?.events) ? body.events : []).forEach((event) => record({
            kind: 'event',
            eventId: String(event?._id ?? ''),
            type: event?.type ?? null,
            podId: event?.podId ?? null,
            messageId: event?.payload?.messageId ?? null,
          }));
        }).catch(() => {});
      }
    } catch { /* never in the CLI's way */ }
    return res;
  };
}
