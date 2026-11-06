/** Qwen Code 0.25.1 and 0.26.2 wrapper. Public turns have fresh HOME, config and keys. */
import { requireSeatModel } from './seat-model.js';
import { isPatchAfterNewestTested, probeVersion } from './tested-version.js';
import * as childProcess from 'child_process';
import { spawn as childSpawn, spawnSync } from 'child_process';
import { lstatSync, realpathSync } from 'fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join } from 'path';
import { buildMemoryPreamble } from '../memory-bridge.js';
import { deliverSeatCredential } from '../mcp-credential-delivery.js';
import { prepareMcpSpawn, publicMcpUnavailableError, selectedMcpVersionDir } from '../mcp-home.js';
import { writeCredentialFile } from '../credential-file.js';
import { normalizeSandboxTrust, refuseWorkspaceTrust, validateEnvironmentSpec } from '../environment.js';
import { resolvePublicSandboxMode } from '../sandbox/mode.js';
import { detectBwrap, wrapArgvWithBwrap } from '../sandbox/bwrap.js';
import { wrapArgvWithSeatbelt } from '../sandbox/seatbelt.js';
import { refuseWorkspaceHoldingTurnDirs } from '../sandbox/turn-dir.js';
import { resolveProviderKeyFile, startProviderProxy } from '../provider-proxy.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';
import { PUBLIC_SEAT_WITHHELD_TOOLS } from '../public-withheld-tools.js';
import { isOurGrantBroker } from '../grant-broker-guard.js';
import { brokerBridgeEntry } from './broker-bridge-entry.js';

// Add a version only with a passing real clean-box sandbox smoke that names it.
const TESTED_QWEN_VERSIONS = Object.freeze(['0.25.1', '0.26.2']);
// What keeps a broker-holding seat off its credential is a list of denied
// built-ins, so a version with a file-reading tool the list doesn't name could
// reach it. A broker rides only a version that passed the grant proof
// (qwen.grant-broker.public-smoke.test.mjs), compared exactly: no later patch
// and no host override. Narrower than TESTED_QWEN_VERSIONS on purpose.
export const GRANT_TESTED_QWEN_VERSIONS = Object.freeze(['0.26.2']);
const ALLOW_UNTESTED_QWEN_VERSION_ENV = 'COMMONLY_QWEN_ALLOW_UNTESTED_VERSION';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const TERMINATION_GRACE_MS = 5000;
const PUBLIC_SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR)$/;
const PROXY_ENV = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];
const EXCLUDED_TOOLS = [
  'run_shell_command', 'exec', 'edit', 'notebook_edit', 'write_file',
  'agent', 'create_sub_session', 'task_create', 'team_create',
  'workflow', 'advisor',
  // Legacy aliases. Deny both names even if Qwen changes when it canonicalizes.
  'replace', 'task',
  'web_fetch', 'web_search',
];
// Qwen can read its own config directory. That directory also contains the
// per-spawn MCP credential file, so public turns cannot expose OS read tools.
const PUBLIC_READ_TOOLS = [
  'read_file', 'grep_search', 'search_file_content', 'glob', 'list_directory', 'lsp',
  // Both spellings of a Commonly MCP tool, as with the aliases above
  // (public-withheld-tools.js; self-install and memory writes, F118).
  ...PUBLIC_SEAT_WITHHELD_TOOLS.flatMap((tool) => [tool, `mcp__commonly__${tool}`]),
];

const parseVersion = (output) => {
  const match = String(output || '').trim().match(/^(?:qwen(?:\s+code|-code)?\s+)?v?(\d+\.\d+\.\d+)$/i);
  return match ? match[1] : null;
};

// Async and cached per binary (tested-version.js probeVersion): a synchronous
// probe stalled every other seat's provider proxy on the daemon's loop. The
// namespace import is read at call time, so a suite that mocks child_process
// without execFile falls back to the real one.
const readVersion = (binary, env) => probeVersion(binary, {
  env, timeoutMs: 5000, parse: parseVersion, execFileImpl: childProcess.execFile,
});

const resolvedBinary = (env) => {
  const where = spawnSync('which', ['qwen'], { encoding: 'utf8', env });
  return where.status === 0 ? (where.stdout || '').trim() || 'qwen' : 'qwen';
};

