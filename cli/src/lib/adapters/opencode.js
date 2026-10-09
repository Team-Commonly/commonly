/**
 * OpenCode adapter — wraps `opencode run --format json` as a Commonly seat.
 *
 * Tested against opencode-ai 1.18.35. OpenCode stores conversation sessions
 * under XDG_DATA_HOME. Trusted seats use the operator's data home directly;
 * public seats get per-identity state with only an auth.json symlink back to
 * the operator's provider login, and a child environment limited to safe
 * launch/locale variables.
 * Config is generated per spawn. OpenCode merges config sources, therefore the
 * global config directory is isolated and project config is explicitly off;
 * the environment spec is the sole source of MCP servers for this run.
 *
 * OpenCode's JSON stream carries `sessionID` on step_start, final text in
 * `text.part.text`, and token counts in `step_finish.part.tokens`.
 */

import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  unlink,
  symlink,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve as pathResolve } from 'path';
import { writeCredentialFile } from '../credential-file.js';
import { deliverSeatCredential, withholdRuntimeCredential } from '../mcp-credential-delivery.js';
import { prepareMcpSpawn } from '../mcp-home.js';
import { buildMemoryPreamble } from '../memory-bridge.js';
import { isLegacySandboxTrust, normalizeSandboxTrust } from '../environment.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';
import { detectBwrap, wrapArgvWithBwrap } from '../sandbox/bwrap.js';
import { wrapArgvWithSeatbelt } from '../sandbox/seatbelt.js';
import { resolvePublicSandboxMode } from '../sandbox/mode.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const TERMINATION_GRACE_MS = 5000;
const DISABLED_ENV = [
  'OPENCODE_DISABLE_CLAUDE_CODE',
  'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT',
  'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS',
  'OPENCODE_DISABLE_EXTERNAL_SKILLS',
  'OPENCODE_DISABLE_DEFAULT_PLUGINS',
  'OPENCODE_DISABLE_AUTOUPDATE',
];
const PLACEHOLDER_RE = /\$\{(COMMONLY_[A-Z_]+)\}/g;
const PUBLIC_READ_DENIES = [
  '**/.commonly/**',
  '**/.codex/**',
  '**/.env',
  '**/*.env',
  '**/.env.*',
  '**/*.env.*',
];
const PUBLIC_SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR)$/;

