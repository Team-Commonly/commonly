/**
 * The `acp` adapter: any agent that speaks the Agent Client Protocol over its
 * stdio becomes a Commonly seat. Private seats only for now; a public seat is
 * refused before anything spawns.
 *
 * The seat names the agent's argv in `environment.acp.command` (an array, the
 * first entry absolute or a bare name on PATH, never through a shell). One turn
 * is one process: initialize, session/new, session/prompt, then the child is
 * killed and the per-turn credential directory removed.
 *
 * Protocol facts this file relies on, verified 2026-11-26 against:
 *   https://agentclientprotocol.com/protocol/initialization
 *     initialize { protocolVersion: 1, clientCapabilities, clientInfo }; the
 *     agent answers with the version it will speak, and the client SHOULD
 *     disconnect when it doesn't support that version.
 *   https://agentclientprotocol.com/protocol/session-setup
 *     session/new { cwd, mcpServers }: cwd MUST be absolute. Every agent MUST
 *     support stdio MCP servers, given as { name, command, args, env } where
 *     command is an absolute path and env a list of { name, value }. HTTP and
 *     SSE entries are allowed only when the agent's mcpCapabilities.http / .sse
 *     say so; this adapter sends stdio entries only. session/new "may fail with
 *     an auth_required error" until the client authenticates (-32000).
 *   https://agentclientprotocol.com/protocol/prompt-turn
 *     session/prompt { sessionId, prompt: ContentBlock[] } (text blocks are a
 *     baseline every agent supports). Output streams as session/update
 *     notifications { sessionId, update: { sessionUpdate, ... } }; the reply is
 *     the text content of `agent_message_chunk` updates, and
 *     agent_thought_chunk, tool_call, tool_call_update, plan and the rest are
 *     not the reply. The prompt result's stopReason is one of end_turn,
 *     max_tokens, max_turn_requests, refusal, cancelled. Cancellation is the
 *     session/cancel notification { sessionId }; the client MUST answer every
 *     pending session/request_permission with outcome `cancelled`, and the
 *     agent MUST end the prompt with stopReason `cancelled`.
 *   https://agentclientprotocol.com/protocol/tool-calls#requesting-permission
 *     session/request_permission { sessionId, toolCall, options[] }, each option
 *     { optionId, name, kind: allow_once | allow_always | reject_once |
 *     reject_always }; the answer is { outcome: { outcome: 'selected',
 *     optionId } } or { outcome: { outcome: 'cancelled' } }.
 *   https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.json
 *     McpServerStdio, EnvVariable, StopReason, SessionUpdate and
 *     RequestPermissionOutcome as above.
 *
 * The runtime token never rides argv, the session/new params, the agent's
 * environment or a log line: the Commonly MCP entry names a per-turn 0600
 * credential FILE, the same channel the other adapters use.
 */
import { spawn as childSpawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ACP_ERROR, ACP_PROTOCOL_VERSION, createAcpConnection } from '../acp/client.js';
import { buildMemoryPreamble } from '../memory-bridge.js';
import { effectiveSandboxTrust, refuseWorkspaceTrust, validateEnvironmentSpec } from '../environment.js';
import { writeCredentialFile } from '../credential-file.js';
import { deliverSeatCredential, withholdRuntimeCredential } from '../mcp-credential-delivery.js';
import { prepareMcpSpawn } from '../mcp-home.js';
import { resolveOnPath } from '../resolve-on-path.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// After session/cancel the agent is owed a moment to end the prompt itself.
const CANCEL_GRACE_MS = 5000;
const KILL_GRACE_MS = 3000;
// How long to wait for the exit code once stdout has closed, so an early exit
// reports its code rather than a bare "connection closed".
const EXIT_WAIT_MS = 1000;
const STDERR_TAIL_CHARS = 8192;
const MAX_ARGV = 64;
const CLIENT_INFO = Object.freeze({ name: 'commonly-cli', title: 'Commonly', version: '1' });
const CLIENT_CAPABILITIES = Object.freeze({
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: false },
});
const ACP_KEYS = new Set(['command', 'passEnv']);
// The same allowlist the goose, dsh and pi adapters start from. HOME is added
// for a private seat: an ACP agent signs in through its own login, which lives
// in the operator's home.
const SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MCP_ENV_ALLOWED = new Set(['COMMONLY_TOKEN_FILE', 'COMMONLY_API_URL', 'COMMONLY_INSTANCE_URL']);
const PLACEHOLDER_RE = /\$\{(COMMONLY_[A-Z_]+)\}/g;
const LOG_CHARS = 64;