const withProbeEnv = async (source, run) => {
  const home = await mkdtemp(join(tmpdir(), 'commonly-qwen-version-'));
  try {
    const settingsPath = join(home, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({
      privacy: { usageStatisticsEnabled: false },
    }), { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(source)
      .filter(([name]) => PUBLIC_SAFE_ENV.test(name)));
    env.HOME = home;
    env.QWEN_HOME = home;
    env.QWEN_RUNTIME_DIR = home;
    env.QWEN_CODE_SYSTEM_SETTINGS_PATH = settingsPath;
    env.QWEN_USAGE_STATISTICS_ENABLED = 'false';
    for (const name of PROXY_ENV) env[name] = '';
    // Awaited here, so the probe home outlives an async probe.
    return await run(env);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

const substitute = (value, ctx) => String(value).replace(/\$\{(COMMONLY_[A-Z_]+)\}/g, (whole, name) => ({
  COMMONLY_TOKEN_FILE: ctx.credentialFile,
  COMMONLY_API_URL: ctx.instanceUrl,
  COMMONLY_INSTANCE_URL: ctx.instanceUrl,
}[name] || whole));

/** The turn's servers: on a public seat, an unproven version loses the broker and keeps the turn. */
export const withoutUnprovenBroker = (servers, { version, isPublic, instanceUrl }) => {
  if (!isPublic || GRANT_TESTED_QWEN_VERSIONS.includes(version) || !Array.isArray(servers)) return servers;
  return servers.filter((server) => {
    if (!isOurGrantBroker(server, { instanceUrl })) return true;
    // eslint-disable-next-line no-console
    console.warn(`[qwen] grant broker ${server.name}: not on Qwen ${version || 'unknown'}, which hasn't passed the grant proof (${GRANT_TESTED_QWEN_VERSIONS.join(', ')}), so this turn runs without it.`);
    return false;
  });
};

export const buildQwenMcpConfig = (servers, ctx) => {
  const mcpServers = {};
  for (const server of servers || []) {
    if (!/^[A-Za-z0-9_-]+$/.test(server?.name || '')) continue;
    const transport = server.transport || 'stdio';
    if (transport === 'stdio') {
      if (!Array.isArray(server.command) || !server.command.length) continue;
      const command = prepareMcpSpawn(server.command, {
        apiUrl: ctx.instanceUrl, publicSeat: ctx.publicSeat,
      });
      if (!command) {
        ctx.unavailableMcp?.push(server.name);
        continue;
      }
      const delivery = deliverSeatCredential({ ...server, command }, {
        credentialFile: ctx.credentialFile,
        label: 'qwen',
      });
      const args = command.slice(1).map((part) => substitute(part, ctx));
      const env = Object.fromEntries(Object.entries(delivery.env)
        .map(([name, value]) => [name, substitute(value, ctx)]));
      const serialized = JSON.stringify({ command: command[0], args, env });
      if (serialized.includes('${COMMONLY_AGENT_TOKEN}')
        || (ctx.runtimeToken && serialized.includes(ctx.runtimeToken))) {
        throw new Error(`Qwen MCP server ${server.name} has no file-backed credential delivery`);
      }
      mcpServers[server.name] = {
        command: command[0], args, env,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        // `--exclude-tools` refuses these at the call and still lists them for
        // the model (measured on 0.26.2), so the server entry drops them too.
        ...(ctx.publicSeat ? { excludeTools: [...PUBLIC_SEAT_WITHHELD_TOOLS] } : {}),
      };
      const versionDir = ctx.publicSeat && selectedMcpVersionDir(command);
      if (versionDir) ctx.mcpReadDirectories?.push(versionDir);
      continue;
    }
    if (transport !== 'http' || typeof server.url !== 'string') {
      throw new Error(`Qwen MCP server ${server.name} has unsupported transport`);
    }
    // F175d: Qwen sends these headers literally (no `${VAR}`, no file), so the
    // broker runs behind the stdio bridge. Public seats only: a private seat
    // has no jail, so the guard withholds its broker, and an entry that reaches
    // here anyway falls through to the refusal below.
    if (ctx.publicSeat && isOurGrantBroker(server, { instanceUrl: ctx.instanceUrl })) {
      const entry = brokerBridgeEntry(server, ctx);
      if (entry.skip) {
        // eslint-disable-next-line no-console
        console.warn(`[qwen] grant broker ${server.name}: ${entry.skip}, so it is not wired for this spawn.`);
        continue;
      }
      mcpServers[server.name] = { command: entry.command, args: entry.args, env: entry.env };
      ctx.mcpReadDirectories?.push(entry.readPath);
      ctx.bridgedBrokers?.push(server.name);
      continue;
    }
    const httpUrl = substitute(server.url, ctx);
    const headers = Object.fromEntries(Object.entries(server.headers || {})
      .map(([name, value]) => [name, substitute(value, ctx)]));
    const serialized = JSON.stringify({ httpUrl, headers });
    if (serialized.includes('${COMMONLY_AGENT_TOKEN}')
      || (ctx.runtimeToken && serialized.includes(ctx.runtimeToken))) {
      throw new Error(`Qwen MCP server ${server.name} requires a credential transport Qwen can keep out of config`);
    }
    mcpServers[server.name] = { httpUrl, headers };
  }
  return { mcpServers };
};

const makeChildEnv = (source, home, settingsPath, proxy) => {
  const env = Object.fromEntries(Object.entries(source)
    .filter(([name]) => PUBLIC_SAFE_ENV.test(name)));
  for (const name of PROXY_ENV) env[name] = '';
  env.HOME = home;
  env.QWEN_HOME = home;
  env.QWEN_RUNTIME_DIR = home;
  env.QWEN_CODE_SYSTEM_SETTINGS_PATH = settingsPath;
  env.QWEN_USAGE_STATISTICS_ENABLED = 'false';
  env.OPENAI_BASE_URL = proxy.baseURL;
  env.OPENAI_API_KEY = proxy.bearer;
  return env;
};

const parseStream = (line, state) => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    state.text = event.message.content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text).join('');
  }
  if (event.type === 'result') {
    if (typeof event.result === 'string') state.text = event.result;
    if (event.is_error) state.error = event.result || 'Qwen returned an error result';
  }
};

