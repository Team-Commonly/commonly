/**
 * A grant says what one run may hold and do: which credentials reach its env,
 * and which tool calls it may make without asking, only after asking, or never.
 *
 *   {
 *     credentials: [{ name: 'OPENAI_API_KEY', from: 'env'|'file'|'resolver', ref? }],
 *     tools: { allow: [pattern], ask: [pattern], deny: [pattern] },
 *     network: { allow: ['api.example.com:443', '*.example.com:443'] },
 *   }
 *
 * `from: 'env'` copies baseEnv[ref ?? name]; `from: 'file'` reads the absolute
 * path in `ref`; `from: 'resolver'` asks the host's resolveSecret(name, spec),
 * with `ref` as an opaque hint for it.
 *
 * A tool pattern is `<kind>` or `<kind>:<title glob>`, where kind is one of
 * ACP's ToolKind values or `*`. `execute` matches every execute call;
 * `execute:git status*` matches execute calls whose title starts that way;
 * `*:*.env*` matches any kind by title. Globs know `*` and `?` only.
 *
 * The title is text the agent chose. A title-glob deny narrows what the agent
 * can do; a title-glob allow is only as strong as the agent's honesty about
 * its title, so prefer kind-level allows and put execute behind ask.
 *
 * Precedence is deny > ask > allow, and a call no rule names is denied.
 *
 * `network.allow` names the hosts a run may open a connection to, each as
 * `host:port` or `*.suffix:port`. Egress is deny-by-default: no `network`
 * field allows nothing, and the run's model provider is added by the caller
 * (sandbox.js), not by the grant. A wildcard matches one or more labels under
 * its suffix and never the bare suffix: `*.example.com:443` admits
 * `api.example.com` and `a.b.example.com`, not `example.com`. Entries are
 * names, never addresses: an IP literal, a bare `*`, a scheme, userinfo, a
 * path or a port outside 1-65535 is refused, and so is a wildcard whose
 * suffix is one label (`*.com`). The proxy that enforces this is
 * egress-proxy.js; the sandbox makes it the only way out.
 */

import { isIP } from 'node:net';

export const TOOL_KINDS = Object.freeze(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other']);
export const CREDENTIAL_SOURCES = Object.freeze(['env', 'file', 'resolver']);
const RULE_LISTS = ['deny', 'ask', 'allow']; // checked in this order: the precedence
export const EGRESS_MAX_ENTRIES = 256;
const VALIDATED = Symbol('validated grant');

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// Names the run env is built from. A credential under one of these names would
// overwrite the boundary itself (a granted HOME points back at the real login).
// The proxy variables are the egress route sandbox.js sets.
const RESERVED_NAME = /^(?:HOME|PATH|TMPDIR|USER|LOGNAME|SHELL|PWD|LANG|LC_[A-Z0-9_]+|TERM|TZ|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR|XDG_[A-Z0-9_]+|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY)$/;

const fail = (message) => { throw new Error(`grant: ${message}`); };
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuseUnknownKeys = (value, allowed, where) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`unknown field ${where}${key}`);
  }
};

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]')}$`);

/** Parse once at validation so matching never re-reads a malformed pattern. */
const parsePattern = (pattern, where) => {
  if (typeof pattern !== 'string' || !pattern.trim()) fail(`${where} must be a non-empty string`);
  const colon = pattern.indexOf(':');
  const kind = colon === -1 ? pattern : pattern.slice(0, colon);
  const title = colon === -1 ? null : pattern.slice(colon + 1);
  if (kind !== '*' && !TOOL_KINDS.includes(kind)) fail(`${where} names unknown tool kind "${kind}"`);
  if (title !== null && !title) fail(`${where} has an empty title glob`);
  return Object.freeze({ pattern, kind, title: title === null ? null : globToRegExp(title) });
};

