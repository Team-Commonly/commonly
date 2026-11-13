import { observeSpawn } from '../runtime-observation.js';
/**
 * DeepSeek Harness 0.2.1-rc.2. Configuration is per spawn.
 *
 * A public seat (F115) runs the confined shape below with dsh's own tools off,
 * a guard plugin that refuses any call but a Commonly tool it may use, and the
 * Commonly MCP gated on that guard; see DSH_PUBLIC_DISABLED_PLUGINS.
 *
 * A seat runs plain, or confined: `sandbox: { mode: 'workspace', network:
 * { policy: 'restricted' } }` runs dsh inside one Seatbelt profile that writes
 * only the workspace and the seat's home, reaches only three loopback ports
 * (the provider proxy, the Commonly instance relay and the GitHub egress
 * proxy), and cannot reach the Security services the keychain sits behind.
 * The provider proxy is pinned to the seat's model and checks the model each
 * response names. dsh's own sandbox is turned off inside it, because a second
 * Seatbelt cannot be applied under the first.
 */
import { spawnInOwnGroup, wantsOwnProcessGroup } from '@commonlyai/seats/process-group';
import { requireSeatModel } from './seat-model.js';
import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, realpathSync } from 'fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, delimiter, isAbsolute, join, sep } from 'path';
import { startEgressProxy } from '../egress-proxy.js';
import { startInstanceProxy } from '../instance-proxy.js';
import { prepareMcpSpawn, selectedMcpVersionDir } from '../mcp-home.js';
import { detectSeatbelt, wrapArgvWithSeatbelt } from '../sandbox/seatbelt.js';
import { refuseWorkspaceHoldingTurnDirs } from '../sandbox/turn-dir.js';
import { buildMemoryPreamble } from '../memory-bridge.js';
import { commonlyMcpServer } from '../default-environment.js';
import { effectiveSandboxTrust, refuseWorkspaceTrust, validateEnvironmentSpec } from '../environment.js';
import { deliverSeatCredential } from '../mcp-credential-delivery.js';
import { describeMcpCommand } from '../mcp-server-version.js';
import { writeCredentialFile } from '../credential-file.js';
import { resolveProviderKeyFile, startProviderProxy } from '../provider-proxy.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';
import { promptTokens } from '../session-recycle.js';
import { publicSeatWithheldTools } from '../public-withheld-tools.js';
import { PUBLIC_SEAT_MCP_ENV } from '../public-seat-mcp-flag.js';

/**
 * F115: what a public seat's turn turns off. These are every headless-profile
 * plugin that gives the model a tool of its own (shell, files, web, code,
 * subagents, skills, jobs, workflows, goals, plan mode) or reads the working
 * directory into the prompt. The guard plugin refuses anything that is still
 * offered, so this list keeps the advertised set honest rather than being the
 * only fence.
 */
export const DSH_PUBLIC_DISABLED_PLUGINS = Object.freeze([
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-working-directory',
  'tool-skill', 'skill', 'skill-filesystem',
  'tool-subagent', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent-fork',
  'subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process',
  'tool-workflow', 'workflow-ptc', 'ptc-runtime', 'tool-todo', 'tool-goal',
  'tool-web', 'web', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http',
  'mcp-resources', 'agent-instructions', 'plan-mode', 'goal', 'goal-round-driver', 'command-goal',
]);
/** The service dsh-public-guard.mjs provides; the Commonly MCP entry is gated on it. */
export const DSH_PUBLIC_GUARD_SERVICE = 'commonlyPublicGuard';
/** A public turn's working directory, emptied before each turn, under the seat home. */
export const PUBLIC_TURN_DIR = 'public-turn';
const PUBLIC_GUARD_SOURCE = new URL('./dsh-public-guard.mjs', import.meta.url);
// @commonlyai/mcp's WITHHELD_TOOLS_ENV (commonly-mcp/src/server.js); a test holds the two equal.
export const WITHHELD_TOOLS_MCP_ENV = 'COMMONLY_MCP_WITHHELD_TOOLS';
// The one thing a public seat's home keeps between turns (a symlink is not kept).
const PUBLIC_HOME_KEPT = 'sessions';

