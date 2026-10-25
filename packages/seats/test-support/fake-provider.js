/**
 * A local scripted model server for tests, the compatibility matrix and the
 * harness bench. Real CLIs point their provider base URL here and run a genuine
 * turn with no key and no network.
 *
 * Wire formats (see fake-provider/wire-*.js):
 *   POST /v1/chat/completions          OpenAI chat completions
 *   POST /v1/responses                 OpenAI Responses (codex, wire_api = "responses")
 *   POST /v1/messages                  Anthropic Messages (Claude Code)
 *   POST /v1/messages/count_tokens     Anthropic token count (never advances a script)
 *   GET  /v1/models                    a one-model list readable by either family
 *
 * What the model says comes from, in order:
 *   1. `script`: one entry per model request, shared across formats. Each entry
 *      is a string (text), a turn object, or `(request) => turn`.
 *   2. Inline directives in the prompt (the last user message that is not a tool result):
 *        [[reply:TEXT]]  answer TEXT (default: PONG)
 *        [[stall]]       accept the request and never answer (liveness tests)
 *        [[refuse]]      refuse, in the format's own refusal shape
 *        [[fail:CODE]]   answer HTTP CODE with the format's error body
 *        [[tool:NAME:{json}]]  call tool NAME; the next request (carrying the
 *                        result) gets the reply. Repeat for parallel calls.
 *        [[think:TEXT]]  emit a thought before the answer
 *        [[cut:N]] / [[cut:N:close]]  send N frames (or N bytes when not
 *                        streaming), then go silent, or destroy the socket
 *
 * Turn object: { text: string|string[], thought, toolCalls: [{name, arguments}],
 *   stop: 'end'|'tool_use'|'max_tokens'|<raw>, stall: true, refuse: true|string,
 *   refuseAs: 'error'|'inband', error: CODE | {status, type, message, inStream, headers},
 *   cut: N | {after, mode: 'silent'|'close'} }
 *
 * `tls: { key, cert }` serves the same routes over HTTPS.
 *
 * Capture: `requests` holds model calls (the shape older checks read, plus
 * format/path/headers/body/receivedAt); `allRequests` holds every HTTP request.
 * Auth header values are redacted to their scheme. `findInRequests(needle)`
 * searches the unredacted traffic, so a canary in a header is still found.
 */
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { normaliseTurn, turnFromDirectives, conversationFacts, parseDirectives } from './fake-provider/turns.js';
import { openReply } from './fake-provider/reply.js';
import * as chat from './fake-provider/wire-chat.js';
import * as anthropic from './fake-provider/wire-anthropic.js';
import * as responses from './fake-provider/wire-responses.js';

export { parseDirectives, normaliseTurn };

const ROUTES = [
  { re: /\/messages\/count_tokens$/, wire: anthropic, countTokens: true },
  { re: /\/messages$/, wire: anthropic },
  { re: /\/responses$/, wire: responses },
  { re: /\/chat\/completions$/, wire: chat },
];

const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie', 'x-goog-api-key']);

/** Keep the scheme ("Bearer") so a check can see how a CLI authenticated, never the value. */
const redactHeaders = (headers) => Object.fromEntries(Object.entries(headers).map(([name, value]) => {
  if (!SECRET_HEADERS.has(name)) return [name, value];
  const scheme = /^(authorization|proxy-authorization)$/.test(name) ? String(value).split(/\s+/)[0] : '';
  return [name, scheme && scheme !== value ? scheme : '[redacted]'];
}));

const authOf = (headers) => {
  if (headers['x-api-key'] !== undefined) return { header: 'x-api-key', scheme: 'x-api-key' };
  if (headers.authorization !== undefined) return { header: 'authorization', scheme: String(headers.authorization).split(/\s+/)[0] };
  return { header: null, scheme: null };
};

const decode = (buffer, encoding) => {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
    if (encoding === 'zstd' && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buffer);
  } catch { /* fall through to the raw bytes */ }
  return buffer;
};

const stringLeaves = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringLeaves(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringLeaves(v, out));
  return out;
};

const loadScript = (script) => {
  if (typeof script === 'string') return JSON.parse(readFileSync(script, 'utf8'));
  return Array.isArray(script) ? script : null;
};

const modelList = (model) => ({
  object: 'list',
  // OpenAI reads id/object/owned_by; Anthropic reads type/id/display_name.
  data: [{ id: model, object: 'model', owned_by: 'fake', type: 'model', display_name: model, created: 0, created_at: '1970-01-01T00:00:00Z' }],
  has_more: false,
  first_id: model,
  last_id: model,
});

