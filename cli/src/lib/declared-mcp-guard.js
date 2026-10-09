/**
 * Guard server-declared `environment.mcp` before the daemon adopts it.
 *
 * The daemon projects `AgentInstallation.config.environment` onto the OWNER's
 * machine: every declared stdio server is spawned as the operator, and every
 * declared http server is handed the seat token wherever the declaration puts
 * the `${COMMONLY_AGENT_TOKEN}` placeholder. The registry PATCH that writes
 * that declaration was pod-member gated (Vera, Connectors 69500, 2026-09-18),
 * so a plain member could run a command on the owner's laptop or ship the
 * token to a host they control. The server fix is owner/admin gating; this is
 * the daemon's own layer, which must hold even if the server is wrong again.
 *
 * Two rules, both fail-closed:
 *   stdio — the ENTRY must be the shipped commonly MCP server — command
 *           `npx -y @commonlyai/mcp@<tag>`, env limited to the two canonical
 *           placeholders, no args/cwd — or equal, as a whole entry, to one
 *           the operator already installed by hand in the local token record.
 *           Command alone is not enough: the shipped command with
 *           `NODE_OPTIONS=--import=data:…` executes code, with
 *           `npm_config_registry` fetches the package from an attacker, and
 *           with a literal `COMMONLY_API_URL=https://attacker…` posts the
 *           token there (sprint-review, Sharpen 69526/69534).
 *   http  — the ENTRY, `name` aside, must BE the one http server the instance
 *           ships: the grant broker (`grantBrokerServer`,
 *           backend/services/grantBrokerProjectionService.ts). `transport`
 *           exactly `http`; the url, with ONLY the two instance placeholders
 *           resolved and nothing else expanded, of our own origin at
 *           `/api/mcp/grants/<id>`, with no query, hash or userinfo; headers
 *           exactly the single Bearer token placeholder; and no other field.
 *           `sse` is not admitted at all: nothing ships it, and its GET is the
 *           method every 3xx route in this repo answers. Pinning the ORIGIN
 *           alone was not enough — a same-origin url whose path is a GET route
 *           that redirects (`/api/auth/oauth/*`, both Slack and Discord
 *           callbacks) passed the origin check and let the client leave the
 *           instance on the hop, and an added header would have travelled with
 *           it (TASK-150). Matched exactly rather than folded: the set this
 *           guard ADMITS has to equal the set that is TESTED for the absence of
 *           a redirect, and folding case or collapsing slashes widens what is
 *           admitted while narrowing what is withheld.
 * The rule is origin-based, not placeholder-based, because the claude CLI
 * expands `${VAR}` and `${VAR:-default}` in url and headers from its own
 * environment: `?t=${COMMONLY_AGENT_TOKEN:-}` is not the literal placeholder
 * and still becomes the token, and outside the public sandbox that
 * environment is the operator's, so `?k=${GITHUB_TOKEN}` leaks too (Vera,
 * Connectors 69519). So any `${` other than the three known placeholders,
 * anywhere in an entry — url, headers, command, env — is refused outright.
 *
 * The guarantee is instance-specific: a self-hosted proxy that redirects
 * `/api/mcp/grants/…` breaks it in a way no test in this repo can see.
 */

const URL_PLACEHOLDERS = ['${COMMONLY_API_URL}', '${COMMONLY_INSTANCE_URL}'];
const KNOWN_PLACEHOLDERS = [...URL_PLACEHOLDERS, '${COMMONLY_AGENT_TOKEN}'];
const SHIPPED_PACKAGE = /^@commonlyai\/mcp(@[A-Za-z0-9._-]+)?$/;

export const isShippedCommonlyMcpCommand = (command) => (
  Array.isArray(command)
  && command.length === 3
  && command[0] === 'npx'
  && command[1] === '-y'
  && typeof command[2] === 'string'
  && SHIPPED_PACKAGE.test(command[2])
);

const CANONICAL_STDIO_ENV = {
  COMMONLY_API_URL: '${COMMONLY_API_URL}',
  COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
};