const statOrNull = async (path) => {
  try {
    return await lstat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
};

const substitutePublicPlaceholders = (value, ctx) => {
  if (typeof value !== 'string' || !value.includes('${COMMONLY_')) return value;
  const replacements = {
    COMMONLY_TOKEN_FILE: ctx.credentialFile || '',
    COMMONLY_API_URL: ctx.instanceUrl || '',
    COMMONLY_INSTANCE_URL: ctx.instanceUrl || '',
  };
  return value.replace(PLACEHOLDER_RE, (whole, key) => replacements[key] || whole);
};

const isSafeMcpName = (name) => typeof name === 'string'
  && /^[A-Za-z0-9_-]+$/.test(name);

const permissionMcpName = (name) => name.replace(/[^A-Za-z0-9_]/g, '_');

const buildMcpConfig = (servers, ctx = {}) => {
  const mcp = {};
  const runtimeToken = typeof ctx.runtimeToken === 'string' ? ctx.runtimeToken : '';
  for (const server of servers || []) {
    if (!isSafeMcpName(server?.name)) continue;
    const transport = typeof server.transport === 'string'
      ? server.transport.trim().toLowerCase()
      : 'stdio';

    if (transport === 'stdio') {
      if (!Array.isArray(server.command) || server.command.length === 0) continue;
      const command = prepareMcpSpawn(server.command, { apiUrl: ctx.instanceUrl });
      if (runtimeToken && command.some((part) => typeof part === 'string' && part.includes(runtimeToken))) {
        // A bearer token in argv is readable by same-user processes.
        // eslint-disable-next-line no-console
        console.warn(`[opencode] skipping MCP server ${server.name}: seat credentials cannot be passed in argv`);
        continue;
      }
      const delivery = deliverSeatCredential({ ...server, command }, {
        credentialFile: ctx.credentialFile,
        label: 'opencode',
      });
      const env = {};
      let unsupportedCredential = false;
      for (const [key, rawValue] of Object.entries(delivery.env)) {
        if (typeof rawValue !== 'string') continue;
        if (rawValue.includes('${COMMONLY_AGENT_TOKEN}')
          && delivery.delivered !== 'path') {
          unsupportedCredential = true;
          break;
        }
        const value = substitutePublicPlaceholders(rawValue, ctx);
        if (runtimeToken && value.includes(runtimeToken)) {
          unsupportedCredential = true;
          break;
        }
        env[key] = value;
      }
      if (unsupportedCredential) {
        // eslint-disable-next-line no-console
        console.warn(`[opencode] skipping MCP server ${server.name}: its credential declaration has no file-backed delivery`);
        continue;
      }
      mcp[server.name] = {
        type: 'local',
        command: command.map((part) => substitutePublicPlaceholders(part, ctx)),
        enabled: true,
        ...(Object.keys(env).length ? { environment: env } : {}),
        ...(typeof server.cwd === 'string' ? { cwd: server.cwd } : {}),
      };
      continue;
    }

    if (transport !== 'http' || typeof server.url !== 'string') continue;
    if (server.url.includes('${COMMONLY_AGENT_TOKEN}')) continue;
    const url = substitutePublicPlaceholders(server.url, ctx);
    // Runtime credentials only travel through OpenCode's measured {file:}
    // header expansion, never as environment values or literal config text.
    if (runtimeToken && url.includes(runtimeToken)) continue;
    const headers = {};
    let unsupportedCredential = false;
    for (const [key, rawValue] of Object.entries(server.headers || {})) {
      if (typeof rawValue !== 'string') continue;
      let value = substitutePublicPlaceholders(rawValue, ctx);
      if (rawValue.includes('${COMMONLY_AGENT_TOKEN}')) {
        if (key.toLowerCase() !== 'authorization'
          || rawValue !== 'Bearer ${COMMONLY_AGENT_TOKEN}'
          || !ctx.credentialFile) {
          unsupportedCredential = true;
          break;
        }
        value = `Bearer {file:${ctx.credentialFile}}`;
      }
      if (runtimeToken && value.includes(runtimeToken)) {
        unsupportedCredential = true;
        break;
      }
      headers[key] = value;
    }
    if (unsupportedCredential) {
      // eslint-disable-next-line no-console
      console.warn(`[opencode] skipping MCP server ${server.name}: remote credentials must use the bearer file channel`);
      continue;
    }
    mcp[server.name] = {
      type: 'remote',
      url,
      enabled: true,
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }
  return mcp;
};

const publicPermissions = (mode, mcpNames) => {
  const read = { '*': 'allow' };
  const edit = { '*': mode === 'read-only' ? 'deny' : 'allow' };
  for (const pattern of PUBLIC_READ_DENIES) {
    read[pattern] = 'deny';
    edit[pattern] = 'deny';
  }
  return {
    '*': 'deny',
    read,
    edit,
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    bash: 'deny',
    task: 'deny',
    external_directory: 'deny',
    question: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    skill: 'deny',
    todowrite: 'allow',
    todoread: 'allow',
    lsp: 'allow',
    ...Object.fromEntries(mcpNames.map((name) => [`${permissionMcpName(name)}_*`, 'allow'])),
  };
};

const buildArgs = ({ prompt, sessionId, cwd, model, effort, title }) => ([
  '--pure',
  'run',
  '--format', 'json',
  ...(sessionId ? ['-s', String(sessionId)] : []),
  ...(model ? ['-m', String(model)] : []),
  ...(effort ? ['--variant', String(effort)] : []),
  ...(cwd ? ['--dir', cwd] : []),
  ...(title ? ['--title', String(title)] : []),
  prompt,
]);

const makeEventParser = () => {
  let buffer = '';
  let sessionId = null;
  let text = '';
  let usage = null;
  let errorMessage = null;
  const consumeLine = (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.sessionID) sessionId = event.sessionID;
      if (event.type === 'text' && typeof event.part?.text === 'string') {
        text += event.part.text;
      } else if (event.type === 'step_finish' && event.part?.tokens) {
        usage = event.part.tokens;
      } else if (event.type === 'error') {
        errorMessage = event.error?.data?.message || event.error?.message || 'OpenCode turn failed';
      }
    } catch {
      // JSONL stdout should be parseable. Ignore an unrelated line rather than
      // turning a useful final text event into an adapter failure.
    }
  };
  return {
    consume(chunk) {
      buffer += chunk.toString();
      let newline;
      // eslint-disable-next-line no-cond-assign
      while ((newline = buffer.indexOf('\n')) !== -1) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    },
    flush() {
      consumeLine(buffer);
      buffer = '';
    },
    get sessionId() { return sessionId; },
    get text() { return text; },
    get usage() { return usage; },
    get errorMessage() { return errorMessage; },
  };
};