export const TESTED_DSH_VERSIONS = Object.freeze(['0.2.1-rc.2']);
const PROXY_KEY_ENV = 'COMMONLY_DSH_PROXY_KEY';
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR)$/;

/** True for the one confined shape this adapter enforces; throws on any other sandbox. */
export const isConfinedDsh = (environment = {}) => {
  const sandbox = environment?.sandbox || {};
  refuseWorkspaceTrust(sandbox, 'dsh');
  // F115: public trust always runs the confined shape, with the public tool fence.
  const isPublic = effectiveSandboxTrust(sandbox.trust) === 'public';
  const { trust: _trust, ...publicShape } = sandbox;
  const shape = isPublic ? publicShape : sandbox;
  if (isPublic && Object.keys(shape).length === 0) return true;
  // Only a private seat may run plain; a public one with any other key is refused below.
  if (!isPublic && shape.mode === undefined) return false;
  const { mode, network, ...rest } = shape;
  const networkKeys = Object.keys(network || {});
  if (mode === 'workspace' && network?.policy === 'restricted'
    && networkKeys.length === 1 && Object.keys(rest).length === 0) return true;
  throw new Error(`dsh adapter: sandbox.mode=${mode} cannot be enforced by this adapter; `
    + "the one confined shape is { mode: 'workspace', network: { policy: 'restricted' } }");
};

/** True for a public-trust seat (legacy `internal` included). */
export const isPublicDsh = (environment = {}) => effectiveSandboxTrust(environment?.sandbox?.trust) === 'public';

/** Throws on any sandbox this adapter cannot enforce. */
export const assertEnforceableDsh = (environment = {}) => { isConfinedDsh(environment); };

/**
 * The macOS developer tools a confined writer needs for git, granted read-only.
 * /usr/bin/git is an xcrun shim: inside the sandbox it cannot read the tools it
 * forwards to, so `git` fails with "No developer tools were found" and a writer
 * cannot commit. Returns null when no tools are installed; the seat then
 * runs without git rather than failing.
 *
 * DEVELOPER_DIR and xcode-select are both settable by whoever starts the seat,
 * so the resolved path is granted only when it is one of the two places Apple
 * installs developer tools. Anything else (/, a home directory) returns null
 * rather than widening what the sandbox can read.
 */
const DEVELOPER_DIR_SHAPES = [
  /^\/Library\/Developer\/CommandLineTools$/,
  /^\/Applications\/[^/]+\.app\/Contents\/Developer$/,
];

export const developerToolsDir = ({
  env = process.env, run = spawnSync, exists = existsSync, realpath = realpathSync,
} = {}) => {
  const declared = env?.DEVELOPER_DIR;
  const dir = declared || String(run('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' })?.stdout || '').trim();
  if (!dir || !isAbsolute(dir) || !exists(dir)) return null;
  const resolved = realpath(dir);
  return DEVELOPER_DIR_SHAPES.some((shape) => shape.test(resolved)) ? resolved : null;
};

/**
 * The confined child's PATH with /usr/bin first, so bare `git` is the xcrun
 * shim the developer-tools grant serves. Seat runners put /opt/homebrew/bin
 * ahead of it, and Homebrew git fails inside the sandbox reading its own
 * /opt/homebrew/etc/gitconfig. Other entries keep their order, so tools
 * /usr/bin lacks (node, npm) still resolve as before.
 */
export const systemToolsFirst = (pathValue) => ['/usr/bin', ...String(pathValue || '').split(delimiter)
  .filter((dir) => dir && dir !== '/usr/bin')].join(delimiter);

