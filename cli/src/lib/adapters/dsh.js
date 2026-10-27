import { observeSpawn } from '../runtime-observation.js';
/**
 * DeepSeek Harness 0.2.1-rc.2, private seats only. Configuration is per spawn.
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
import { buildMemoryPreamble } from '../memory-bridge.js';
import { commonlyMcpServer } from '../default-environment.js';
import { effectiveSandboxTrust, refuseWorkspaceTrust, validateEnvironmentSpec } from '../environment.js';
import { deliverSeatCredential } from '../mcp-credential-delivery.js';
import { describeMcpCommand } from '../mcp-server-version.js';
import { writeCredentialFile } from '../credential-file.js';
import { resolveProviderKeyFile, startProviderProxy } from '../provider-proxy.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';

export const TESTED_DSH_VERSIONS = Object.freeze(['0.2.1-rc.2']);
const PROXY_KEY_ENV = 'COMMONLY_DSH_PROXY_KEY';
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR)$/;

/** True for the one confined shape this adapter enforces; throws on any other sandbox. */
export const isConfinedDsh = (environment = {}) => {
  const sandbox = environment?.sandbox || {};
  refuseWorkspaceTrust(sandbox, 'dsh');
  if (effectiveSandboxTrust(sandbox.trust) === 'public') {
    throw new Error('dsh adapter: public-trust seats are not supported; nested Seatbelt fails closed');
  }
  if (sandbox.mode === undefined) return false;
  const { mode, network, ...rest } = sandbox;
  const networkKeys = Object.keys(network || {});
  if (mode === 'workspace' && network?.policy === 'restricted'
    && networkKeys.length === 1 && Object.keys(rest).length === 0) return true;
  throw new Error(`dsh adapter: sandbox.mode=${mode} cannot be enforced by this adapter; `
    + "the one confined shape is { mode: 'workspace', network: { policy: 'restricted' } }");
};

export const assertPrivateDsh = (environment = {}) => { isConfinedDsh(environment); };