const validateCredential = (credential, index, seen) => {
  const where = `credentials[${index}]`;
  if (!isPlainObject(credential)) fail(`${where} must be an object`);
  refuseUnknownKeys(credential, ['name', 'from', 'ref'], `${where}.`);
  const { name, from, ref } = credential;
  if (typeof name !== 'string' || !ENV_NAME.test(name)) fail(`${where}.name must be an ENV_NAME (A-Z, 0-9, _)`);
  if (RESERVED_NAME.test(name)) fail(`${where}.name ${name} is reserved for the run env`);
  if (seen.has(name)) fail(`${where}.name ${name} is granted twice`);
  seen.add(name);
  if (!CREDENTIAL_SOURCES.includes(from)) fail(`${where}.from must be one of ${CREDENTIAL_SOURCES.join(', ')}`);
  if (ref !== undefined && (typeof ref !== 'string' || !ref)) fail(`${where}.ref must be a non-empty string`);
  if (from === 'env' && ref !== undefined && !ENV_NAME.test(ref)) fail(`${where}.ref must be an ENV_NAME for from: env`);
  if (from === 'file' && (ref === undefined || !ref.startsWith('/'))) fail(`${where}.ref must be an absolute path for from: file`);
  return Object.freeze(ref === undefined ? { name, from } : { name, from, ref });
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lower case, one trailing dot dropped: the form a host is compared in. */
export const normalizeHost = (host) => String(host).toLowerCase().replace(/\.$/, '');

/**
 * A DNS name, not an address. A numeric last label is refused because
 * resolvers read `2130706433`, `0x7f.1` and `127.1` as IPv4.
 */
export const isHostName = (host) => {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  return labels.every((label) => LABEL.test(label)) && !/^(?:\d+|0x[0-9a-f]*)$/.test(labels.at(-1));
};

const parsePort = (text) => (/^[1-9]\d{0,4}$/.test(text) && Number(text) <= 65535 ? Number(text) : null);

/**
 * Parse one network.allow entry into { entry, host, port, wildcard }. For a
 * wildcard, `host` is the suffix. Exported so the proxy reads its allowlist
 * through the same rules the grant was checked by.
 */
export const parseEgressEntry = (entry, where = 'network.allow entry') => {
  if (typeof entry !== 'string' || !entry) fail(`${where} must be a non-empty string`);
  if (entry.includes('://')) fail(`${where} must not carry a scheme: write host:port`);
  if (/[@/?#\s\\[\]]/.test(entry)) fail(`${where} must be host:port with no userinfo, path, brackets or spaces`);
  const colon = entry.lastIndexOf(':');
  if (colon === -1) fail(`${where} must name a port (host:port)`);
  const port = parsePort(entry.slice(colon + 1));
  if (port === null) fail(`${where} has a port outside 1-65535`);
  const raw = entry.slice(0, colon);
  if (raw === '*') fail(`${where} may not be a bare *`);
  const wildcard = raw.startsWith('*.');
  const host = normalizeHost(wildcard ? raw.slice(2) : raw);
  if (host.includes('*')) fail(`${where} may use * only as a whole leading label (*.example.com)`);
  if (isIP(host) || host.includes(':')) fail(`${where} is an IP address; name the host instead`);
  if (!isHostName(host)) fail(`${where} is not a valid host name`);
  if (wildcard && !host.includes('.')) fail(`${where} wildcards a one-label suffix; name at least two labels`);
  const normal = `${wildcard ? '*.' : ''}${host}:${port}`;
  return Object.freeze({ entry: normal, host, port, wildcard });
};

const validateNetwork = (network) => {
  if (!isPlainObject(network)) fail('network must be an object');
  if ('allowIps' in network) fail('network.allowIps is not supported; name hosts in network.allow');
  refuseUnknownKeys(network, ['allow'], 'network.');
  const allow = network.allow ?? [];
  if (!Array.isArray(allow)) fail('network.allow must be an array');
  if (allow.length > EGRESS_MAX_ENTRIES) fail(`network.allow holds more than ${EGRESS_MAX_ENTRIES} entries`);
  const seen = new Set();
  return Object.freeze({
    allow: Object.freeze(allow.map((entry, i) => {
      const parsed = parseEgressEntry(entry, `network.allow[${i}]`);
      if (seen.has(parsed.entry)) fail(`network.allow[${i}] repeats ${parsed.entry}`);
      seen.add(parsed.entry);
      return parsed;
    })),
  });
};

/**
 * The allow entry that admits host:port, or null. `exact` on the result says
 * whether it named the host itself (the proxy lets only an exact entry reach
 * a private address), so an exact entry wins over a wildcard that also fits.
 */
export const matchEgress = (allow, host, port) => {
  const name = normalizeHost(host);
  if (!isHostName(name) || !Number.isInteger(port)) return null;
  // An exact entry is looked for first: it is what admits a private address.
  const exact = allow.find((parsed) => !parsed.wildcard && parsed.port === port && parsed.host === name);
  if (exact) return { entry: exact.entry, exact: true };
  const wild = allow.find((parsed) => parsed.wildcard && parsed.port === port
    && name.length > parsed.host.length + 1 && name.endsWith(`.${parsed.host}`));
  return wild ? { entry: wild.entry, exact: false } : null;
};

/** Validate and freeze a grant. Throws on the first problem; never repairs one. */
export const validateGrant = (grant) => {
  if (grant && grant[VALIDATED]) return grant;
  if (!isPlainObject(grant)) fail('must be an object');
  refuseUnknownKeys(grant, ['credentials', 'tools', 'network'], '');
  const credentials = grant.credentials ?? [];
  if (!Array.isArray(credentials)) fail('credentials must be an array');
  const seen = new Set();
  const tools = grant.tools ?? {};
  if (!isPlainObject(tools)) fail('tools must be an object');
  refuseUnknownKeys(tools, RULE_LISTS, 'tools.');
  const rules = {};
  for (const list of RULE_LISTS) {
    const patterns = tools[list] ?? [];
    if (!Array.isArray(patterns)) fail(`tools.${list} must be an array`);
    rules[list] = Object.freeze(patterns.map((pattern, i) => parsePattern(pattern, `tools.${list}[${i}]`)));
  }
  return Object.freeze({
    [VALIDATED]: true,
    credentials: Object.freeze(credentials.map((c, i) => validateCredential(c, i, seen))),
    tools: Object.freeze(rules),
    network: validateNetwork(grant.network ?? {}),
  });
};
const matches = (parsed, kind, title) => (parsed.kind === '*' || parsed.kind === kind)
  && (parsed.title === null || parsed.title.test(title));

/**
 * Which rule decides this tool call. ACP makes `kind` optional and means
 * `other` when it is absent, so that is what an unknown or missing kind is.
 * Returns { decision: 'allow'|'ask'|'deny', rule: { list, pattern } }.
 */
export const matchToolCall = (grant, toolCall = {}) => {
  const valid = validateGrant(grant);
  const kind = TOOL_KINDS.includes(toolCall?.kind) ? toolCall.kind : 'other';
  const title = typeof toolCall?.title === 'string' ? toolCall.title : '';
  for (const list of RULE_LISTS) {
    const hit = valid.tools[list].find((parsed) => matches(parsed, kind, title));
    if (hit) return { decision: list, rule: { list, pattern: hit.pattern } };
  }
  return { decision: 'deny', rule: { list: 'default', pattern: null } };
};