const onPath = (name, env) => {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  for (const dir of String(env?.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
};

/**
 * The script a dsh executable runs, and the outermost node_modules holding it:
 * a confined run starts that script with this node, and reads that tree only.
 */
export const resolveDshEntry = (binary, env) => {
  const found = onPath(binary, env);
  if (!found) throw new Error(`dsh adapter: a confined seat could not find ${binary} on PATH`);
  const entry = realpathSync(found);
  const parts = entry.split(sep);
  const root = parts.indexOf('node_modules');
  if (root < 1 || !/\.(?:c|m)?js$/.test(entry)) {
    throw new Error(`dsh adapter: a confined seat runs dsh from its node package; ${found} resolves to ${entry}`);
  }
  return { entry, packages: parts.slice(0, root + 1).join(sep) };
};

/** Fail a confined turn whose provider traffic broke the model pin. */
export const assertServedModel = (check, credentials) => {
  if (!check.refused && !check.failures.length) return;
  const parts = [
    ...(check.refused ? [`${check.refused} request(s) for a model other than ${check.pinned} refused`] : []),
    ...check.failures,
  ];
  throw adapterFailure('dsh', `served model check failed: ${parts.join('; ')}`, { credentials, limit: 500 });
};

/** A stable home per agent and Commonly instance, never the operator's ~/.dsh. */
export const seatHome = (ctx) => {
  if (ctx._dshHome) return ctx._dshHome;
  // F115: a public seat never shares a home with a private turn of the same agent,
  // which could plant a profile row or plugin there. A private seat's id is unchanged.
  const trust = isPublicDsh(ctx.environment) ? '\0public' : '';
  const id = createHash('sha256').update(`${ctx.instanceUrl || ''}\0${ctx.agentName || ''}${trust}`).digest('hex').slice(0, 24);
  return join(homedir(), '.commonly', 'dsh-homes', id);
};

export const childEnvironment = (source, home, bearer) => {
  const env = Object.fromEntries(Object.entries(source || {}).filter(([name]) => SAFE_ENV.test(name)));
  env.HOME = home;
  env.DSH_HOME = home;
  env.DSH_PERMISSION_MODE = 'workspace-write';
  env.DSH_TELEMETRY_MODE = 'DISABLED';
  env.DSH_TELEMETRY_DISABLED = '1';
  env[PROXY_KEY_ENV] = bearer;
  return env;
};

const substitute = (value, { credentialFile, instanceUrl }) => String(value).replace(/\$\{(COMMONLY_[A-Z_]+)\}/g, (whole, name) => ({
  COMMONLY_TOKEN_FILE: credentialFile,
  COMMONLY_API_URL: instanceUrl,
  COMMONLY_INSTANCE_URL: instanceUrl,
}[name] || whole));

const isCommonlyCommand = (command) => {
  if (!Array.isArray(command)) return false;
  if (command.length === 3 && command[0] === 'npx' && command[1] === '-y') {
    return /^@commonlyai\/mcp(?:@(?:latest|\d+\.\d+\.\d+))?$/.test(command[2]);
  }
  return command.length === 2 && basename(command[0]) === 'node'
    && command[1].endsWith('/@commonlyai/mcp/src/index.js');
};

/** One stdio Commonly server only. No remote credential or arbitrary MCP child. */
export const resolveCommonlyMcp = (declared, ctx) => {
  const servers = declared?.length ? declared : [commonlyMcpServer()];
  if (servers.length !== 1 || servers[0]?.name !== 'commonly') {
    throw new Error('dsh adapter: PR 1 supports only the Commonly MCP server');
  }
  const isCommonly = (entry) => (entry.transport || 'stdio') === 'stdio'
    && isCommonlyCommand(entry.command) && !!describeMcpCommand(entry.command)?.isCommonly;
  if (!isCommonly(servers[0])) {
    throw new Error('dsh adapter: Commonly MCP must be a recognized stdio @commonlyai/mcp command');
  }
  // A confined seat runs the warmed build it can read, never a package runner,
  // and that build is held to the same check as the declaration.
  const server = ctx.prepareCommand
    ? { ...servers[0], command: ctx.prepareCommand(servers[0].command) }
    : servers[0];
  if (!isCommonly(server)) {
    throw new Error('dsh adapter: Commonly MCP must be a recognized stdio @commonlyai/mcp command');
  }
  const delivery = deliverSeatCredential(server, {
    credentialFile: ctx.credentialFile, label: 'dsh',
  });
  if (delivery.delivered !== 'path') {
    throw new Error(`dsh adapter: Commonly MCP requires file-backed credentials (got ${delivery.delivered})`);
  }
  const values = { credentialFile: ctx.credentialFile, instanceUrl: ctx.instanceUrl };
  const env = Object.fromEntries(Object.entries(delivery.env)
    .map(([name, value]) => [name, substitute(value, values)]));
  // A public seat's MCP always carries the public-seat flag, whatever was declared,
  // and the tools it must keep off the list (F468): dsh can't filter one server's
  // tools, so the server does. The guard still refuses them at the call, which also
  // covers a warmed MCP build too old to read the list.
  if (ctx.publicSeat) {
    env[PUBLIC_SEAT_MCP_ENV] = '1';
    env[WITHHELD_TOOLS_MCP_ENV] = [...(ctx.withheldTools || [])].join(',');
  }
  const allowed = ['COMMONLY_API_URL', 'COMMONLY_TOKEN_FILE',
    ...(ctx.publicSeat ? [PUBLIC_SEAT_MCP_ENV, WITHHELD_TOOLS_MCP_ENV] : [])];
  if (Object.keys(env).some((name) => !allowed.includes(name))
    || env.COMMONLY_TOKEN_FILE !== ctx.credentialFile || env.COMMONLY_API_URL !== ctx.instanceUrl) {
    throw new Error('dsh adapter: Commonly MCP must use this spawn\'s credential file');
  }
  return {
    id: 'mcp-commonly', name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'commonly', transport: 'stdio',
      command: substitute(server.command[0], values),
      args: server.command.slice(1).map((arg) => substitute(arg, values)),
      env, failOnStartupError: true,
    },
  };
};

/** JSON is valid YAML; a generated patch has no expression or quoting ambiguity. */
export const buildPatch = ({
  proxyBaseURL, model, cwd, mcp, effort, deepseekOfficial = false, confined = false, publicSeat = null,
}) => ([
  { id: 'llm-pi-ai', config: { providers: {
    commonly: {
      apiKeyEnv: PROXY_KEY_ENV, api: 'openai-completions', baseURL: proxyBaseURL,
      ...(effort ? { reasoning: effort } : {}),
      // The loopback proxy hides the upstream URL from pi-ai's compatibility detection.
      // Use the conservative Chat Completions roles/fields for every provider.
      compat: {
        supportsDeveloperRole: false,
        supportsStore: false,
        ...(deepseekOfficial ? { thinkingFormat: 'deepseek' } : {}),
      },
      models: [{ id: model, name: model, contextWindow: 128000,
        ...(effort ? { reasoningEfforts: {
          low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max',
        } } : {}),
      }],
    },
  } } },
  { id: 'agent-default-model', config: { provider: 'commonly', model } },
  { id: 'llm-deepseek', disabled: true },
  { id: 'llm-deepseek-account', disabled: true },
  { id: 'session-log-deepseek', config: { enabled: false } },
  // Confined, the outer Seatbelt is the sandbox: dsh's own would nest a second
  // one, which macOS refuses, so it is off.
  { id: 'sandbox-policy', config: { mode: confined ? 'danger-full-access' : 'workspace-write', workspaceRoot: cwd } },
  // F115: a public turn's native tools are off, the guard refuses whatever is
  // left, and the Commonly MCP starts only once the guard's service exists.
  ...(publicSeat ? [
    ...DSH_PUBLIC_DISABLED_PLUGINS.map((id) => ({ id, disabled: true })),
    { insert: [{ id: 'commonly-public-guard', name: publicSeat.guardPath, config: { withheld: [...publicSeat.withheld] } }] },
  ] : []),
  { insert: [publicSeat ? { ...mcp, inject: [DSH_PUBLIC_GUARD_SERVICE] } : mcp] },
]);

export const assertPatchHasNoCredentials = (serialized, credentials) => {
  if (serialized.includes('${COMMONLY_AGENT_TOKEN}')) {
    throw new Error('dsh adapter: patch contains an unresolved seat token placeholder');
  }
  for (const credential of credentials) {
    if (typeof credential === 'string' && credential && serialized.includes(credential)) {
      throw new Error('dsh adapter: patch contains a credential value');
    }
  }
};

/** dsh writes sessions below DSH_HOME/sessions/<workspace>/<session-id>. */
export const sessionExists = async (home, sessionId) => {
  if (!/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId || '')) return false;
  const root = join(home, 'sessions');
  if (!existsSync(root)) return false;
  for (const workspace of await readdir(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    if (existsSync(join(root, workspace.name, sessionId, 'session.v4.jsonl.zstd'))) return true;
  }
  return false;
};

const parseVersion = (output) => String(output || '').trim().match(/\b\d+\.\d+\.\d+-rc\.\d+\b/)?.[0] || null;
const readVersion = (binary, env) => {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, env, cwd: env.DSH_HOME });
  return result.status === 0 && !result.error ? parseVersion(result.stdout) : null;
};