export const startFakeProvider = async ({
  model = 'fake-model', defaultReply = 'PONG', port = 0, script = null, scriptFilter = null, tls = null,
} = {}) => {
  const requests = [];
  const allRequests = [];
  const raw = []; // unredacted traffic, parallel to allRequests; never exposed
  const toolCalls = [];
  const toolResults = [];
  const open = new Set();
  let turns = loadScript(script);
  let position = 0;

  const nextTurn = (request, facts) => {
    const scripted = turns && position < turns.length && (!scriptFilter || scriptFilter(request));
    if (scripted) {
      const index = position;
      position += 1;
      const entry = turns[index];
      const turn = normaliseTurn(typeof entry === 'function' ? entry(request) : entry, { defaultReply });
      return { turn, scriptTurn: index };
    }
    return { turn: turnFromDirectives(facts.prompt, facts.toolRounds, { defaultReply }), scriptTurn: null };
  };

  // `tls: { key, cert }` serves HTTPS, for a client that must verify the cert it is handed.
  const server = (tls ? (handler) => createTlsServer(tls, handler) : createServer)((req, res) => {
    open.add(res);
    res.on('close', () => open.delete(res));
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bytes = decode(Buffer.concat(chunks), req.headers['content-encoding']);
      const text = bytes.toString('utf8');
      const path = new URL(req.url, 'http://fake').pathname;
      const route = req.method === 'POST' ? ROUTES.find((r) => r.re.test(path)) : null;
      let body = {};
      try { body = JSON.parse(text || '{}'); } catch { /* answer as default */ }
      const record = {
        format: route ? route.wire.format : null,
        method: req.method,
        path,
        url: req.url,
        headers: redactHeaders(req.headers),
        body,
        bytes: bytes.length,
        receivedAt: Date.now(),
      };
      allRequests.push(record);
      raw.push({ headers: req.headers, text, leaves: stringLeaves(body) });

      if (req.method === 'GET' && /\/models$/.test(path)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(modelList(model)));
        return;
      }
      if (!route) { res.writeHead(404); res.end(); return; }
      const usage = { input: Math.max(1, Math.ceil(bytes.length / 4)), output: 1 };
      if (route.countTokens) { route.wire.countTokens(openReply(res, null), usage); return; }

      const facts = conversationFacts(route.wire.entries(body));
      const n = requests.length + 1;
      const call = Object.assign(record, {
        model: body.model,
        stream: !!body.stream,
        authorization: req.headers.authorization ? 'present' : 'absent',
        auth: authOf(req.headers),
        toolResults: facts.toolResults,
      });
      const { turn, scriptTurn } = nextTurn(call, facts);
      Object.assign(call, { directive: turn.kind, scriptTurn });
      requests.push(call);
      for (const result of facts.toolResults) toolResults.push({ request: n - 1, ...result });

      if (turn.stall) return; // hold the socket open, never answer
      usage.output = Math.max(1, Math.ceil((turn.text.join('').length + (turn.thought || '').length) / 4));
      const emitted = route.wire.respond(turn, { reply: openReply(res, turn.cut), body, model, n, usage });
      for (const c of emitted) toolCalls.push({ request: n - 1, id: c.id, name: c.name, arguments: c.arguments ?? c.input });
      call.toolCalls = emitted.map((c) => ({ id: c.id, name: c.name }));
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address();
  const origin = `${tls ? 'https' : 'http'}://127.0.0.1:${bound}`;

  /** Every place `needle` reached the provider: body, URL, or any header value (unredacted). */
  const findInRequests = (needle) => {
    const hit = typeof needle === 'string' ? (s) => s.includes(needle) : (s) => needle.test(s);
    const found = [];
    raw.forEach((r, index) => {
      const { format, path } = allRequests[index];
      if (hit(allRequests[index].url)) found.push({ index, format, path, where: 'url' });
      if (hit(r.text) || r.leaves.some(hit)) found.push({ index, format, path, where: 'body' });
      for (const [name, value] of Object.entries(r.headers)) {
        if (hit(Array.isArray(value) ? value.join(', ') : String(value))) found.push({ index, format, path, where: `header:${name}` });
      }
    });
    return found;
  };

  return {
    baseURL: `${origin}/v1`,
    /** Anthropic SDKs append /v1/messages themselves, so they take the bare origin. */
    anthropicBaseURL: origin,
    origin,
    model,
    requests,
    allRequests,
    toolCalls,
    toolResults,
    findInRequests,
    get scriptPosition() { return position; },
    /** Swap the script and rewind, so one provider can serve several scripted checks. */
    setScript: (next) => { turns = loadScript(next); position = 0; },
    close: () => new Promise((resolve) => { for (const r of open) r.destroy(); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
};