const runOpenCode = ({ cmd, args, cwd, env, timeoutMs, credentials, spawnImpl = childSpawn }) => new Promise((resolve, reject) => {
  let proc;
  try {
    proc = spawnImpl(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    reject(err);
    return;
  }
  let stderr = '';
  let timedOut = false;
  let killTimer = null;
  const events = makeEventParser();
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
    killTimer = setTimeout(() => proc.kill('SIGKILL'), TERMINATION_GRACE_MS);
  }, timeoutMs);
  const clearTimers = () => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  };
  proc.stdout?.on('data', (chunk) => events.consume(chunk));
  proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.on('error', (err) => {
    clearTimers();
    reject(err);
  });
  proc.on('close', (code) => {
    clearTimers();
    events.flush();
    if (timedOut) return reject(new Error(`opencode timed out after ${timeoutMs}ms`));
    if (events.errorMessage) {
      return reject(adapterFailure('opencode turn failed', events.errorMessage, {
        credentials, limit: 2000,
      }));
    }
    if (code !== 0) {
      return reject(adapterFailure('opencode', stderr.trim(), {
        credentials, exitCode: code, limit: 500,
      }));
    }
    resolve({ sessionId: events.sessionId, text: events.text, usage: events.usage });
  });
});

const seatIdentity = (ctx) => [
  ctx.agentName || 'agent',
  ctx.metadata?.event?.podId || 'default-pod',
].join('\0');

const prepareOpenCodeDataHome = async (ctx, { publicSeat = false } = {}) => {
  const operatorDataHome = ctx.env?.XDG_DATA_HOME
    || process.env.XDG_DATA_HOME
    || join(homedir(), '.local', 'share');
  if (!publicSeat) {
    return {
      root: null,
      appData: null,
      dataHome: ctx.env?.XDG_DATA_HOME || process.env.XDG_DATA_HOME || null,
      authPath: null,
    };
  }
  const identity = createHash('sha256').update(seatIdentity(ctx)).digest('hex').slice(0, 24);
  const root = ctx._opencodeHomeRoot || join(homedir(), '.commonly', 'opencode-homes', identity);
  const operatorAppData = join(pathResolve(operatorDataHome), 'opencode');
  if (pathResolve(root) === pathResolve(operatorAppData)) {
    throw new Error('OpenCode seat data must be isolated from the operator OpenCode data directory');
  }
  const rootStat = await statOrNull(root);
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
    throw new Error(`refusing non-directory OpenCode seat state: ${root}`);
  }
  const dataHome = join(root, 'data');
  const appData = join(dataHome, 'opencode');
  await mkdir(appData, { recursive: true, mode: 0o700 });
  for (const path of [dataHome, appData]) {
    const pathStat = await statOrNull(path);
    if (!pathStat?.isDirectory() || pathStat.isSymbolicLink()) {
      throw new Error(`refusing non-directory OpenCode seat state: ${path}`);
    }
  }
  await chmod(root, 0o700);
  await chmod(dataHome, 0o700);
  await chmod(appData, 0o700);

  const sourceAuth = join(operatorAppData, 'auth.json');
  const targetAuth = join(appData, 'auth.json');
  const sourceStat = await statOrNull(sourceAuth);
  const targetStat = await statOrNull(targetAuth);
  const authPath = sourceStat ? realpathSync(sourceAuth) : null;
  const resolvedSourceStat = authPath ? await statOrNull(authPath) : null;
  if (sourceStat && (!resolvedSourceStat?.isFile() || resolvedSourceStat.isSymbolicLink())) {
    throw new Error(`refusing non-regular operator OpenCode credential: ${sourceAuth}`);
  }
  if (targetStat && !targetStat.isSymbolicLink()) {
    throw new Error(`refusing to replace non-symlink OpenCode seat credential: ${targetAuth}`);
  }
  if (sourceStat) {
    const currentTarget = targetStat
      ? pathResolve(dirname(targetAuth), await readlink(targetAuth))
      : null;
    if (currentTarget !== pathResolve(authPath)) {
      if (targetStat) await unlink(targetAuth);
      await symlink(authPath, targetAuth);
    }
  } else if (targetStat) {
    await unlink(targetAuth);
  }
  return { root, appData, dataHome, authPath };
};