// An agent-controlled value on its way into an error or a log: short and
// printable, so it cannot inject lines.
const clamp = (value) => String(value).slice(0, LOG_CHARS).replace(/[^\x20-\x7e]/g, '?');

// Seats already told that their model setting is unused, so a daemon running
// many turns says it once per seat.
const warnedModel = new Set();

const isPublicSeat = (environment) => effectiveSandboxTrust(environment?.sandbox?.trust) === 'public';

/** The seat's `acp` block, checked. Throws a message naming the bad field. */
export const validateAcpSpec = (spec) => {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('acp adapter: environment.acp.command must be a non-empty array of strings (the agent\'s argv)');
  }
  for (const key of Object.keys(spec)) {
    if (!ACP_KEYS.has(key)) throw new Error(`acp adapter: unknown acp key ${JSON.stringify(clamp(key))} (allowed: ${[...ACP_KEYS].join(', ')})`);
  }
  const { command, passEnv } = spec;
  if (!Array.isArray(command) || command.length === 0 || command.length > MAX_ARGV) {
    throw new Error('acp adapter: environment.acp.command must be a non-empty array of strings (the agent\'s argv)');
  }
  // Each entry goes to execve as one argument, with no shell in between, so
  // quoting and metacharacters mean nothing; a NUL would be cut by the OS.
  if (!command.every((part) => typeof part === 'string' && part.length > 0 && !part.includes('\0'))) {
    throw new Error('acp adapter: environment.acp.command entries must be non-empty strings without NUL');
  }
  const [program] = command;
  if (!isAbsolute(program) && /[\\/]/.test(program)) {
    throw new Error('acp adapter: environment.acp.command[0] must be an absolute path or a bare name on PATH');
  }
  if (passEnv !== undefined) {
    if (!Array.isArray(passEnv) || !passEnv.every((name) => typeof name === 'string' && ENV_NAME.test(name))) {
      throw new Error('acp adapter: environment.acp.passEnv must be a list of environment variable names');
    }
    if (passEnv.some((name) => name.startsWith('COMMONLY_'))) {
      throw new Error('acp adapter: environment.acp.passEnv cannot carry COMMONLY_ variables; the seat credential arrives by file');
    }
  }
  return { command: [...command], passEnv: passEnv ? [...passEnv] : [] };
};

const resolveProgram = (program, pathValue) => (isAbsolute(program) ? program : resolveOnPath(program, pathValue));

const substitute = (value, ctx) => String(value).replace(PLACEHOLDER_RE, (whole, name) => ({
  COMMONLY_TOKEN_FILE: ctx.credentialFile,
  COMMONLY_API_URL: ctx.instanceUrl,
  COMMONLY_INSTANCE_URL: ctx.instanceUrl,
}[name] || whole));

/**
 * The seat's declared MCP servers as ACP stdio entries. Each credential is
 * delivered as the PATH of this turn's file; an entry that could only receive
 * the token itself is refused rather than sent, since the session/new params
 * are visible to the agent and anything it logs.
 */