const parseEvent = (line, state) => {
  let event;
  try { event = JSON.parse(line); } catch { throw new Error('dsh emitted invalid JSON event'); }
  if (event.type === 'session' && typeof event.sessionId === 'string') state.sessionId = event.sessionId;
  if (event.type === 'final' && typeof event.text === 'string') state.final = event.text;
  // F404: each step_end carries that request's usage, input apart from the cache.
  if (event.type === 'status' && event.phase === 'step_end' && event.usage && typeof event.usage === 'object') {
    const tokens = promptTokens({
      input: event.usage.inputTokens, cacheRead: event.usage.cacheReadTokens, cacheWrite: event.usage.cacheWriteTokens,
    });
    if (tokens !== null) state.contextTokens = tokens;
  }
  if (event.type === 'error') state.error = String(event.message || event.error || 'dsh error');
  if (event.type === 'tool_result'
    && /SANDBOX_UNAVAILABLE|sandbox_apply: Operation not permitted/.test(JSON.stringify(event))) {
    state.error = 'dsh sandbox runner unavailable';
  }
};

export const runDsh = ({
  binary, args, cwd, env, timeoutMs, credentials, spawnImpl = childSpawn, onSpawn, controls = {}, ownGroup = false,
}) => new Promise((resolve, reject) => {
  const proc = spawnInOwnGroup(spawnImpl, binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }, { ownGroup });
  observeSpawn(proc, onSpawn, controls);
  const state = {
    sessionId: null, final: null, error: null, buffer: '', contextTokens: null,
  };
  let stderr = '';
  let timedOut = false;
  let parseFailure = null;
  let ownKill = false;
  let settled = false;
  let killTimer;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (error) reject(error); else resolve(result);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
    killTimer = setTimeout(() => proc.kill('SIGKILL'), 5000);
  }, timeoutMs);
  proc.stdout?.on('data', (chunk) => {
    state.buffer += chunk.toString();
    if (state.buffer.length > 1024 * 1024) {
      parseFailure = new Error('dsh event exceeded 1 MiB');
      ownKill = true;
      proc.kill('SIGTERM');
      return;
    }
    while (state.buffer.includes('\n')) {
      const end = state.buffer.indexOf('\n');
      const line = state.buffer.slice(0, end).trim();
      state.buffer = state.buffer.slice(end + 1);
      if (line && !parseFailure) {
        try { parseEvent(line, state); } catch (error) { parseFailure = error; ownKill = true; proc.kill('SIGTERM'); }
      }
    }
  });
  proc.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  proc.on('error', (error) => finish(error));
  proc.on('close', (code, signal) => {
    if (state.buffer.trim() && !parseFailure) {
      try { parseEvent(state.buffer.trim(), state); } catch (error) { parseFailure = error; }
    }
    const failure = parseFailure?.message || state.error || (timedOut ? `timeout after ${timeoutMs}ms` : null)
      || (/SANDBOX_UNAVAILABLE|sandbox_apply: Operation not permitted/.test(stderr) ? 'sandbox runner unavailable' : null)
      || (code !== 0 ? stderr.trim() || `exit ${code}` : null)
      || (state.final === null ? 'no final event' : null);
    // A parse failure mid-stream and a timeout are this adapter's own SIGTERM,
    // and a stream error names its cause: only a bare cut-off came from outside.
    // A trailing event that won't parse at close is a write the signal cut short.
    const ownCause = Boolean(ownKill || state.error || timedOut);
    if (failure) {
      return finish(adapterFailure('dsh', failure, {
        credentials, exitCode: code, limit: 500, ...(ownCause ? {} : { signal }),
      }));
    }
    return finish(null, { text: state.final.trim(), newSessionId: state.sessionId, contextTokens: state.contextTokens });
  });
});