const sourceAuthEnvNames = (env) => Object.keys(env || {}).filter((name) => (
  /(?:^|_)(?:API_KEY|ACCESS_TOKEN|ACCESS_KEY|CLIENT_SECRET|PASSWORD|TOKEN|SECRET)$/i.test(name)
));

const makeChildEnvironment = ({
  source,
  tempDir,
  configPath,
  configDir,
  dataHome,
  stateHome,
  cacheHome,
  home,
  tempWork,
  credentialFile,
}) => {
  const env = { ...source };
  // A parent launcher may itself have received injected OpenCode config. These
  // higher-precedence values must not be inherited into a seat spawn.
  for (const key of [
    'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR',
    'OPENCODE_TUI_CONFIG', 'OPENCODE_AUTO_SHARE',
  ]) delete env[key];
  env.OPENCODE_CONFIG = configPath;
  env.OPENCODE_CONFIG_DIR = configDir;
  env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  env.XDG_CONFIG_HOME = join(tempDir, 'xdg-config');
  if (dataHome) env.XDG_DATA_HOME = dataHome;
  else delete env.XDG_DATA_HOME;
  if (stateHome) env.XDG_STATE_HOME = stateHome;
  if (cacheHome) env.XDG_CACHE_HOME = cacheHome;
  if (home) env.HOME = home;
  env.TMPDIR = tempWork;
  env.OPENCODE_AUTO_SHARE = 'false';
  for (const key of DISABLED_ENV) env[key] = '1';
  return withholdRuntimeCredential(env, { credentialFile });
};

const spawnBinaryPath = (env) => {
  try {
    const where = spawnSync('which', ['opencode'], { encoding: 'utf8', env });
    if (where.status === 0 && typeof where.stdout === 'string' && where.stdout.trim()) {
      return realpathSync(where.stdout.trim());
    }
  } catch { /* use PATH resolution in spawn */ }
  return 'opencode';
};