export const buildAcpMcpServers = (servers, ctx) => {
  const entries = [];
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!/^[A-Za-z0-9_-]{2,}$/.test(server?.name || '')) {
      throw new Error('acp adapter: an MCP server needs a safe name');
    }
    if ((server.transport || 'stdio') !== 'stdio') {
      throw new Error(`acp adapter: MCP server ${server.name} is not stdio; HTTP MCP servers are not supported yet`);
    }
    if (!Array.isArray(server.command) || !server.command.length) {
      throw new Error(`acp adapter: MCP server ${server.name} has no command`);
    }
    const command = prepareMcpSpawn(server.command, { apiUrl: ctx.instanceUrl, publicSeat: false });
    const delivery = deliverSeatCredential({ ...server, command }, {
      credentialFile: ctx.credentialFile,
      label: 'acp',
      onWarn: ctx.warn,
    });
    if (delivery.delivered === 'env' || delivery.delivered === 'unavailable') {
      throw new Error(`acp adapter: MCP server ${server.name} cannot receive its credential by file`);
    }
    const env = Object.entries(delivery.env).map(([name, value]) => {
      if (!ENV_NAME.test(name) || !MCP_ENV_ALLOWED.has(name)) {
        throw new Error(`acp adapter: MCP server ${server.name} declares ${clamp(name)}, which this adapter does not pass`);
      }
      return { name, value: substitute(value, ctx) };
    });
    // ACP wants an absolute executable; `node` and `npx` come off PATH.
    const executable = resolveProgram(command[0], ctx.pathValue)
      || (command[0] === 'node' ? process.execPath : null);
    if (!executable) throw new Error(`acp adapter: MCP server ${server.name}: ${clamp(command[0])} is not on PATH`);
    const entry = {
      name: server.name,
      command: executable,
      args: command.slice(1).map((part) => substitute(part, ctx)),
      env,
    };
    const serialized = JSON.stringify(entry);
    if (serialized.includes('${COMMONLY_AGENT_TOKEN}') || (ctx.runtimeToken && serialized.includes(ctx.runtimeToken))) {
      throw new Error(`acp adapter: MCP server ${server.name} would expose the runtime token`);
    }
    entries.push(entry);
  }
  return entries;
};

/** For now every tool permission is refused, with the agent's own reject option; a seat policy comes later. */
export const rejectPermission = (params) => {
  const options = Array.isArray(params?.options) ? params.options : [];
  const reject = options.find((option) => option?.kind === 'reject_once')
    || options.find((option) => option?.kind === 'reject_always');
  return reject && (typeof reject.optionId === 'string' || typeof reject.optionId === 'number')
    ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
    // Not quite a cancel, but the only answer left without a reject option;
    // the seat permission policy that comes later replaces this fallback.
    : { outcome: { outcome: 'cancelled' } };
};

const CANCELLED_OUTCOME = Object.freeze({ outcome: { outcome: 'cancelled' } });

const timeoutError = (timeoutMs) => new Error(`acp adapter: timed out after ${timeoutMs}ms`);

/**
 * Run one turn over an already spawned child. Resolves with the reply text or
 * rejects; the caller kills the child either way.
 */
