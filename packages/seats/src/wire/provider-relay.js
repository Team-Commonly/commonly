/**
 * The per-run loopback provider relay: what lets refusal_dropped fire on a live
 * run. The supervisor starts one for a run, an adapter points its CLI at it,
 * and the relay forwards each request to the provider the CLI was configured to
 * use while it reads every response body through createRefusalTap().
 *
 *   CLI --http--> 127.0.0.1:<ephemeral>/<run token>/<path> --TLS--> upstream/<path>
 *
 * What it does and does not do with the traffic:
 *   - Request headers pass through as the CLI sent them, auth included
 *     (Authorization, x-api-key, anthropic-*, chatgpt-account-id, an OAuth
 *     bearer). Only hop-by-hop headers and Host are replaced, and
 *     Accept-Encoding is set to identity so the tap reads plain bytes.
 *   - Request bodies are piped upstream and never read.
 *   - Response bodies are piped back unchanged; a copy of each 2xx body goes to
 *     an in-memory tap. What the relay keeps is a verdict per refusal (format
 *     and signal), plus the refusal text in memory so the settle rule can tell
 *     a surfaced refusal from a dropped one. The text is never handed to a
 *     trace.
 *   - It writes nothing: no log line, no file. A failed upstream call answers
 *     502 with a fixed body.
 *   - The upstream is reached over TLS when the configured URL is https, with
 *     the platform's CA store unless `ca` is passed explicitly. It never turns
 *     verification off and never downgrades https to http.
 *   - A WebSocket upgrade is answered 426. codex's Responses-over-WebSocket
 *     transport treats 426 as "use HTTP" for the rest of its session, so the
 *     turn arrives as SSE the tap can read.
 *   - Requests must carry the per-run token as their first path segment and
 *     stay under the upstream's base path; anything else is a 404 and is not
 *     forwarded, so the port is not a general forwarder for other processes.
 *
 * Trip mode (bind with `onTrip`), for a CLI that hides a failing provider
 * behind its own retries. Measured 2026-10-25 against the fake provider:
 * goose 1.54.0 answers a 400 content refusal by retrying it eight times over
 * ~8 s, and opencode 1.19.0 retries a 503 with backoff until the run's
 * timeout, saying nothing on ACP or stderr while it does. So the FIRST failing
 * answer to a POST ends the attempt: a 4xx is `refusal_retry_loop`; a 5xx, 408
 * or 429, or an unreachable provider, is `provider_unavailable`, because those
 * say "not now" rather than "not this". There is no threshold: a refusal does
 * not become an answer on the eighth try. GETs (model listings) are relayed
 * and never judged. Once tripped, the relay answers every request with a local
 * 503 and forwards nothing, so the provider sees no further calls. The failing
 * answer itself still reaches the CLI whole. The failure's detail is the status
 * and the error's type/code identifiers only; the provider's message text is
 * kept, credential-scrubbed, on `failure.providerMessage` in memory, never in
 * the detail a trace records.
 *
 * Coverage is reported, never assumed: a run is `covered` only when the adapter
 * bound an upstream, at least one model request reached the relay, and every
 * response the relay forwarded could be read. Everything else is
 * `not_covered`, with the reason.
 */
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import zlib from 'node:zlib';
import { COVERAGE } from '../coverage.js';
import { runFailure } from '../failures.js';
import { scrubAdapterFailure } from '../upstream-refusal.js';
import { createRefusalTap } from './refusal.js';
import { isPlainRequestTarget, withoutHeaders } from './http-relay.js';

const DECODERS = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
  ...(zlib.createZstdDecompress ? { zstd: () => zlib.createZstdDecompress() } : {}),
};

const BODY_SAMPLE_CHARS = 4096;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

// The error's type and code, when the body names them as identifiers. Never
// its message: that is provider text, and a trace keeps verdicts only.
const errorIdentifiers = (text) => {
  let body;
  try { body = JSON.parse(text); } catch { return []; }
  const error = body && typeof body.error === 'object' && body.error !== null ? body.error : body;
  return [['type', error?.type], ['code', error?.code]]
    .filter(([, value]) => (typeof value === 'string' || typeof value === 'number') && IDENTIFIER.test(String(value)))
    .map(([name, value]) => `${name} ${value}`);
};

const errorMessageOf = (text) => {
  try {
    const body = JSON.parse(text);
    const message = body?.error?.message ?? body?.message;
    if (typeof message === 'string') return message;
  } catch { /* not JSON: the text is the message */ }
  return text;
};

/**
 * The failure a provider status names, or null when the answer is fine.
 * `detail` is `provider answered <status>` plus the error's type/code; the
 * scrubbed message text rides on `providerMessage`, in memory only.
 */