export default {
  name: 'opencode',
  runtimeType: 'opencode',

  async detect() {
    try {
      const res = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
      if (res.error || res.status !== 0) return null;
      const stdout = (res.stdout || '').trim();
      const versionMatch = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
      const version = versionMatch ? versionMatch[1] : (stdout || 'unknown');
      const where = spawnSync('which', ['opencode'], { encoding: 'utf8' });
      const path = where.status === 0 ? (where.stdout || '').trim() || 'opencode' : 'opencode';
      return { path, version };
    } catch {
      return null;
    }
  },

  async spawn(prompt, rawCtx = {}) {
    const sandbox = normalizeSandboxTrust(rawCtx.environment?.sandbox);
    const ctx = rawCtx.environment
      ? { ...rawCtx, environment: { ...rawCtx.environment, sandbox } }
      : rawCtx;
    if (isLegacySandboxTrust(rawCtx.environment?.sandbox)) {
      // eslint-disable-next-line no-console
      console.warn('[opencode] legacy sandbox.trust=internal resolves to public and remains confined');
    }
    const isPublic = sandbox?.trust === 'public';
    const sandboxMode = isPublic ? resolvePublicSandboxMode(sandbox) : null;
    if (isPublic && !['workspace', 'read-only', 'bwrap'].includes(sandboxMode)) {
      throw new Error(`public OpenCode agents require an enforced sandbox mode, got ${sandboxMode || 'unset'}`);
    }

    const fullPrompt = buildMemoryPreamble(prompt, ctx.memoryLongTerm, {
      freshSession: !ctx.sessionId,
    });
    const tempDir = await mkdtemp(join(tmpdir(), 'commonly-opencode-'));
    await chmod(tempDir, 0o700);
    const configPath = join(tempDir, 'opencode.json');
    const configDir = join(tempDir, 'config-dir');
    const xdgConfig = join(tempDir, 'xdg-config');
    await Promise.all([mkdir(configDir), mkdir(xdgConfig)]);
    const credential = writeCredentialFile(ctx.runtimeToken, {
      agentName: ctx.agentName || 'agent',
      root: tempDir,
    });
    let openCodeHome = null;
    try {
      openCodeHome = await prepareOpenCodeDataHome(ctx, { publicSeat: isPublic });
      const stateHome = isPublic ? join(openCodeHome.root, 'state') : null;
      const cacheHome = isPublic ? join(openCodeHome.root, 'cache') : null;
      const tempWork = isPublic ? join(openCodeHome.root, 'tmp') : join(tempDir, 'tmp');
      await Promise.all([
        mkdir(tempWork, { recursive: true, mode: 0o700 }),
        ...(stateHome ? [mkdir(stateHome, { recursive: true, mode: 0o700 })] : []),
        ...(cacheHome ? [mkdir(cacheHome, { recursive: true, mode: 0o700 })] : []),
      ]);
      const mcp = buildMcpConfig(ctx.environment?.mcp, {
        runtimeToken: ctx.runtimeToken,
        instanceUrl: ctx.instanceUrl,
        credentialFile: credential?.path || null,
      });
      const config = {
        permission: isPublic ? publicPermissions(sandboxMode, Object.keys(mcp)) : 'allow',
        share: 'disabled',
        autoupdate: false,
        ...(Object.keys(mcp).length ? { mcp } : {}),
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600,
      });
      await chmod(configPath, 0o600);

      const sourceEnv = ctx.env || process.env;
      const runtimeEnv = isPublic
        ? Object.fromEntries(Object.entries(sourceEnv).filter(([key]) => PUBLIC_SAFE_ENV.test(key)))
        : sourceEnv;
      const childEnv = makeChildEnvironment({
        source: runtimeEnv,
        tempDir,
        configPath,
        configDir,
        dataHome: openCodeHome.dataHome,
        stateHome,
        cacheHome,
        home: isPublic ? openCodeHome.root : null,
        tempWork,
        credentialFile: credential?.path || null,
      });
      const args = buildArgs({
        prompt: fullPrompt,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        model: ctx.environment?.model,
        effort: ctx.environment?.effort,
        title: ctx.agentName,
      });
      const binary = ctx._binaryPath || spawnBinaryPath(childEnv);
      const platform = ctx._platform || process.platform;
      let cmd = binary;
      let spawnArgs = args;
      if (isPublic && sandboxMode === 'bwrap') {
        if (!binary.startsWith('/')) {
          throw new Error('public OpenCode agents require opencode to resolve to an absolute executable path');
        }
        const bwrap = (ctx._detectBwrap || detectBwrap)();
        if (!bwrap.available) throw new Error(`public OpenCode agents require bwrap: ${bwrap.error}`);
        const wrapped = (ctx._wrapArgvWithBwrap || wrapArgvWithBwrap)([binary, ...args], {
          ...ctx.environment,
          sandbox: {
            ...sandbox,
            filesystem: {
              ...(sandbox?.filesystem || {}),
              'write-outside': [
                ...(Array.isArray(sandbox?.filesystem?.['write-outside'])
                  ? sandbox.filesystem['write-outside'] : []),
                openCodeHome.root,
              ],
            },
          },
        }, {
          workspacePath: ctx.cwd,
          readOnlyPaths: [
            tempDir,
            binary,
            process.execPath,
            ...(openCodeHome.authPath ? [openCodeHome.authPath] : []),
          ],
        });
        [cmd, ...spawnArgs] = wrapped;
      } else if (isPublic) {
        if (platform !== 'darwin') {
          throw new Error(`public OpenCode sandbox.mode=${sandboxMode} requires Seatbelt on macOS or bwrap on Linux`);
        }
        const wrapped = (ctx._wrapArgvWithSeatbelt || wrapArgvWithSeatbelt)([binary, ...args], {
          workspacePath: ctx.cwd,
          workspaceAccess: sandboxMode === 'read-only' ? 'read' : 'write',
          executablePath: binary,
          statePath: openCodeHome.root,
          mcpConfigDir: tempDir,
          readOnlyPaths: openCodeHome.authPath ? [openCodeHome.authPath] : [],
        });
        [cmd, ...spawnArgs] = wrapped;
      }
      const credentials = spawnCredentials(ctx, sourceAuthEnvNames(sourceEnv));
      const result = await runOpenCode({
        cmd,
        args: spawnArgs,
        cwd: ctx.cwd,
        env: childEnv,
        timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
        credentials,
        spawnImpl: ctx._spawnImpl,
      });
      return {
        text: result.text.trim(),
        newSessionId: result.sessionId || ctx.sessionId || null,
        ...(result.usage ? { usage: result.usage } : {}),
      };
    } finally {
      try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  },
};

export {
  DISABLED_ENV,
  buildArgs,
  buildMcpConfig,
  makeEventParser,
  prepareOpenCodeDataHome,
  publicPermissions,
};
