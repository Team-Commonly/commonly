/**
 * A grant says what one run may hold and do: which credentials reach its env,
 * and which tool calls it may make without asking, only after asking, or never.
 *
 *   {
 *     credentials: [{ name: 'OPENAI_API_KEY', from: 'env'|'file'|'resolver', ref? }],
 *     tools: { allow: [pattern], ask: [pattern], deny: [pattern] },
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
 * `network` rules are refused for now rather than accepted and ignored: a run
 * would believe it was fenced when nothing enforces the fence. TODO: egress
 * allowlist once a sandbox can enforce it.
 */

export const TOOL_KINDS = Object.freeze(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other']);
export const CREDENTIAL_SOURCES = Object.freeze(['env', 'file', 'resolver']);
const RULE_LISTS = ['deny', 'ask', 'allow']; // checked in this order: the precedence
const VALIDATED = Symbol('validated grant');

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// Names the run env is built from. A credential under one of these names would
// overwrite the boundary itself (a granted HOME points back at the real login).
const RESERVED_NAME = /^(?:HOME|PATH|TMPDIR|USER|LOGNAME|SHELL|PWD|LANG|LC_[A-Z0-9_]+|TERM|TZ|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR|XDG_[A-Z0-9_]+)$/;

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

/** Validate and freeze a grant. Throws on the first problem; never repairs one. */
export const validateGrant = (grant) => {
  if (grant && grant[VALIDATED]) return grant;
  if (!isPlainObject(grant)) fail('must be an object');
  if ('network' in grant) fail('network rules are not enforced yet; remove the field rather than rely on it');
  refuseUnknownKeys(grant, ['credentials', 'tools'], '');
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