const runTurn = async ({
  child, cwd, mcpServers, promptText, timeoutMs, cancelGraceMs, log, warn, credentials, permissionPolicy,
}) => {
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS); });
  let exitInfo = null;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; resolve(exitInfo); });
  });
  let spawnError = null;

  let sessionId = null;
  let promptActive = false;
  let cancelling = false;
  const chunks = [];
  const openPermissions = new Set(); // resolvers of permission answers still owed

  const onNotification = (method, params) => {
    if (method !== 'session/update' || !promptActive) return;
    if (params?.sessionId !== sessionId) return;
    const update = params?.update;
    if (update?.sessionUpdate !== 'agent_message_chunk') return;
    if (update.content?.type === 'text' && typeof update.content.text === 'string') chunks.push(update.content.text);
  };

  const onRequest = async (method, params) => {
    if (method === 'session/request_permission') {
      if (cancelling) return CANCELLED_OUTCOME;
      return new Promise((resolve) => {
        const settle = (answer) => {
          if (!openPermissions.delete(settle)) return;
          resolve(answer);
        };
        openPermissions.add(settle);
        Promise.resolve()
          .then(() => permissionPolicy(params))
          .then((answer) => settle(answer || CANCELLED_OUTCOME), () => settle(CANCELLED_OUTCOME));
      });
    }
    // fs/* and terminal/* were advertised as off; anything else is unknown.
    throw Object.assign(new Error('Method not found'), { code: ACP_ERROR.METHOD_NOT_FOUND });
  };

  const conn = createAcpConnection({
    stdin: child.stdin, stdout: child.stdout, onNotification, onRequest, log,
  });
  child.once('error', (err) => {
    spawnError = err;
    conn.close(`agent process error: ${err.code || err.name}`);
  });
  exited.then(({ code, signal }) => conn.close(`agent exited (code ${code}, signal ${signal})`));

  // Turns a closed connection into the reason the agent went away.
  const explainClosed = async (err) => {
    if (err?.code !== 'ACP_CLOSED') return err;
    if (spawnError) return new Error(`acp adapter: the agent could not start (${spawnError.code || spawnError.name})`);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS).unref?.())]);
    return adapterFailure('acp', stderr.trim() || 'the agent closed its connection mid-turn', {
      credentials, exitCode: exitInfo ? exitInfo.code : null, limit: 500,
      ...(exitInfo?.signal ? { signal: exitInfo.signal } : {}),
    });
  };

  let deadlineTimer;
  let graceTimer;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      cancelling = true;
      if (!sessionId || !promptActive) { reject(timeoutError(timeoutMs)); return; }
      log('acp: turn deadline reached; sending session/cancel');
      conn.notify('session/cancel', { sessionId });
      for (const settle of [...openPermissions]) settle(CANCELLED_OUTCOME);
      graceTimer = setTimeout(() => reject(timeoutError(timeoutMs)), cancelGraceMs);
    }, timeoutMs);
  });
  deadline.catch(() => {});

  const turn = (async () => {
    const init = await conn.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    });
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(`acp adapter: the agent speaks ACP protocol version ${clamp(init?.protocolVersion)}; this connector speaks ${ACP_PROTOCOL_VERSION}`);
    }
    let session;
    try {
      session = await conn.request('session/new', { cwd, mcpServers });
    } catch (err) {
      if (err?.code === ACP_ERROR.AUTH_REQUIRED) {
        const methods = (Array.isArray(init.authMethods) ? init.authMethods : [])
          .map((method) => clamp(method?.id ?? '')).filter(Boolean);
        throw new Error(`acp adapter: the agent requires authentication${methods.length ? ` (methods: ${methods.join(', ')})` : ''}; sign it in on this computer first`);
      }
      throw err;
    }
    if (typeof session?.sessionId !== 'string' || !session.sessionId) {
      throw new Error('acp adapter: session/new returned no sessionId');
    }
    sessionId = session.sessionId;
    promptActive = true;
    const result = await conn.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: promptText }],
    });
    promptActive = false;
    const stopReason = result?.stopReason;
    const text = chunks.join('');
    if (stopReason === 'end_turn') return text;
    if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      warn(`[acp] the turn stopped at ${stopReason}; the reply may be cut short`);
      return text;
    }
    if (stopReason === 'cancelled') {
      if (cancelling) throw timeoutError(timeoutMs);
      throw new Error('acp adapter: the agent cancelled the turn (stopReason cancelled)');
    }
    if (stopReason === 'refusal') throw new Error('acp adapter: the agent refused the turn (stopReason refusal)');
    throw new Error(`acp adapter: the agent ended the turn with an unknown stopReason ${clamp(stopReason)}`);
  })();

  try {
    return await Promise.race([turn, deadline]);
  } catch (err) {
    if (cancelling && err?.code === 'ACP_CLOSED') throw timeoutError(timeoutMs);
    // A JSON-RPC error from the agent carries text the agent chose, which can
    // echo a key it was given; it goes through the same scrub as stderr.
    if (Number.isInteger(err?.code)) {
      throw adapterFailure('acp', String(err.message || 'the agent returned an error'), { credentials, limit: 500 });
    }
    throw await explainClosed(err);
  } finally {
    turn.catch(() => {});
    clearTimeout(deadlineTimer);
    clearTimeout(graceTimer);
    for (const settle of [...openPermissions]) settle(CANCELLED_OUTCOME);
    conn.close('turn finished');
  }
};

/** SIGTERM, then SIGKILL after a grace period; resolves once the child is gone. */
const killChild = async (child, graceMs) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (typeof child.pid !== 'number') return; // never started
  const gone = new Promise((resolve) => child.once('exit', resolve));
  try { child.stdin?.end(); } catch { /* already closed */ }
  child.kill('SIGTERM');
  let timer;
  const forced = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, graceMs);
  });
  await Promise.race([gone, forced]);
  clearTimeout(timer);
  // A process stuck in the kernel can outlive SIGKILL for a while; the turn
  // and its cleanup must not wait on it forever.
  let bound;
  await Promise.race([gone, new Promise((resolve) => { bound = setTimeout(resolve, graceMs); })]);
  clearTimeout(bound);
};