/**
 * The macOS developer tools a confined writer needs for git, granted read-only.
 * /usr/bin/git is an xcrun shim: inside the sandbox it cannot read the tools it
 * forwards to, so `git` fails with "No developer tools were found" and a writer
 * cannot commit (D106). Returns null when no tools are installed; the seat then
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
  const id = createHash('sha256').update(`${ctx.instanceUrl || ''}\0${ctx.agentName || ''}`).digest('hex').slice(0, 24);
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
  if (Object.keys(env).some((name) => !['COMMONLY_API_URL', 'COMMONLY_TOKEN_FILE'].includes(name))
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
  proxyBaseURL, model, cwd, mcp, effort, deepseekOfficial = false, confined = false,
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
  { insert: [mcp] },
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
  const state = { sessionId: null, final: null, error: null, buffer: '' };
  let stderr = '';
  let timedOut = false;
  let parseFailure = null;
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
      proc.kill('SIGTERM');
      return;
    }
    while (state.buffer.includes('\n')) {
      const end = state.buffer.indexOf('\n');
      const line = state.buffer.slice(0, end).trim();
      state.buffer = state.buffer.slice(end + 1);
      if (line && !parseFailure) {
        try { parseEvent(line, state); } catch (error) { parseFailure = error; proc.kill('SIGTERM'); }
      }
    }
  });
  proc.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  proc.on('error', (error) => finish(error));
  proc.on('close', (code) => {
    if (state.buffer.trim() && !parseFailure) {
      try { parseEvent(state.buffer.trim(), state); } catch (error) { parseFailure = error; }
    }
    const failure = parseFailure?.message || state.error || (timedOut ? `timeout after ${timeoutMs}ms` : null)
      || (/SANDBOX_UNAVAILABLE|sandbox_apply: Operation not permitted/.test(stderr) ? 'sandbox runner unavailable' : null)
      || (code !== 0 ? stderr.trim() || `exit ${code}` : null)
      || (state.final === null ? 'no final event' : null);
    if (failure) return finish(adapterFailure('dsh', failure, { credentials, exitCode: code, limit: 500 }));
    return finish(null, { text: state.final.trim(), newSessionId: state.sessionId });
  });
});

export default {
  requiresModel: true,
  name: 'dsh', runtimeType: 'dsh', supportsProvider: true,

  // The attach gate defers to this for dsh's one confined shape (D106).
  confinesOwnSandbox: (environment) => isConfinedDsh(environment),

  async validateEnvironment(environment, workspacePath) {
    const validation = validateEnvironmentSpec(environment);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    assertPrivateDsh(environment);
    if (!environment?.provider || !environment?.model) {
      throw new Error('dsh requires environment.provider and environment.model');
    }
    const detected = await this.detect();
    if (!TESTED_DSH_VERSIONS.includes(detected?.version)) {
      throw new Error(`dsh adapter: installed version ${detected?.version || 'unknown'} is not smoke-tested (${TESTED_DSH_VERSIONS.join(', ')})`);
    }
    return resolveProviderKeyFile(environment.provider, workspacePath, 'dsh');
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
    }
    if (!ctx.environment?.provider || !ctx.environment?.model) {
      throw new Error('dsh requires environment.provider and environment.model');
    }
    if (!ctx.runtimeToken || !ctx.instanceUrl) throw new Error('dsh requires a Commonly runtime token and instance URL');
    const home = seatHome(ctx);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    const binary = ctx._dshBinary || 'dsh';
    const sourceEnv = ctx.env || process.env;
    const version = readVersion(binary, childEnvironment(sourceEnv, home, ''));
    if (!TESTED_DSH_VERSIONS.includes(version)) {
      throw new Error(`dsh adapter: installed version ${version || 'unknown'} is not smoke-tested (${TESTED_DSH_VERSIONS.join(', ')})`);
    }
    const keyFile = await resolveProviderKeyFile(ctx.environment.provider, ctx.cwd, 'dsh');
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
        egress = await (ctx._startEgressProxy || startEgressProxy)();
      }
      const mcp = resolveCommonlyMcp(ctx.environment?.mcp, {
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
        cwd: ctx.cwd, mcp, effort: ctx.environment.effort, confined,
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
      const fullPrompt = buildMemoryPreamble(prompt, ctx.memoryLongTerm, { freshSession: !resume });
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
        for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) env[name] = egress.url;
        env.NO_PROXY = '127.0.0.1,localhost';
        env.no_proxy = env.NO_PROXY;
        const developerDir = (ctx._developerToolsDir || developerToolsDir)({ env: sourceEnv });
        if (developerDir) env.DEVELOPER_DIR = developerDir;
        [command, ...commandArgs] = (ctx._wrapArgvWithSeatbelt || wrapArgvWithSeatbelt)([process.execPath, entry, ...args], {
          workspacePath: ctx.cwd,
          workspaceAccess: 'write',
          executablePath: process.execPath,
          statePath: home,
          mcpConfigDir: tempDir,
          network: 'loopback',
          loopbackNetworkPorts: [proxy.port, relay.port, egress.port],
          readOnlyDirectories: [packages, ...mcpDirectories, ...(developerDir ? [developerDir] : [])],
        });
      }
      const credentials = [...spawnCredentials(ctx, []), bearer];
      let result;
      let failure;
      try {
        result = await runDsh({
          binary: command, args: commandArgs, cwd: ctx.cwd, env, timeoutMs, credentials,
          spawnImpl: ctx._spawnImpl, onSpawn: ctx.onSpawn, ownGroup: wantsOwnProcessGroup(ctx),
          controls: { model: passedModel || null, effort: passedProvider.reasoning || null },
        });
      } catch (error) {
        failure = error;
      }
      // A broken pin is the reason a turn failed, whatever dsh said about it.
      if (confined) {
        const { refusals } = egress.stats();
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
