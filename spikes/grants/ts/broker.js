#!/usr/bin/env node
/**
 * Grants broker, Node implementation. An MCP Streamable HTTP endpoint (JSON
 * responses, no SSE) that forwards to one upstream MCP server under a per-run
 * scoped grant. Built-ins only, so there is nothing to install beyond Node.
 *
 * Usage: node broker.js --config <file>
 * Env:   GRANTS_UPSTREAM_CREDENTIAL, GRANTS_ADMIN_TOKEN (kept out of the file)
 */
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fchmodSync, openSync, readFileSync, writeSync } from 'node:fs';

const MAX_BODY_BYTES = 1 << 20;
const UPSTREAM_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// The credential is redacted from upstream bodies by plain substring
// replacement, which is only sound when JSON encoding cannot change its text.
const CREDENTIAL_SHAPE = /^[A-Za-z0-9._~-]{16,}$/;
const CODE = {
  parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602,
  unauthorized: -32001, upstream: -32002, refused: -32003,
};

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
const refusal = (reason) => new RpcError(CODE.refused, `refused: ${reason}`, { reason });

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Sorted keys at every depth, so the digest names the arguments, not the
// order a client happened to serialise them in.
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

const validateGrant = (raw) => {
  const g = raw || {};
  const strings = (list) => Array.isArray(list) && list.every((t) => typeof t === 'string');
  if (typeof g.runId !== 'string' || !g.runId) return 'runId must be a non-empty string';
  if (typeof g.token !== 'string' || g.token.length < 16) return 'token must be at least 16 characters';
  if (!strings(g.tools)) return 'tools must be an array of strings';
  if (g.approve !== undefined && !strings(g.approve)) return 'approve must be an array of strings';
  if (typeof g.expiresAt !== 'string' || !RFC3339.test(g.expiresAt) || Number.isNaN(Date.parse(g.expiresAt))) {
    return 'expiresAt must be an RFC 3339 timestamp';
  }
  if (!Number.isInteger(g.maxCalls) || g.maxCalls < 1) return 'maxCalls must be a positive integer';
  return null;
};

const createGrantStore = () => {
  const byToken = new Map(); // sha256(token) -> grant; the raw token is never kept
  return {
    add(raw) {
      const problem = validateGrant(raw);
      if (problem) return { error: problem, status: 400 };
      const key = sha256(raw.token);
      if (byToken.has(key)) return { error: 'a grant with this token exists', status: 409 };
      byToken.set(key, {
        runId: raw.runId,
        tools: new Set(raw.tools),
        approve: new Set(raw.approve || []),
        expiresAtMs: Date.parse(raw.expiresAt),
        maxCalls: raw.maxCalls,
        used: 0,
      });
      return { runId: raw.runId };
    },
    find: (token) => byToken.get(sha256(token)),
  };
};

const openAudit = (path) => {
  const fd = openSync(path, 'a', 0o600);
  // A pre-existing file keeps its old mode on open; tighten it either way.
  fchmodSync(fd, 0o600);
  return {
    write(entry) { writeSync(fd, `${JSON.stringify(entry)}\n`); },
    close() { closeSync(fd); },
  };
};

const createApprovals = (timeoutMs) => {
  const pending = new Map();
  return {
    // Resolves 'allow' | 'deny' | 'timeout'. Whichever of decide() and the
    // timer runs first deletes the entry, so the other is a no-op.
    hold(info) {
      const id = randomBytes(12).toString('hex');
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve('timeout'); }, timeoutMs);
        pending.set(id, { ...info, id, createdAt: new Date().toISOString(), settle: (d) => { clearTimeout(timer); resolve(d); } });
      });
    },
    list: () => [...pending.values()].map(({ settle, ...rest }) => rest),
    decide(id, decision) {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      entry.settle(decision);
      return true;
    },
  };
};

const createUpstream = (url, credential) => {
  let nextId = 1;
  return async (method, params) => {
    let text;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      text = await res.text();
    } catch {
      // No upstream detail goes back: it is the one place the credential could ride.
      throw new RpcError(CODE.upstream, 'upstream_unavailable');
    }
    let reply;
    try { reply = JSON.parse(text.split(credential).join('[redacted]')); } catch {
      throw new RpcError(CODE.upstream, 'upstream_invalid_response');
    }
    if (reply.error) throw new RpcError(reply.error.code ?? CODE.upstream, String(reply.error.message ?? 'upstream_error'));
    return reply.result;
  };
};