// The execution-relevant shape of a stdio entry: everything that decides what
// runs and with what. `name` and `transport` are identity, not execution.
const executionShape = (server) => JSON.stringify({
  command: Array.isArray(server.command) ? server.command : null,
  args: Array.isArray(server.args) && server.args.length ? server.args : null,
  cwd: typeof server.cwd === 'string' ? server.cwd : null,
  env: server.env && typeof server.env === 'object'
    ? Object.fromEntries(Object.entries(server.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : null,
});

// The shipped server exactly: its command, only its own env keys at their
// canonical placeholder values, nothing else that changes what executes.
export const isShippedCommonlyMcpEntry = (server) => {
  if (!server || typeof server !== 'object') return false;
  if (!isShippedCommonlyMcpCommand(server.command)) return false;
  if (Array.isArray(server.args) && server.args.length) return false;
  if (server.cwd !== undefined) return false;
  const env = server.env && typeof server.env === 'object' ? server.env : {};
  return Object.entries(env).every(([key, value]) => CANONICAL_STDIO_ENV[key] === value);
};

// True when a string still contains `${` after the known placeholders are
// removed — a `${VAR}`, `${VAR:-default}` or any other expansion the CLI
// would resolve from an environment this declaration does not own.
// A field the guard cannot READ is not a field it can judge. `env` and
// `headers` are spread by every reader (`{ ...server.env }`), so a STRING there
// becomes single-character keys and the declaration is silently dropped rather
// than honoured — the next consumer that parses the string instead would honour
// it, and this guard would have admitted the entry on the strength of its other
// fields (TASK-069: judge the whole entry, not selected fields). `args` is read
// only through `Array.isArray`, and `cwd` through `typeof === 'string'` in
// `executionShape`, so a value of the wrong type there is dropped the same way —
// and for `cwd` that drop is load-bearing: the normalised shape then equals an
// installed entry that declares NO cwd, so the entry is admitted as one the
// operator already installed (Vera, hold on #1915).
// Fail closed: an unreadable shape is a refusal, never an absence.
// The one http entry the server ships: url and headers as `grantBrokerServer`
// writes them (`GRANT_BROKER_URL` / `GRANT_BROKER_AUTHORIZATION`).
const GRANT_BROKER_PATH = /^\/api\/mcp\/grants\/[A-Za-z0-9_-]+$/;
const GRANT_BROKER_AUTHORIZATION = 'Bearer ${COMMONLY_AGENT_TOKEN}';

const sameOriginAsInstance = (url, instanceUrl) => {
  const origin = originOf(url, instanceUrl);
  if (!origin) return false;
  try {
    return origin === new URL(instanceUrl).origin;
  } catch {
    return false;
  }
};

// The url is judged by what a client would carry, not by the substring the
// origin check happens to read: the path has to be the grants path with ONE id
// segment, and a query, a hash or userinfo is a field the origin comparison
// does not look at but the request does carry.
const grantBrokerUrl = (url, instanceUrl) => {
  if (!sameOriginAsInstance(url, instanceUrl)) return false;
  let expanded = String(url);
  for (const placeholder of URL_PLACEHOLDERS) expanded = expanded.split(placeholder).join(instanceUrl);
  let parsed;
  try {
    parsed = new URL(expanded);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  return GRANT_BROKER_PATH.test(parsed.pathname);
};

/**
 * The shipped grant broker, matched as a WHOLE entry (the http twin of
 * `isShippedCommonlyMcpEntry`): `name` is identity — the projection suffixes it
 * when one seat holds several grants — and every other field has to equal what
 * `grantBrokerServer` writes, with no field added, because a field the client
 * reads and this guard does not is exactly the shape the whole-entry rule
 * exists to refuse (TASK-069).
 */
export const isShippedGrantBrokerEntry = (server, instanceUrl) => {
  if (!server || typeof server !== 'object') return false;
  if (server.transport !== 'http') return false;
  const keys = Object.keys(server).filter((key) => key !== 'name').sort();
  if (keys.join(',') !== 'headers,transport,url') return false;
  const headers = server.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false;
  const headerKeys = Object.keys(headers);
  if (headerKeys.length !== 1 || headerKeys[0] !== 'Authorization') return false;
  if (headers.Authorization !== GRANT_BROKER_AUTHORIZATION) return false;
  return grantBrokerUrl(server.url, instanceUrl);
};

const unreadableField = (server) => {
  for (const key of ['env', 'headers']) {
    const value = server[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) {
      return `${key} is of type ${typeof value}, not an object`;
    }
    const badValue = Object.entries(value).find(([, v]) => typeof v !== 'string');
    if (badValue) return `${key}.${badValue[0]} is not a string`;
  }
  if (server.cwd !== undefined && server.cwd !== null && typeof server.cwd !== 'string') {
    return `cwd is of type ${typeof server.cwd}, not a string`;
  }
  if (server.args === undefined || server.args === null) return null;
  if (!Array.isArray(server.args)) return `args is of type ${typeof server.args}, not an array`;
  if (server.args.some((a) => typeof a !== 'string')) return 'args carries a non-string';
  return null;
};

const hasForeignExpansion = (value) => {
  if (typeof value !== 'string') return false;
  let rest = value;
  for (const placeholder of KNOWN_PLACEHOLDERS) rest = rest.split(placeholder).join('');
  return rest.includes('${');
};

const stringsOf = (server) => {
  const out = [];
  if (typeof server.url === 'string') out.push(server.url);
  for (const bag of [server.headers, server.env]) {
    if (bag && typeof bag === 'object') out.push(...Object.values(bag));
  }
  if (Array.isArray(server.command)) out.push(...server.command);
  if (Array.isArray(server.args)) out.push(...server.args);
  return out.filter((v) => typeof v === 'string');
};

const originOf = (url, instanceUrl) => {
  let expanded = String(url);
  for (const placeholder of URL_PLACEHOLDERS) expanded = expanded.split(placeholder).join(instanceUrl);
  try {
    return new URL(expanded).origin;
  } catch {
    return null;
  }
};

/**
 * @returns {{ ok: boolean, refusals: string[] }} — one refusal line per
 * offending server, naming it, so the daemon log says exactly what was kept
 * off the machine.
 */
export const auditDeclaredMcp = (environment, { instanceUrl, allowedStdioEntries = [] } = {}) => {
  const refusals = [];
  const servers = environment && typeof environment === 'object' && Array.isArray(environment.mcp)
    ? environment.mcp : [];
  let instanceOrigin = null;
  try {
    instanceOrigin = new URL(instanceUrl).origin;
  } catch {
    instanceOrigin = null;
  }

  servers.forEach((server, index) => {
    if (!server || typeof server !== 'object') {
      refusals.push(`mcp[${index}] is not an object`);
      return;
    }
    const name = typeof server.name === 'string' && server.name ? server.name : `mcp[${index}]`;
    const transport = server.transport || 'stdio';
    const unreadable = unreadableField(server);
    if (unreadable) {
      refusals.push(`'${name}': declares ${unreadable}, so this guard cannot judge what the entry would run; refusing it rather than reading the field as absent`);
      return;
    }
    // One shape per entry. The adapters classified by which field was present,
    // so `{transport:'http', url:<instance>, command:['sh','-c',…]}` passed an
    // origin check here and ran as stdio there with the token substituted
    // (#1764 fixes the adapters; the guard refuses the shape outright).
    if (server.command !== undefined && server.url !== undefined) {
      refusals.push(`'${name}': declares both a command and a url; one entry is one transport`);
      return;
    }
    if (transport === 'stdio' && server.url !== undefined) {
      refusals.push(`'${name}': stdio entry carries a url`);
      return;
    }
    if ((transport === 'http' || transport === 'sse') && server.command !== undefined) {
      refusals.push(`'${name}': ${transport} entry carries a command`);
      return;
    }
    const foreign = stringsOf(server).find(hasForeignExpansion);
    if (foreign !== undefined) {
      refusals.push(`'${name}': ${JSON.stringify(foreign)} contains an expansion other than the instance placeholders; the CLI would resolve it from this machine's environment`);
      return;
    }
    if (transport === 'stdio') {
      if (isShippedCommonlyMcpEntry(server)) return;
      const shape = executionShape(server);
      if (allowedStdioEntries.some((allowed) => executionShape(allowed) === shape)) return;
      const why = isShippedCommonlyMcpCommand(server.command)
        ? `carries env/args/cwd beyond the shipped server's own (${Object.keys(server.env || {}).filter((k) => CANONICAL_STDIO_ENV[k] !== server.env[k]).join(', ') || 'args/cwd'})`
        : `command ${JSON.stringify(server.command)} is not the shipped commonly MCP server`;
      refusals.push(`'${name}': declared stdio entry ${why}, and no entry installed on this machine matches it as a whole`);
      return;
    }
    if (transport === 'http' || transport === 'sse') {
      if (transport === 'http' && isShippedGrantBrokerEntry(server, instanceUrl)) return;
      refusals.push(`'${name}': declared ${transport} entry ${JSON.stringify(server.url)} is not the one http server this instance ships; a declaration is admitted only as the grant broker (transport 'http', url ${instanceOrigin || instanceUrl}/api/mcp/grants/<id> with no query or fragment, headers exactly {'Authorization': 'Bearer \${COMMONLY_AGENT_TOKEN}'}, and no other field), and 'sse' is not admitted at all`);
      return;
    }
    refusals.push(`'${name}': unknown transport ${JSON.stringify(transport)}`);
  });

  return { ok: refusals.length === 0, refusals };
};

/** The stdio entries an operator has already placed in a local token record. */
export const installedStdioEntries = (record) => (
  Array.isArray(record?.environment?.mcp)
    ? record.environment.mcp
      .filter((s) => s && typeof s === 'object' && (s.transport || 'stdio') === 'stdio' && Array.isArray(s.command))
    : []
);