export const failureForStatus = (status, body, { credentials = [] } = {}) => {
  const transient = status === 408 || status === 429 || (status >= 500 && status <= 599);
  const kind = transient ? 'provider_unavailable' : status >= 400 && status <= 499 ? 'refusal_retry_loop' : null;
  if (!kind) return null;
  const sample = String(body ?? '').slice(0, BODY_SAMPLE_CHARS);
  const ids = errorIdentifiers(sample);
  const failure = runFailure(kind, `provider answered ${status}${ids.length ? ` (${ids.join(', ')})` : ''}`, { credentials });
  failure.status = status;
  failure.providerMessage = scrubAdapterFailure(errorMessageOf(sample), { credentials, limit: 500 }).detail;
  return failure;
};

const parseUpstream = (value) => {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('provider relay upstream must be an absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('provider relay upstream must be http(s)');
  if (url.username || url.password) throw new Error('provider relay upstream must not embed credentials');
  if (url.search || url.hash) throw new Error('provider relay upstream must not carry a query or fragment');
  return url;
};

/**
 * Start a relay on 127.0.0.1 with an OS-assigned port.
 *
 * @param {object} [options]
 * @param {string|Buffer|Array} [options.ca]  CA certificate(s) for an https upstream, replacing the platform store
 * @returns {Promise<object>} the relay; `handle` is the narrow part an adapter receives as ctx.providerRelay
 */
export const startProviderRelay = async ({ ca, credentials: relayCredentials = [] } = {}) => {
  const token = randomBytes(18).toString('base64url');
  const prefix = `/${token}`;
  const agent = ca ? new HttpsAgent({ ca }) : undefined;
  const inflight = new Set();
  let upstream = null;
  const newAttempt = () => ({
    requests: 0, taps: [], uninspected: 0, bound: false, notCovered: null, onTrip: null, credentials: [], tripped: null,
  });
  let attempt = newAttempt();
  let closed = null;

  const reject = (incoming, outgoing, status) => {
    incoming.resume();
    outgoing.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    outgoing.end(`provider relay: ${status}`);
  };

  const tapResponse = (response, counts) => {
    const status = response.statusCode || 0;
    if (status < 200 || status >= 300) return;
    const tap = createRefusalTap({ contentType: response.headers['content-type'] });
    // Read at verdict time, not at end: a refusal frame already written counts
    // even if the body's last bytes are still in flight when the CLI exits.
    counts.taps.push(tap);
    let done = false;
    // `close` too: a body cut mid-stream still had its frames read.
    const finish = () => {
      if (done) return;
      done = true;
      tap.end();
    };
    const encoding = String(response.headers['content-encoding'] || 'identity').trim().toLowerCase();
    if (encoding === 'identity' || encoding === '') {
      response.on('data', (chunk) => tap.write(chunk));
      response.once('end', finish);
      response.once('close', finish);
      return;
    }
    const decoder = DECODERS[encoding]?.();
    if (!decoder) { counts.uninspected += 1; return; }
    let failed = false;
    decoder.on('data', (chunk) => tap.write(chunk));
    decoder.once('end', () => { if (!failed) finish(); });
    decoder.once('error', () => { failed = true; counts.uninspected += 1; });
    response.on('data', (chunk) => decoder.write(chunk));
    response.once('end', () => decoder.end());
    response.once('close', () => { if (!decoder.writableEnded) decoder.end(); });
  };

  const trip = (counts, failure) => {
    if (counts.tripped) return;
    counts.tripped = failure;
    try { counts.onTrip(failure); } catch { /* the trip stands */ }
  };

  const server = createServer((incoming, outgoing) => {
    if (!upstream) { reject(incoming, outgoing, 503); return; }
    const url = incoming.url || '/';
    if (!url.startsWith(`${prefix}/`)) { reject(incoming, outgoing, 404); return; }
    if (attempt.tripped) {
      incoming.resume();
      outgoing.writeHead(503, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: { message: 'stopped by the seat after a provider failure' } }));
      return;
    }
    const rest = url.slice(prefix.length);
    const queryAt = rest.indexOf('?');
    const path = queryAt < 0 ? rest : rest.slice(0, queryAt);
    const search = queryAt < 0 ? '' : rest.slice(queryAt);
    if (!isPlainRequestTarget(path) || path.split('/').includes('..')) { reject(incoming, outgoing, 400); return; }
    const basePath = upstream.pathname.replace(/\/+$/, '');
    if (basePath && path !== basePath && !path.startsWith(`${basePath}/`)) { reject(incoming, outgoing, 404); return; }

    // Counted against the attempt live when the request arrived.
    const counts = attempt;
    counts.requests += 1;
    const judged = !!counts.onTrip && incoming.method === 'POST';
    let clientGone = false;
    const target = upstream;
    const headers = withoutHeaders(incoming.headers, ['host']);
    headers.host = target.host;
    headers['accept-encoding'] = 'identity';
    const https = target.protocol === 'https:';
    const request = (https ? httpsRequest : httpRequest)({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${path}${search}`,
      method: incoming.method,
      headers,
      ...(https && agent ? { agent } : {}),
    }, (response) => {
      const status = response.statusCode || 502;
      if (judged && status >= 400) {
        // Read the error answer to name the failure, then pass it on whole so
        // the CLI's own handling still sees a well-formed answer.
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () => {
          const body = Buffer.concat(chunks);
          const failure = failureForStatus(status, body.toString('utf8'), {
            credentials: [...relayCredentials, ...counts.credentials],
          });
          if (failure) trip(counts, failure);
          outgoing.writeHead(status, withoutHeaders(response.headers));
          outgoing.end(body);
        });
        response.once('error', () => outgoing.destroy());
        return;
      }
      tapResponse(response, counts);
      outgoing.writeHead(status, withoutHeaders(response.headers));
      response.pipe(outgoing);
    });
    inflight.add(request);
    request.once('close', () => inflight.delete(request));
    request.on('error', (error) => {
      // An unreachable provider is a provider that is unavailable. A request
      // the CLI hung up on is not a provider failure.
      if (judged && !clientGone) {
        trip(counts, runFailure('provider_unavailable', `provider unreachable: ${error?.code || 'connection failed'}`, {
          credentials: [...relayCredentials, ...counts.credentials],
        }));
      }
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        outgoing.end('provider relay: upstream request failed');
      } else {
        outgoing.destroy();
      }
    });
    // A CLI that hangs up (or is killed) takes its upstream request with it.
    outgoing.on('close', () => {
      if (!outgoing.writableFinished) clientGone = true;
      request.destroy();
    });
    incoming.on('aborted', () => { clientGone = true; request.destroy(); });
    incoming.pipe(request);
  });
  // A WebSocket upgrade cannot be tapped as SSE; 426 sends the CLI to HTTP.
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  await new Promise((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolve(); });
  });
  const { port } = server.address();

  const handle = Object.freeze({
    /**
     * Route the CLI through the relay. `upstream` is the provider base URL the
     * CLI would otherwise call; the return value is the base URL to give the
     * CLI instead (same path, so path-sensitive CLI behaviour is unchanged).
     */
    bind({ upstream: value, onTrip = null, credentials = [] } = {}) {
      if (onTrip !== null && typeof onTrip !== 'function') throw new Error('provider relay onTrip must be a function');
      upstream = parseUpstream(value);
      attempt.bound = true;
      attempt.onTrip = onTrip;
      attempt.credentials = credentials.filter((c) => typeof c === 'string' && c);
      return `http://127.0.0.1:${port}${prefix}${upstream.pathname.replace(/\/+$/, '')}`;
    },
    /** Report that this CLI cannot be pointed at the relay, and why. */
    notCovered(reason) {
      attempt.notCovered = String(reason || 'the adapter reported this CLI cannot be pointed at the relay');
    },
  });

  return {
    port,
    handle,
    /**
     * Start a new attempt: its requests, refusals and pointing are its own.
     * The upstream stays bound so a request still draining from an earlier
     * attempt is forwarded, and counted against that attempt.
     */
    beginAttempt() { attempt = newAttempt(); },
    /** The current attempt's trip failure, or null. */
    get tripped() { return attempt.tripped; },
    /** In memory only: the current attempt's refusals, text included, for refusalDropped(). */
    get refusals() { return attempt.taps.map((tap) => tap.refusal).filter(Boolean); },
    /** The current attempt's coverage verdict. Carries no content. */
    get verdict() {
      const uninspected = attempt.uninspected + attempt.taps.filter((tap) => tap.overflowed).length;
      const base = {
        requests: attempt.requests,
        refusals: this.refusals.map(({ format, signal }) => ({ format, signal })),
        ...(attempt.tripped ? { tripped: { kind: attempt.tripped.kind, ...(attempt.tripped.status ? { status: attempt.tripped.status } : {}) } } : {}),
      };
      if (attempt.notCovered) return { status: COVERAGE.NOT_COVERED, reason: attempt.notCovered, ...base };
      if (!attempt.bound) return { status: COVERAGE.NOT_COVERED, reason: 'the adapter did not point its CLI at the relay', ...base };
      if (attempt.requests === 0) {
        return { status: COVERAGE.NOT_COVERED, reason: 'no provider request reached the relay; the CLI may ignore its base-URL override', ...base };
      }
      if (uninspected > 0) {
        return { status: COVERAGE.NOT_COVERED, reason: `${uninspected} response(s) could not be read for refusals`, ...base };
      }
      return { status: COVERAGE.COVERED, ...base };
    },
    get closed() { return closed !== null; },
    /** Stop listening, drop every open connection and upstream request. Idempotent. */
    close() {
      if (!closed) {
        closed = new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
          for (const request of inflight) request.destroy();
          agent?.destroy();
        });
      }
      return closed;
    },
  };
};
