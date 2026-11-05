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

  const readToken = () => {
    if (!tokenFile) throw new Error(`no credential file (${CREDENTIAL_FILE_VAR} is unset)`);
    let token;
    try {
      token = readFileSync(tokenFile, 'utf8').trim();
    } catch (error) {
      throw new Error(`cannot read the credential file: ${error?.code || error?.message || error}`);
    }
    if (!token) throw new Error('the credential file is empty');
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

  const post = async (body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: headers(),
        body,
        signal: controller.signal,
        // The request carries the seat token, so no redirect is followed: a
        // redirect may point at another origin (same rule as connectHttpMcp).
        redirect: 'error',
      });
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
    const fail = (text) => {
      if (isRequest) write(JSON.stringify(rpcError(id, -32000, `grant broker: ${text}`)));
      else process.stderr.write(`[commonly-broker-bridge] ${text}\n`);
    };
    let res;
    let text;
    try {
      res = await post(line);
      text = await res.text();
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
    for (const raw of parseMessages(text || '', res.headers?.get?.('content-type') || '')) {
      let answer;
      try {
        answer = JSON.parse(raw);
      } catch {
        continue;
      }
      if (message?.method === 'initialize' && answer?.id === id
        && typeof answer?.result?.protocolVersion === 'string') {
        protocolVersion = answer.result.protocolVersion;
      }
      write(JSON.stringify(answer));
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
    write: (line) => process.stdout.write(`${line}\n`),
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
