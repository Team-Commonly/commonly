/**
 * Guard for a server-declared `environment.mcp` before the daemon adopts it.
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
 *   http  — the url, with ONLY the two instance placeholders resolved and
 *           nothing else expanded, must parse to the instance's own origin
 *           (scheme + host + port). The grant broker declares
 *           `${COMMONLY_API_URL}/api/mcp/grants/…`, so it passes.
 * The rule is origin-based, not placeholder-based, because the claude CLI
 * expands `${VAR}` and `${VAR:-default}` in url and headers from its own
 * environment: `?t=${COMMONLY_AGENT_TOKEN:-}` is not the literal placeholder
 * and still becomes the token, and outside the public sandbox that
 * environment is the operator's, so `?k=${GITHUB_TOKEN}` leaks too (Vera,
 * Connectors 69519). So any `${` other than the three known placeholders,
 * anywhere in an entry — url, headers, command, env — is refused outright.
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
      const origin = originOf(server.url, instanceUrl);
      if (origin && instanceOrigin && origin === instanceOrigin) return;
      refusals.push(`'${name}': ${transport} server ${JSON.stringify(server.url)} resolves to origin ${origin || '(unparseable)'}, not this instance (${instanceOrigin || instanceUrl}); a declared http server may only be the instance itself`);
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