const runQwen = ({ cmd, args, cwd, env, timeoutMs, spawnImpl, credentials }) => new Promise((resolve, reject) => {
  const child = (spawnImpl || childSpawn)(cmd, args, {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { text: '', error: null, buffer: '' };
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (error) reject(error); else resolve(result);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS);
  }, timeoutMs);
  let killTimer;
  child.stdout?.on('data', (chunk) => {
    state.buffer += chunk.toString();
    if (state.buffer.length > 1024 * 1024) {
      finish(new Error('Qwen stream line exceeded 1 MiB'));
      child.kill('SIGTERM');
      return;
    }
    while (state.buffer.includes('\n')) {
      const end = state.buffer.indexOf('\n');
      parseStream(state.buffer.slice(0, end), state);
      state.buffer = state.buffer.slice(end + 1);
    }
  });
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.on('error', (error) => finish(error));
  child.on('close', (code) => {
    if (state.buffer) parseStream(state.buffer, state);
    if (timedOut) return finish(new Error(`qwen timed out after ${timeoutMs}ms`));
    if (code !== 0 || state.error) {
      return finish(adapterFailure('qwen', state.error || stderr.trim() || `exit ${code}`, {
        credentials, exitCode: code, limit: 500,
      }));
    }
    return finish(null, { text: state.text.trim() });
  });
});