const createBroker = ({ grants, audit, approvals, upstream }) => {
  const record = (grant, tool, decision, digest, reason) => audit.write({
    ts: new Date().toISOString(), runId: grant.runId, tool, decision, ...(reason ? { reason } : {}), argsDigest: digest,
  });

  // A refused call is audited and thrown in one step so no refusal can skip the log.
  const refuse = (grant, tool, digest, reason) => {
    record(grant, tool, 'refused', digest, reason);
    return refusal(reason);
  };

  const usable = (grant) => {
    if (Date.now() >= grant.expiresAtMs) return 'expired';
    if (grant.used >= grant.maxCalls) return 'max_calls';
    return null;
  };

  const listTools = async (grant) => {
    const reason = usable(grant);
    if (reason) throw refusal(reason);
    const result = await upstream('tools/list', {});
    return { tools: (result?.tools || []).filter((t) => grant.tools.has(t.name)) };
  };

  const callTool = async (grant, params) => {
    const tool = params?.name;
    const args = params?.arguments ?? {};
    if (typeof tool !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
      throw new RpcError(CODE.invalidParams, 'tools/call needs a string name and object arguments');
    }
    const digest = sha256(canonicalJson(args));
    if (Date.now() >= grant.expiresAtMs) throw refuse(grant, tool, digest, 'expired');
    if (!grant.tools.has(tool)) throw refuse(grant, tool, digest, 'not_granted');
    if (grant.used >= grant.maxCalls) throw refuse(grant, tool, digest, 'max_calls');
    // Reserve the slot before any await, so concurrent calls cannot overspend.
    grant.used += 1;
    if (grant.approve.has(tool)) {
      const outcome = await approvals.hold({ runId: grant.runId, tool, arguments: args, argsDigest: digest });
      if (outcome !== 'allow') {
        const decision = outcome === 'deny' ? 'denied' : 'timeout';
        record(grant, tool, decision, digest);
        throw refusal(outcome === 'deny' ? 'approval_denied' : 'approval_timeout');
      }
      record(grant, tool, 'approved', digest);
    } else {
      record(grant, tool, 'allowed', digest);
    }
    return upstream('tools/call', { name: tool, arguments: args });
  };

  const dispatch = async (grant, msg) => {
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'grants-broker', version: '0.1.0' },
        };
      }
      case 'ping': return {};
      case 'tools/list': return listTools(grant);
      case 'tools/call': return callTool(grant, msg.params);
      default: throw new RpcError(CODE.methodNotFound, `method not found: ${msg.method}`);
    }
  };

  return { dispatch };
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const send = (res, status, body) => {
  if (body === undefined) { res.writeHead(status).end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
};
const rpcError = (id, err) => ({
  jsonrpc: '2.0', id: id ?? null, error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) },
});
const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '';

const handleMcp = async (req, res, { grants, broker }) => {
  const grant = grants.find(bearer(req));
  if (!grant) return send(res, 401, rpcError(null, new RpcError(CODE.unauthorized, 'unauthorized')));
  let msg;
  try { msg = JSON.parse(await readBody(req)); } catch (e) {
    if (e.status) return send(res, e.status, rpcError(null, new RpcError(CODE.invalidRequest, 'body too large')));
    return send(res, 400, rpcError(null, new RpcError(CODE.parse, 'parse error')));
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return send(res, 400, rpcError(msg?.id, new RpcError(CODE.invalidRequest, 'invalid request')));
  }
  if (msg.id === undefined) return send(res, 202); // notification: accepted, no body
  try {
    return send(res, 200, { jsonrpc: '2.0', id: msg.id, result: await broker.dispatch(grant, msg) });
  } catch (err) {
    const known = err instanceof RpcError ? err : new RpcError(CODE.upstream, 'internal_error');
    return send(res, 200, rpcError(msg.id, known));
  }
};

const handleAdmin = async (req, res, path, { adminToken, grants, approvals }) => {
  if (!sameSecret(bearer(req), adminToken)) return send(res, 401, { error: 'unauthorized' });
  if (req.method === 'GET' && path === '/approvals') return send(res, 200, { approvals: approvals.list() });
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
  if (req.method === 'POST' && path === '/grants') {
    const out = grants.add(body);
    return out.error ? send(res, out.status, { error: out.error }) : send(res, 201, out);
  }
  const match = /^\/approvals\/([^/]+)$/.exec(path);
  if (req.method === 'POST' && match) {
    const decision = body?.decision;
    if (decision !== 'allow' && decision !== 'deny') return send(res, 400, { error: 'decision must be allow or deny' });
    return approvals.decide(match[1], decision) ? send(res, 200, { id: match[1], decision }) : send(res, 404, { error: 'no such pending approval' });
  }
  return send(res, 404, { error: 'not found' });
};

const fail = (message) => { process.stderr.write(`grants-broker: ${message}\n`); process.exit(2); };

const main = () => {
  const at = process.argv.indexOf('--config');
  if (at < 0 || !process.argv[at + 1]) fail('usage: broker --config <file>');
  let config;
  try { config = JSON.parse(readFileSync(process.argv[at + 1], 'utf8')); } catch (e) { fail(`cannot read config: ${e.message}`); }
  const credential = process.env.GRANTS_UPSTREAM_CREDENTIAL || '';
  const adminToken = process.env.GRANTS_ADMIN_TOKEN || '';
  if (!CREDENTIAL_SHAPE.test(credential)) fail('GRANTS_UPSTREAM_CREDENTIAL must be 16+ chars of [A-Za-z0-9._~-]');
  if (adminToken.length < 16) fail('GRANTS_ADMIN_TOKEN must be at least 16 characters');
  if (typeof config.upstreamUrl !== 'string' || typeof config.auditPath !== 'string') fail('config needs upstreamUrl and auditPath');

  const grants = createGrantStore();
  for (const g of config.grants || []) {
    const out = grants.add(g);
    if (out.error) fail(`grant ${g?.runId ?? '?'}: ${out.error}`);
  }
  const audit = openAudit(config.auditPath);
  const approvals = createApprovals(Number(config.approvalTimeoutMs) || 60_000);
  const upstream = createUpstream(config.upstreamUrl, credential);
  const broker = createBroker({ grants, audit, approvals, upstream });
  const deps = { grants, approvals, broker, adminToken };

  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://broker').pathname;
    const route = path === '/mcp'
      ? (req.method === 'POST' ? handleMcp(req, res, deps) : send(res, 405, { error: 'POST only; no SSE stream is offered' }))
      : handleAdmin(req, res, path, deps);
    Promise.resolve(route).catch(() => { if (!res.headersSent) send(res, 500, { error: 'internal_error' }); });
  });
  const [host, port] = String(config.listen || '127.0.0.1:0').split(/:(?=\d+$)/);
  server.listen(Number(port), host, () => {
    const addr = server.address();
    process.stdout.write(`${JSON.stringify({ listening: `${addr.address}:${addr.port}` })}\n`);
  });
  const stop = () => server.close(() => { audit.close(); process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};

main();