export default {
  name: 'acp',
  // No stable ACP call sets the agent's model yet, so a missing model must not
  // refuse the turn; a declared one is reported as unused instead.
  requiresModel: false,
  providerKeyEnv: null,
  supportsProvider: false,

  async validateEnvironment(environment, _workspacePath) {
    const env = environment || {};
    if (isPublicSeat(env)) throw new Error('acp adapter: public seats are not supported yet');
    refuseWorkspaceTrust(env.sandbox, 'acp');
    if (env.sandbox?.mode && env.sandbox.mode !== 'none') {
      throw new Error(`acp adapter: sandbox.mode=${clamp(env.sandbox.mode)} cannot be enforced for an ACP agent yet`);
    }
    const validation = validateEnvironmentSpec(env);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    return validateAcpSpec(env.acp);
  },

  async detect(environment) {
    if (!environment?.acp) return null;
    let spec;
    try { spec = validateAcpSpec(environment.acp); } catch { return null; }
    const path = resolveProgram(spec.command[0], process.env.PATH);
    return path ? { path, version: 'unknown' } : null;
  },

  async spawn(prompt, ctx = {}) {
    if (isPublicSeat(ctx.environment)) throw new Error('acp adapter: public seats are not supported yet');
    const spec = await this.validateEnvironment(ctx.environment, ctx.cwd);
    if (typeof ctx.cwd !== 'string' || !isAbsolute(ctx.cwd)) {
      throw new Error('acp adapter: the seat workspace must be an absolute path');
    }
    const sourceEnv = ctx.env || process.env;
    const program = resolveProgram(spec.command[0], sourceEnv.PATH);
    if (!program) throw new Error(`acp adapter: ${clamp(spec.command[0])} is not on PATH`);
    const requestedTimeout = Number(ctx.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    // eslint-disable-next-line no-console
    const warn = (text) => console.warn(text);
    const log = typeof ctx._log === 'function' ? ctx._log : () => {};
    const credentials = spawnCredentials(ctx, spec.passEnv);
    const model = ctx.environment?.model;
    const modelKey = `${ctx.instanceUrl || ''}\0${ctx.agentName || ''}`;
    if (typeof model === 'string' && model.trim() && !warnedModel.has(modelKey)) {
      warnedModel.add(modelKey);
      warn('[acp] environment.model is set, but the acp adapter does not pass it to the agent yet; the agent uses its own model setting');
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'commonly-acp-'));
    let child = null;
    let reply = null;
    let cleanupFailure = null;
    try {
      const credential = writeCredentialFile(ctx.runtimeToken, { root: tempDir, agentName: ctx.agentName || 'agent' });
      const mcpServers = buildAcpMcpServers(ctx.environment?.mcp, {
        credentialFile: credential?.path || '',
        instanceUrl: ctx.instanceUrl || '',
        runtimeToken: ctx.runtimeToken || '',
        pathValue: sourceEnv.PATH,
        warn,
      });
      const env = Object.fromEntries(Object.entries(sourceEnv).filter(([name]) => SAFE_ENV.test(name)));
      if (sourceEnv.HOME) env.HOME = sourceEnv.HOME;
      for (const name of spec.passEnv) if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name];
      withholdRuntimeCredential(env, { credentialFile: credential?.path || null });
      log(`acp: starting agent ${clamp(program)} (${spec.command.length - 1} args)`);
      child = (ctx._spawnImpl || childSpawn)(program, spec.command.slice(1), {
        cwd: ctx.cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const text = await runTurn({
        child,
        cwd: ctx.cwd,
        mcpServers,
        promptText: buildMemoryPreamble(prompt, ctx.memoryLongTerm, { freshSession: true }),
        timeoutMs,
        cancelGraceMs: Number(ctx._cancelGraceMs) > 0 ? Number(ctx._cancelGraceMs) : CANCEL_GRACE_MS,
        log,
        warn,
        credentials,
        permissionPolicy: typeof ctx._permissionPolicy === 'function' ? ctx._permissionPolicy : rejectPermission,
      });
      log(`acp: turn ended with a ${text.length}-char reply`);
      reply = { text, newSessionId: null };
    } finally {
      try {
        await killChild(child, Number(ctx._killGraceMs) > 0 ? Number(ctx._killGraceMs) : KILL_GRACE_MS);
      } finally {
        try {
          await rm(tempDir, { recursive: true, force: true });
        } catch (err) {
          cleanupFailure = err;
        }
      }
    }
    // Reached only when the turn worked: the rm is the one delete of the
    // credential, so the turn must not report success over its failure.
    if (cleanupFailure) throw cleanupFailure;
    return reply;
  },
};