export default {
  requiresModel: true,
  name: 'dsh', runtimeType: 'dsh', supportsProvider: true,

  // The attach gate defers to this for dsh's one confined shape.
  confinesOwnSandbox: (environment) => isConfinedDsh(environment),

  async validateEnvironment(environment, workspacePath) {
    const validation = validateEnvironmentSpec(environment);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    assertEnforceableDsh(environment);
    if (!environment?.provider || !environment?.model) {
      throw new Error('dsh requires environment.provider and environment.model');
    }
    const detected = await this.detect();
    if (!TESTED_DSH_VERSIONS.includes(detected?.version)) {
      throw new Error(`dsh adapter: installed version ${detected?.version || 'unknown'} is not smoke-tested (${TESTED_DSH_VERSIONS.join(', ')})`);
    }
    // A confined dsh is a private seat under Seatbelt, so it is checked too.
    return resolveProviderKeyFile(environment.provider, workspacePath, 'dsh', {
      environment, sandboxed: isConfinedDsh(environment),
    });
  },

  async detect() {
    const home = await mkdtemp(join(tmpdir(), 'commonly-dsh-probe-'));
    try {
      const env = childEnvironment(process.env, home, '');
      const version = readVersion('dsh', env);
      return version ? { path: 'dsh', version } : null;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },

  async spawn(prompt, ctx = {}) {
    const seatModel = requireSeatModel(ctx.environment, 'dsh', true);
    const confined = isConfinedDsh(ctx.environment);
    if (confined) {
      if ((ctx._platform || process.platform) !== 'darwin') {
        throw new Error('dsh adapter: a confined seat needs Seatbelt, which is macOS only');
      }
      const seatbelt = (ctx._detectSeatbelt || detectSeatbelt)();
      if (!seatbelt.available) throw new Error(`dsh adapter: a confined seat needs Seatbelt: ${seatbelt.error}`);
      await refuseWorkspaceHoldingTurnDirs({ workspace: ctx.cwd, seat: 'confined dsh agents' });
    }
    if (!ctx.environment?.provider || !ctx.environment?.model) {
      throw new Error('dsh requires environment.provider and environment.model');
    }
    if (!ctx.runtimeToken || !ctx.instanceUrl) throw new Error('dsh requires a Commonly runtime token and instance URL');
    const isPublic = confined && isPublicDsh(ctx.environment);
    const home = seatHome(ctx);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    // F115: a public turn runs in an empty folder the adapter owns, so nothing a
    // seat or a stranger put in the workspace (a .env dsh would load, say)
    // reaches it. dsh also loads layers from its home: profiles/<name>/ (a user
    // patch that may insert plugins, and their node_modules), cordis.patch.yml,
    // .env, and HOME-relative module paths. So everything in a public home but
    // its sessions is removed before each turn; dsh regenerates its stock profile.
    let workspace = ctx.cwd;
    if (isPublic) {
      for (const entry of await readdir(home, { withFileTypes: true })) {
        if (entry.name === PUBLIC_HOME_KEPT && entry.isDirectory()) continue;
        await rm(join(home, entry.name), { recursive: true, force: true });
      }
      workspace = join(home, PUBLIC_TURN_DIR);
      await mkdir(workspace, { mode: 0o700 });
    }
    const binary = ctx._dshBinary || 'dsh';
    const sourceEnv = ctx.env || process.env;
    const version = readVersion(binary, childEnvironment(sourceEnv, home, ''));
    if (!TESTED_DSH_VERSIONS.includes(version)) {
      throw new Error(`dsh adapter: installed version ${version || 'unknown'} is not smoke-tested (${TESTED_DSH_VERSIONS.join(', ')})`);
    }
    // The seat home is the confined run's statePath: stable and writable in the jail.
    const keyFile = await resolveProviderKeyFile(ctx.environment.provider, ctx.cwd, 'dsh', {
      environment: ctx.environment, platform: ctx._platform, sandboxed: confined, seatDirectories: [home],
    });
    const tempDir = await mkdtemp(join(tmpdir(), 'commonly-dsh-'));
    await chmod(tempDir, 0o700);
    let proxy;
    let relay;
    let egress;
    try {
      const credential = writeCredentialFile(ctx.runtimeToken, { agentName: 'commonly', root: tempDir });
      proxy = await startProviderProxy({
        provider: ctx.environment.provider, keyFile,
        tokenFile: join(tempDir, 'provider-proxy-token'), adapterLabel: 'dsh',
        ...(confined ? { pinnedModel: seatModel } : {}),
      });
      const bearer = (await readFile(proxy.tokenFile, 'utf8')).trim();
      const mcpDirectories = [];
      if (confined) {
        relay = await startInstanceProxy({ instanceUrl: ctx.instanceUrl });
        // A public turn has no tool that reaches the network, so it gets no egress at all.
        if (!isPublic) egress = await (ctx._startEgressProxy || startEgressProxy)();
      }
      let publicSeat = null;
      if (isPublic) {
        const guardPath = join(tempDir, 'commonly-public-guard.mjs');
        await writeFile(guardPath, await readFile(PUBLIC_GUARD_SOURCE), { mode: 0o600 });
        publicSeat = { guardPath, withheld: publicSeatWithheldTools(ctx) };
      }
      const mcp = resolveCommonlyMcp(ctx.environment?.mcp, {
        publicSeat: isPublic,
        withheldTools: publicSeat?.withheld,
        credentialFile: credential.path,
        instanceUrl: confined ? relay.url : ctx.instanceUrl,
        ...(confined ? {
          prepareCommand: (command) => {
            const warmed = (ctx._prepareMcpSpawn || prepareMcpSpawn)(command, { apiUrl: ctx.instanceUrl, publicSeat: true });
            const directory = warmed && (ctx._selectedMcpVersionDir || selectedMcpVersionDir)(warmed);
            if (!directory) {
              throw new Error('dsh adapter: a confined seat runs only a warmed Commonly MCP build, and none is ready on this host');
            }
            mcpDirectories.push(directory);
            return [process.execPath, warmed[1]];
          },
        } : {}),
      });
      const patchData = buildPatch({
        proxyBaseURL: proxy.baseURL, model: seatModel,
        cwd: workspace, mcp, effort: ctx.environment.effort, confined, publicSeat,
        deepseekOfficial: new URL(ctx.environment.provider.baseURL).hostname === 'api.deepseek.com',
      });
      const patch = JSON.stringify(patchData, null, 2);
      const passedProvider = patchData.find((entry) => entry.id === 'llm-pi-ai').config.providers.commonly;
      const passedModel = patchData.find((entry) => entry.id === 'agent-default-model').config.model;
      assertPatchHasNoCredentials(patch, [ctx.runtimeToken, bearer]);
      const patchPath = join(tempDir, 'seat.patch.yml');
      await writeFile(patchPath, `${patch}\n`, { mode: 0o600 });
      await chmod(patchPath, 0o600);
      const env = childEnvironment(sourceEnv, home, bearer);
      const resume = await sessionExists(home, ctx.sessionId);
      // A public turn its owner didn't wake can't write memory, so the cue mustn't ask it to.
      const fullPrompt = buildMemoryPreamble(prompt, ctx.memoryLongTerm, {
        freshSession: !resume, ...(isPublic ? { memoryReadOnly: ctx.ownerWoken !== true } : {}),
      });
      const args = ['--profile', 'headless', '--patch', patchPath, '--json',
        ...(resume ? ['--session-id', ctx.sessionId] : []), fullPrompt];
      const requested = Number(ctx.timeoutMs);
      const timeoutMs = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
      let command = binary;
      let commandArgs = args;
      if (confined) {
        const { entry, packages } = resolveDshEntry(binary, sourceEnv);
        const tempWork = join(home, 'tmp');
        await mkdir(tempWork, { recursive: true, mode: 0o700 });
        env.TMPDIR = tempWork;
        if (egress) {
          for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) env[name] = egress.url;
          env.NO_PROXY = '127.0.0.1,localhost';
          env.no_proxy = env.NO_PROXY;
        }
        const developerDir = (ctx._developerToolsDir || developerToolsDir)({ env: sourceEnv });
        if (developerDir) {
          env.DEVELOPER_DIR = developerDir;
          env.PATH = systemToolsFirst(env.PATH);
        }
        [command, ...commandArgs] = (ctx._wrapArgvWithSeatbelt || wrapArgvWithSeatbelt)([process.execPath, entry, ...args], {
          workspacePath: workspace,
          workspaceAccess: 'write',
          // A public turn's folder is one the CLI made, so it is pinned: a link
          // left there by an earlier turn's process is refused, not followed to a
          // write grant on its target (as goose, opencode and claude pin theirs).
          // A private seat's workspace is the operator's, and a link may be theirs.
          pinWorkspace: isPublic,
          executablePath: process.execPath,
          statePath: home,
          mcpConfigDir: tempDir,
          network: 'loopback',
          loopbackNetworkPorts: [proxy.port, relay.port, ...(egress ? [egress.port] : [])],
          readOnlyDirectories: [packages, ...mcpDirectories, ...(developerDir ? [developerDir] : [])],
        });
      }
      const credentials = [...spawnCredentials(ctx, []), bearer];
      let result;
      let failure;
      try {
        result = await runDsh({
          binary: command, args: commandArgs, cwd: workspace, env, timeoutMs, credentials,
          spawnImpl: ctx._spawnImpl, onSpawn: ctx.onSpawn, ownGroup: wantsOwnProcessGroup(ctx),
          controls: { model: passedModel || null, effort: passedProvider.reasoning || null },
        });
      } catch (error) {
        failure = error;
      }
      // A broken pin is the reason a turn failed, whatever dsh said about it.
      if (confined) {
        const refusals = egress ? egress.stats().refusals : [];
        // eslint-disable-next-line no-console
        if (refusals.length) console.warn(`[dsh] egress refused: ${refusals.map((r) => `${r.target} (${r.reason})`).join(', ')}`);
        assertServedModel(proxy.modelCheck(), credentials);
      }
      if (failure) throw failure;
      return result;
    } finally {
      try { await egress?.close(); } catch { /* best effort */ }
      try { await relay?.close(); } catch { /* best effort */ }
      try { await proxy?.close(); } catch { /* best effort */ }
      await rm(tempDir, { recursive: true, force: true });
    }
  },
};
