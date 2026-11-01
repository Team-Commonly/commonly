/**
 * A loopback relay between a CLI and its model provider, so the adapter sees
 * what the CLI hides: the provider's own answer.
 *
 * Measured 2026-10-25 against the fake provider: goose 1.54.0 answers a 400
 * content refusal by retrying it eight times over ~8 s, and opencode 1.19.0
 * retries a 503 with backoff until the run's timeout. Neither says anything
 * on its ACP stream or stderr while it does. The provider wire is the only
 * place the condition is visible, so that is where it is read.
 *
 * Rule: the FIRST failing answer to a POST ends the run. A 4xx is
 * `refusal_retry_loop`; a 5xx, a 408 or a 429 is `provider_unavailable`,
 * because those say "not now" rather than "not this". No threshold: a
 * refusal does not become an answer on the eighth try, and a run that waits
 * out a CLI's backoff is the silent hang this exists to remove. GETs (model
 * listings) are relayed but never judged.
 *
 * Once tripped, the relay answers everything locally with 503 and forwards
 * nothing, so the provider sees no further calls while the CLI is stopped.
 * Headers and bodies pass through untouched; the relay holds no key.
 */
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { RunFailure, runFailure } from './failures.js';
import { scrubAdapterFailure } from './upstream-refusal.js';

const BODY_SAMPLE_CHARS = 4096;
// A JSON body is read whole, because a slice of one is no longer JSON and the
// keep-list would then treat it as prose and keep fields outside the list.
// Past this size no detail is kept at all.
const JSON_BODY_MAX_CHARS = 256 * 1024;

/** The failure a provider status names, or null when the answer is fine. */
export const failureForStatus = (status, body, { credentials = [] } = {}) => {
  const transient = status === 408 || status === 429 || (status >= 500 && status <= 599);
  const kind = transient ? 'provider_unavailable' : status >= 400 && status <= 499 ? 'refusal_retry_loop' : null;
  if (!kind) return null;
  // The status must LEAD the text the shared keep-list reads, so it parses
  // `NNN: {body}` and keeps at most the body's one named message field. The
  // readable prefix is added after the scrub; put first, it hides the status
  // and the whole body sample is kept instead.
  const raw = String(body ?? '');
  const json = /^\s*[[{]/.test(raw);
  if (json && raw.length > JSON_BODY_MAX_CHARS) return new RunFailure(kind, `provider answered ${status}`);
  const text = `${status}: ${json ? raw : raw.slice(0, BODY_SAMPLE_CHARS)}`;
  const { detail } = scrubAdapterFailure(text, { credentials, limit: 500 });
  return new RunFailure(kind, `provider answered ${status}${detail ? `: ${detail}` : ''}`);
};

/**
 * @param {object} opts
 * @param {string} opts.baseURL  the real provider base URL, e.g. https://host/v1
 * @param {(failure: import('./failures.js').RunFailure) => void} opts.onFailure  called once
 * @param {string[]} [opts.credentials]  scrubbed from the failure detail
 * @returns {Promise<{ baseURL: string, close: () => Promise<void>, tripped: boolean }>}
 */
export const startProviderWatch = async ({ baseURL, onFailure, credentials = [] }) => {
  const upstream = new URL(baseURL);
  const basePath = upstream.pathname.replace(/\/$/, '');
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const sockets = new Set();
  const forwards = new Set();
  let tripped = null;

  const trip = (failure) => {
    if (tripped) return;
    tripped = failure;
    onFailure(failure);
  };

  const server = createServer((req, res) => {
    if (tripped) {
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stopped by the seat after a provider failure' } }));
      return;
    }
    const judged = req.method === 'POST';
    const headers = { ...req.headers, host: upstream.host };
    const forward = send({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: req.method,
      // The relay's base URL keeps the provider's path, so the CLI's request
      // path is already the upstream path.
      path: req.url,
      headers,
    }, (answer) => {
      answer.on('aborted', () => res.destroy());
      const status = answer.statusCode || 0;
      if (!judged || status < 400) {
        res.writeHead(status, answer.headers);
        answer.pipe(res);
        return;
      }
      // Read the error body for the failure detail, then pass it on whole so
      // the CLI's own handling still sees a well-formed answer.
      const chunks = [];
      answer.on('data', (chunk) => { chunks.push(chunk); });
      answer.on('end', () => {
        const body = Buffer.concat(chunks);
        const failure = failureForStatus(status, body.toString('utf8'), { credentials });
        if (failure) trip(failure);
        res.writeHead(status, answer.headers);
        res.end(body);
      });
      answer.on('error', () => res.destroy());
    });
    forwards.add(forward);
    forward.on('close', () => forwards.delete(forward));
    // A CLI that hangs up (or is killed) takes its upstream request with it,
    // so the relay never holds a provider connection nobody is waiting on.
    res.on('close', () => { if (!res.writableFinished) forward.destroy(); });
    forward.on('error', (error) => {
      if (res.destroyed) return;
      // An unreachable provider is a provider that is unavailable.
      if (judged) trip(runFailure('provider_unavailable', `provider unreachable: ${error?.code || error?.message}`, { credentials }));
      res.destroy();
    });
    req.pipe(forward);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    baseURL: `http://127.0.0.1:${port}${basePath}`,
    get tripped() { return tripped; },
    close: () => new Promise((resolve) => {
      for (const forward of forwards) forward.destroy();
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
};
