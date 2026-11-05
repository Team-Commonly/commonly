#!/usr/bin/env node
/**
 * The grant broker, as a stdio MCP server codex can run (F175b).
 *
 * codex is admitted for the grant broker (ADAPTERS_WITH_GRANT_BROKER), but the
 * broker is a Streamable HTTP server (`grantBrokerServer`) and codex.js wires
 * stdio servers only, so a granted codex seat used to receive the entry and
 * drop it. codex's own url transport is no way round that: it reads a bearer
 * token from an environment variable (`bearer_token_env_var`), which would put
 * the token back in codex's environment and in every MCP child it spawns, the
 * thing TASK-083 took out.
 *
 * So codex runs this file, and this file speaks HTTP to the broker. It holds no
 * token of its own. It is told three things, none of them a secret:
 *   - COMMONLY_BROKER_URL: the broker url, already resolved to this instance;
 *   - COMMONLY_BROKER_HEADERS: the declared headers as TEMPLATES, still holding
 *     `${COMMONLY_AGENT_TOKEN}`;
 *   - COMMONLY_TOKEN_FILE: the path of this spawn's 0600 credential file, the
 *     same file the commonly MCP server reads.
 * The token is read from that file on every request (as claude's headersHelper
 * does), so it exists only in this process's memory and in the request header.
 *
 * It is a pass-through: each JSON-RPC line from codex is POSTed as it is, and
 * every message in the answer (plain JSON or an event stream) is written back
 * as a line. The broker is stateless, but a session id and the negotiated
 * protocol version are carried the way the spec asks, so a stateful server
 * would work too.
 *
 * It imports node builtins only. On a public seat codex runs it under the
 * seat's permission profile, which is granted read on THIS file alone; an
 * import from elsewhere in the CLI would need a wider grant. So the two small
 * pieces it shares with the rest of the CLI are restated here, and a test pins
 * the import list.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';


export const BRIDGE_PATH = fileURLToPath(import.meta.url);
export const BRIDGE_URL_VAR = 'COMMONLY_BROKER_URL';
export const BRIDGE_HEADERS_VAR = 'COMMONLY_BROKER_HEADERS';
export const TOKEN_PLACEHOLDER = '${COMMONLY_AGENT_TOKEN}';

// The same name as credential-file.js CREDENTIAL_FILE_VAR (a test pins it).
export const CREDENTIAL_FILE_VAR = 'COMMONLY_TOKEN_FILE';

const MAX_ERROR_TEXT = 2048;

// Streamable HTTP answers a POST with one JSON object or with an event stream
// of `data:` payloads. Same reading as pi-mcp-client.mjs parseMessages: the body
// decides before the header does.
const ssePayloads = (text) => text.split(/\r?\n\r?\n/)
  .map((block) => block.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n'))
  .filter(Boolean);

const parseMessages = (text, contentType) => {
  const body = text.trim();
  if (!body) return [];
  if (contentType.includes('text/event-stream')) return ssePayloads(body);
  if (body.startsWith('{') || body.startsWith('[')) return [body];
  return ssePayloads(body);
};

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export const createBrokerBridge = ({
  url,
  headerTemplates = {},
  tokenFile,
  fetchImpl = globalThis.fetch,
  write,
  timeoutMs = 120_000,
}) => {
  let sessionId = null;
  let protocolVersion = null;
  let lastToken = null;
  // Nothing the bridge writes back may hold the token, whatever produced it.
  const scrub = (text) => (lastToken ? String(text).split(lastToken).join('[token]') : String(text));

  const readToken = () => {
    if (!tokenFile) throw new Error(`no credential file (${CREDENTIAL_FILE_VAR} is unset)`);
    let token;
    try {
      token = readFileSync(tokenFile, 'utf8').trim();
    } catch (error) {
      throw new Error(`cannot read the credential file: ${error?.code || error?.message || error}`);
    }
    if (!token) throw new Error('the credential file is empty');
    lastToken = token;
    return token;
  };

  const headers = () => {
    const templates = Object.entries(headerTemplates);
    const token = templates.some(([, v]) => String(v).includes(TOKEN_PLACEHOLDER)) ? readToken() : null;
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...Object.fromEntries(templates.map(([k, v]) => [k, String(v).split(TOKEN_PLACEHOLDER).join(token)])),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
    };
  };

  // One exchange: POST the line, then hand each JSON-RPC message in the answer
  // to `onMessage` as it arrives. An event stream is read event by event, so a
  // notification sent before the response reaches codex then, and reading stops
  // once `onMessage` says the request is answered, whether or not the server
  // closes the stream. The timer covers the whole exchange, body included: a
  // stream that never answers still ends in an error, not a wait forever.
  const exchange = async (body, onMessage) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: headers(),
        body,
        signal: controller.signal,
        // The request carries the seat token, so no redirect is followed: a
        // redirect may point at another origin (same rule as connectHttpMcp).
        redirect: 'error',
      });
      const contentType = res.headers?.get?.('content-type') || '';
      const reader = res.ok && contentType.includes('text/event-stream') ? res.body?.getReader?.() : null;
      if (!reader) return { res, text: await res.text() };
      // Not every fetch errors a body it has already handed over when the
      // signal fires, so the timeout ends the read itself.
      const stopReading = () => reader.cancel().catch(() => {});
      controller.signal.addEventListener('abort', stopReading, { once: true });
      const decoder = new TextDecoder();
      let buffered = '';
      const drain = (final) => {
        const blocks = buffered.split(/\r?\n\r?\n/);
        buffered = final ? '' : blocks.pop();
        return blocks.flatMap((block) => ssePayloads(`${block}\n\n`)).some((raw) => onMessage(raw));
      };
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { value, done } = await reader.read();
        if (done) {
          buffered += decoder.decode();
          drain(true);
          break;
        }
        buffered += decoder.decode(value, { stream: true });
        if (drain(false)) {
          stopReading();
          break;
        }
      }
      if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { res, text: null };
    } finally {
      clearTimeout(timer);
    }
  };

  const handleLine = async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(JSON.stringify(rpcError(null, -32700, 'parse error')));
      return;
    }
    const id = message?.id;
    const isRequest = id !== undefined && id !== null && typeof message?.method === 'string';
    let answered = false;
    const fail = (text) => {
      if (isRequest && !answered) write(JSON.stringify(rpcError(id, -32000, `grant broker: ${scrub(text)}`)));
      else process.stderr.write(`[commonly-broker-bridge] ${scrub(text)}\n`);
    };
    // Writes one message back to codex; true once this request is answered.
    const forward = (raw) => {
      let answer;
      try {
        answer = JSON.parse(raw);
      } catch {
        return false;
      }
      if (message?.method === 'initialize' && answer?.id === id
        && typeof answer?.result?.protocolVersion === 'string') {
        protocolVersion = answer.result.protocolVersion;
      }
      write(JSON.stringify(answer));
      if (isRequest && answer?.id === id && ('result' in answer || 'error' in answer)) answered = true;
      return answered;
    };
    let res;
    let text;
    try {
      ({ res, text } = await exchange(line, forward));
    } catch (error) {
      fail(error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (error?.message || String(error)));
      return;
    }
    const header = res.headers?.get?.('mcp-session-id');
    if (header && !sessionId) sessionId = header;
    if (!res.ok) {
      fail(`HTTP ${res.status}${text ? `: ${text.slice(0, MAX_ERROR_TEXT)}` : ''}`);
      return;
    }
    if (text !== null) {
      for (const raw of parseMessages(text || '', res.headers?.get?.('content-type') || '')) forward(raw);
    }
  };

  return { handleLine };
};

const isMain = () => {
  try {
    return realpathSync(process.argv[1] || '') === realpathSync(BRIDGE_PATH);
  } catch {
    return false;
  }
};

if (isMain()) {
  const url = process.env[BRIDGE_URL_VAR];
  let headerTemplates = {};
  try {
    headerTemplates = JSON.parse(process.env[BRIDGE_HEADERS_VAR] || '{}');
  } catch {
    process.stderr.write(`[commonly-broker-bridge] ${BRIDGE_HEADERS_VAR} is not JSON\n`);
    process.exit(1);
  }
  if (!url) {
    process.stderr.write(`[commonly-broker-bridge] ${BRIDGE_URL_VAR} is unset\n`);
    process.exit(1);
  }
  const bridge = createBrokerBridge({
    url,
    headerTemplates,
    tokenFile: process.env[CREDENTIAL_FILE_VAR],
    // A closed stdout (codex gone) must not become an unhandled rejection.
    write: (line) => { try { process.stdout.write(`${line}\n`); } catch { /* codex has gone */ } },
  });
  const pending = new Set();
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const task = bridge.handleLine(line).finally(() => pending.delete(task));
    pending.add(task);
  });
  lines.on('close', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
}
