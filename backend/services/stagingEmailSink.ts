/**
 * The staging email sink. Staging limits sign-up to team domains, and register
 * refuses with 503 INSTANCE_VERIFICATION_UNAVAILABLE unless email delivery is
 * configured, because an allowlisted address is not proof of a mailbox
 * (authController). Staging has no real delivery, so no walk could reach a
 * verification link, and the email leg of the sign-up path went untested.
 *
 * This service stands in for SMTP2GO there. When `emailSink.enabled` is set,
 * the chart points SMTP2GO_BASE_URL at it, and it answers the one call
 * emailService makes (`POST /v3/email/send`). It keeps the mail so an operator
 * can read a recipient's messages back with `GET /inbox?to=<address>`.
 *
 * Nothing leaves the cluster. Mail lives in memory with the newest kept, so a
 * restart empties every inbox. Reading needs the bearer token from the chart's
 * `email-sink` Secret: the messages carry verification and password-reset
 * links, so other workloads in the namespace must not be able to read them.
 * Sending needs no token, the same as for the real provider's endpoint.
 *
 * Runs from the backend image: `node dist/services/stagingEmailSink.js`.
 */
import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const SEND_PATH = '/v3/email/send';
const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_CAPACITY = 500;
const LINK = /https?:\/\/[^\s"'<>)]+/g;

export interface SinkMessage {
  id: string;
  at: string;
  to: string[];
  from: string;
  subject: string;
  text: string;
  html: string;
  links: string[];
}

export interface SinkConfig {
  readToken: string;
  capacity?: number;
  now?: () => Date;
}

export const tokenMatches = (header: string | undefined, token: string): boolean => {
  const match = /^Bearer (.+)$/.exec(String(header || ''));
  if (!match || !token) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(token));
};

// SMTP2GO accepts `Name <a@b>` in `to`; emailService sends bare addresses.
export const recipient = (entry: unknown): string => {
  const value = String(entry || '').trim().toLowerCase();
  const named = /<([^>]+)>/.exec(value);
  return named ? named[1].trim() : value;
};

export const extractLinks = (...bodies: string[]): string[] => [
  ...new Set(bodies.flatMap((body) => String(body || '').match(LINK) || [])),
];

const readBody = (req: http.IncomingMessage): Promise<string | null> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      resolve(null);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

export const createSink = ({ readToken, capacity = DEFAULT_CAPACITY, now = () => new Date() }: SinkConfig) => {
  const messages: SinkMessage[] = [];

  const store = (payload: any): SinkMessage => {
    const text = String(payload.text_body || '');
    const html = String(payload.html_body || '');
    const message: SinkMessage = {
      id: randomUUID(),
      at: now().toISOString(),
      to: payload.to.map(recipient),
      from: String(payload.sender || ''),
      subject: String(payload.subject || ''),
      text,
      html,
      links: extractLinks(text, html),
    };
    messages.push(message);
    if (messages.length > capacity) messages.splice(0, messages.length - capacity);
    return message;
  };

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url || '/', 'http://email-sink');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      send(200, { ok: true, stored: messages.length });
      return;
    }

    if (req.method === 'POST' && url.pathname === SEND_PATH) {
      readBody(req).then((raw) => {
        if (raw === null) return send(413, { data: { error: 'payload_too_large' } });
        let payload: any;
        try {
          payload = JSON.parse(raw);
        } catch {
          return send(400, { data: { error: 'invalid_json' } });
        }
        const to = payload?.to;
        const isAddress = (entry: unknown) => typeof entry === 'string' && entry.includes('@');
        if (!Array.isArray(to) || to.length === 0 || !to.every(isAddress)) {
          return send(400, { data: { error: 'to_required' } });
        }
        const message = store(payload);
        console.log(`[email-sink] stored ${message.id} for ${message.to.length} recipient(s): ${message.subject}`);
        return send(200, {
          request_id: message.id,
          data: { succeeded: message.to.length, failed: 0, failures: [], email_id: message.id },
        });
      }).catch(() => send(400, { data: { error: 'unreadable_body' } }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/inbox') {
      if (!tokenMatches(req.headers.authorization, readToken)) {
        send(401, { error: 'unauthorized' });
        return;
      }
      const to = recipient(url.searchParams.get('to'));
      if (!to.includes('@')) {
        send(400, { error: 'to_required' });
        return;
      }
      const found = messages.filter((message) => message.to.includes(to)).reverse();
      send(200, { to, count: found.length, messages: found });
      return;
    }

    send(404, { error: 'not_found' });
  });

  return { server, messages };
};

if (require.main === module) {
  const readToken = String(process.env.EMAIL_SINK_READ_TOKEN || '');
  if (!readToken) {
    console.error('[email-sink] EMAIL_SINK_READ_TOKEN is required');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 8080);
  createSink({ readToken }).server.listen(port, () => {
    console.log(`[email-sink] listening on ${port}`);
  });
}
