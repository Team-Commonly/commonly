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
 *   stdio — the command must be the shipped commonly MCP server
 *           (`npx -y @commonlyai/mcp@<tag>`) or a command the operator
 *           already installed by hand in the local token record.
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

const sameCommand = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((part, i) => part === b[i]);

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
export const auditDeclaredMcp = (environment, { instanceUrl, allowedStdioCommands = [] } = {}) => {
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
    const foreign = stringsOf(server).find(hasForeignExpansion);
    if (foreign !== undefined) {
      refusals.push(`'${name}': ${JSON.stringify(foreign)} contains an expansion other than the instance placeholders; the CLI would resolve it from this machine's environment`);
      return;
    }
    if (transport === 'stdio') {
      if (isShippedCommonlyMcpCommand(server.command)) return;
      if (allowedStdioCommands.some((allowed) => sameCommand(allowed, server.command))) return;
      refusals.push(`'${name}': declared stdio command ${JSON.stringify(server.command)} is neither the shipped commonly MCP server nor a command installed on this machine`);
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

/** The stdio commands an operator has already placed in a local token record. */
export const installedStdioCommands = (record) => (
  Array.isArray(record?.environment?.mcp)
    ? record.environment.mcp
      .filter((s) => s && typeof s === 'object' && (s.transport || 'stdio') === 'stdio' && Array.isArray(s.command))
      .map((s) => s.command)
    : []
);