export default {
  requiresModel: true,
  name: 'qwen',
  runtimeType: 'qwen',
  supportsProvider: true,

  async validateEnvironment(environment, workspacePath) {
    const validation = validateEnvironmentSpec(environment);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    if (!environment?.provider || !environment?.model) {
      throw new Error('Qwen requires environment.provider and environment.model');
    }
    return resolveProviderKeyFile(environment.provider, workspacePath, 'Qwen');
  },

  async detect() {
    return withProbeEnv(process.env, (env) => {
      const result = spawnSync('qwen', ['--version'], { encoding: 'utf8', timeout: 5000, env });
      if (result.status !== 0 || result.error) return null;
      return { path: resolvedBinary(env), version: parseVersion(result.stdout) || 'unknown' };
    });
  },

  async spawn(prompt, ctx = {}) {
    const seatModel = requireSeatModel(ctx.environment, 'qwen', true);
    const sandbox = normalizeSandboxTrust(ctx.environment?.sandbox);
    refuseWorkspaceTrust(sandbox, 'qwen');
    const isPublic = sandbox?.trust === 'public';
    const mode = isPublic ? resolvePublicSandboxMode(sandbox) : null;
    if (isPublic && !['workspace', 'read-only', 'bwrap'].includes(mode)) {
      throw new Error('public Qwen seats require an enforced sandbox');
    }
    const provider = ctx.environment?.provider;
    if (!provider || !ctx.environment?.model) {
      throw new Error('Qwen seats require environment.provider and environment.model');
    }
    if (isPublic && mode === 'bwrap' && sandbox?.network?.policy === 'restricted') {
      throw new Error('public Qwen provider proxy requires shared bwrap networking');
    }
    const keyFile = await this.validateEnvironment(ctx.environment, ctx.cwd);
    const sourceEnv = ctx.env || process.env;
    const { binary, version } = await withProbeEnv(sourceEnv, async (probeEnv) => {
      const path = ctx._binaryPath || resolvedBinary(probeEnv);
      return { binary: path, version: await readVersion(path, probeEnv) };
    });
    if (!TESTED_QWEN_VERSIONS.includes(version)) {
      const versions = TESTED_QWEN_VERSIONS.join(', ');
      const allowOverride = process.env[ALLOW_UNTESTED_QWEN_VERSION_ENV] === '1';
      const patchAfterTested = isPatchAfterNewestTested(version, TESTED_QWEN_VERSIONS);
      if (isPublic && !allowOverride && !patchAfterTested) {
        throw new Error(`Public Qwen seats refuse version ${version || 'unknown'}; smoke-tested: ${versions}. Set ${ALLOW_UNTESTED_QWEN_VERSION_ENV}=1 in the host process to override.`);
      }
      let outcome = 'trusted seat continues';
      if (isPublic) outcome = allowOverride ? 'host override accepted' : 'a patch release on the newest smoke-tested line, so the public seat continues';
      // eslint-disable-next-line no-console
      console.warn(`[qwen] installed ${version || 'unknown'} differs from smoke-tested ${versions}; ${outcome}`);
    }
    // npm launches through a symlink into the package. Qwen loads chunks next
    // to that entry file, so public sandboxes need that exact read-only tree.
    const symlinkedBinary = isPublic && lstatSync(binary).isSymbolicLink();
    const executable = symlinkedBinary
      ? join(realpathSync(dirname(binary)), basename(binary)) : binary;
    const packageDir = symlinkedBinary ? dirname(realpathSync(executable)) : null;
    if (isPublic) await refuseWorkspaceHoldingTurnDirs({ workspace: ctx.cwd, seat: 'public Qwen agents' });
    const tempDir = await mkdtemp(join(tmpdir(), 'commonly-qwen-'));
    await chmod(tempDir, 0o700);
    // Keep child-writable state separate from adapter-owned config and keys.
    const home = await mkdtemp(join(tmpdir(), 'commonly-qwen-home-'));
    await chmod(home, 0o700);
    const settingsPath = join(tempDir, 'settings.json');
    const mcpPath = join(tempDir, 'mcp.json');
    let proxy;
    try {
      const credential = writeCredentialFile(ctx.runtimeToken, {
        agentName: ctx.agentName || 'agent', root: tempDir,
      });
      proxy = await startProviderProxy({
        provider, keyFile, tokenFile: join(tempDir, 'provider-proxy-token'), adapterLabel: 'Qwen',
      });
      const proxyWithBearer = { ...proxy, bearer: (await readFile(proxy.tokenFile, 'utf8')).trim() };
      const unavailableMcp = [];
      const mcpReadDirectories = [];
      const bridgedBrokers = [];
      const turnServers = withoutUnprovenBroker(ctx.environment?.mcp, {
        version, isPublic, instanceUrl: ctx.instanceUrl || '',
      });
      const mcp = buildQwenMcpConfig(turnServers, {
        credentialFile: credential?.path || '',
        instanceUrl: ctx.instanceUrl || '',
        runtimeToken: ctx.runtimeToken || '',
        publicSeat: isPublic,
        unavailableMcp,
        mcpReadDirectories,
        bridgedBrokers,
      });
      if (unavailableMcp.length) throw publicMcpUnavailableError(unavailableMcp);
      await Promise.all([
        writeFile(settingsPath, JSON.stringify({
          privacy: { usageStatisticsEnabled: false },
          general: { enableAutoUpdate: false },
        }), { mode: 0o600 }),
        writeFile(mcpPath, JSON.stringify(mcp), { mode: 0o600 }),
      ]);
      const env = makeChildEnv(sourceEnv, home, settingsPath, proxyWithBearer);
      // QWEN_HOME is discarded after every turn, so Qwen session ids cannot
      // be resumed. The kernel memory preamble supplies continuity instead.
      const fullPrompt = buildMemoryPreamble(prompt, ctx.memoryLongTerm, {
        freshSession: true,
        // F118: a public seat reads its memory but is not offered a write.
        memoryReadOnly: isPublic,
      });
      const allowedTools = [
        ...(Object.hasOwn(mcp.mcpServers, 'commonly') ? ['commonly'] : []), ...bridgedBrokers,
      ].map((name) => `mcp__${name}__*`);
      const args = [
        '--bare', '--safe-mode', '--auth-type', 'openai', '-m', seatModel,
        '--mcp-config', mcpPath, '--exclude-tools', [
          ...EXCLUDED_TOOLS, ...(isPublic ? PUBLIC_READ_TOOLS : []),
        ].join(','),
        // Qwen ignores settings permissions in bare/safe mode, but still
        // honours CLI allow rules. Any seat needs its declared Commonly tools
        // approved before non-interactive execution begins, public included:
        // without it a public seat's commonly_post_message was declined
        // (D247 walk, 11-04). Public parity with Claude's --allowedTools
        // mcp__commonly__*; the withheld tools stay in --exclude-tools above.
        // The broker parks every write for the owner itself (F175d).
        ...(allowedTools.length ? ['--allowed-tools', allowedTools.join(',')] : []),
        '-o', 'stream-json', '-p', fullPrompt,
      ];
      let cmd = executable;
      let spawnArgs = args;
      if (isPublic && mode === 'bwrap') {
        if (!isAbsolute(executable)) throw new Error('public Qwen seats require an absolute qwen executable path');
        // bwrap binds a symlink's target at the link's path, so npm's `.bin/qwen`
        // would lose the `./cli.js` beside it. The real entry keeps its package.
        const bwrapEntry = symlinkedBinary ? realpathSync(executable) : executable;
        const bwrap = (ctx._detectBwrap || detectBwrap)();
        if (!bwrap.available) throw new Error(`public Qwen seats require bwrap: ${bwrap.error}`);
        [cmd, ...spawnArgs] = (ctx._wrapArgvWithBwrap || wrapArgvWithBwrap)([bwrapEntry, ...args], {
          ...ctx.environment,
          sandbox: {
            ...sandbox,
            filesystem: {
              ...(sandbox?.filesystem || {}),
              'write-outside': [
                ...(sandbox?.filesystem?.['write-outside'] || []), home,
              ],
            },
          },
        }, {
          workspacePath: ctx.cwd,
          homePath: home,
          readOnlyPaths: [tempDir, bwrapEntry, packageDir, process.execPath, ...mcpReadDirectories].filter(Boolean),
        });
      } else if (isPublic) {
        if ((ctx._platform || process.platform) !== 'darwin') {
          throw new Error(`public Qwen sandbox.mode=${mode} requires Seatbelt on macOS or bwrap on Linux`);
        }
        [cmd, ...spawnArgs] = (ctx._wrapArgvWithSeatbelt || wrapArgvWithSeatbelt)([executable, ...args], {
          workspacePath: ctx.cwd,
          workspaceAccess: mode === 'read-only' ? 'read' : 'write',
          executablePath: executable,
          statePath: home,
          // Public seat: the CLI made this workspace, so it is pinned (F197).
          pinWorkspace: true,
          mcpConfigDir: tempDir,
          loopbackNetworkPorts: [proxy.port],
          readOnlyDirectories: [...(packageDir ? [packageDir] : []), ...mcpReadDirectories],
        });
      }
      const requestedTimeout = Number(ctx.timeoutMs);
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(requestedTimeout, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
      const result = await runQwen({
        cmd, args: spawnArgs, cwd: ctx.cwd, env, timeoutMs,
        spawnImpl: ctx._spawnImpl,
        credentials: [...spawnCredentials(ctx, []), proxyWithBearer.bearer],
      });
      return { text: result.text, newSessionId: null };
    } finally {
      try { await proxy?.close(); } catch { /* best effort */ }
      await Promise.all([tempDir, home].map((path) => rm(path, { recursive: true, force: true })));
    }
  },
};

export { TESTED_QWEN_VERSIONS, ALLOW_UNTESTED_QWEN_VERSION_ENV, makeChildEnv, parseVersion };
