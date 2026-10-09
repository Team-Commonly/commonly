/**
 * OpenCode adapter — wraps `opencode run --format json` as a Commonly seat.
 *
 * Smoke-tested version is recorded in TESTED_OPENCODE_VERSION below.
 * OpenCode stores sessions under XDG_DATA_HOME. Trusted seats use the
 * operator's data home directly; public seats get per-identity state without
 * operator auth.json and a child environment limited to safe launch/locale
 * variables. Public provider keys
 * stay in the host adapter and reach the configured provider through a
 * per-spawn loopback proxy; OpenCode receives only that proxy's bearer.
 * This protects the key, not provider spend: the model can use its seat's key
 * budget, and bwrap's existing shared networking is not a per-port egress
 * fence.
 * Config is generated per spawn. OpenCode merges config sources, therefore the
 * global config directory is isolated and project config is explicitly off;
 * the environment spec is the sole source of MCP servers for this run.
 *
 * OpenCode's JSON stream carries `sessionID` on step_start, final text in
 * `text.part.text`, and token counts in `step_finish.part.tokens`.
 */

import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { realpathSync } from 'fs';
import { constants as fsConstants } from 'fs';
import { createServer, request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  rm,
  unlink,
  symlink,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import {
  dirname, isAbsolute, join, relative, resolve as pathResolve, sep,
} from 'path';
import { writeCredentialFile } from '../credential-file.js';
import { deliverSeatCredential, withholdRuntimeCredential } from '../mcp-credential-delivery.js';
import { prepareMcpSpawn } from '../mcp-home.js';
import { buildMemoryPreamble } from '../memory-bridge.js';
import {
  isLegacySandboxTrust,
  normalizeSandboxTrust,
  validateEnvironmentSpec,
} from '../environment.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';
import { detectBwrap, wrapArgvWithBwrap } from '../sandbox/bwrap.js';
import { wrapArgvWithSeatbelt } from '../sandbox/seatbelt.js';
import { resolvePublicSandboxMode } from '../sandbox/mode.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const TERMINATION_GRACE_MS = 5000;
// Bump only with a passing real sandbox-exec smoke against the new version.
const TESTED_OPENCODE_VERSION = '1.18.35';
const ALLOW_UNTESTED_OPENCODE_VERSION_ENV = 'COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION';
const VERSION_CHECK_TIMEOUT_MS = 5000;
const OPENCODE_CONFIG_GITIGNORE = [
  'node_modules',
  'package.json',
  'package-lock.json',
  'bun.lock',
  '.gitignore',
].join('\n');
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

const qualifiedProviderModel = (provider, model) => (
  provider ? `${provider.id}/${model}` : model
);

const buildProviderConfig = (provider, model, keyFile) => {
  if (!provider) return undefined;
  if (!model) throw new Error('OpenCode provider configuration requires environment.model');
  // OpenCode 1.18.35 resolves {file:} in provider options, but failed before
  // making a request when the selected id was absent from provider.models.
  const models = { ...(provider.models || {}) };
  const selectedModel = models[model];
  if (!selectedModel) {
    models[model] = { name: model };
  } else if (typeof selectedModel.name !== 'string' || !selectedModel.name) {
    models[model] = { ...selectedModel, name: model };
  }
  return {
    [provider.id]: {
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: provider.baseURL,
        apiKey: `{file:${keyFile}}`,
      },
      models,
    },
  };
};

const isPathWithin = (parent, candidate) => {
  const fromParent = relative(parent, candidate);
  return fromParent === '' || (fromParent !== '..'
    && !fromParent.startsWith(`..${sep}`)
    && !isAbsolute(fromParent));
};

/** Validate without reading the key; OpenCode resolves its value from the file reference. */
const resolveProviderKeyFile = async (provider, workspacePath) => {
  if (!provider) return null;
  const keyFile = provider.keyFile;
  if (typeof keyFile !== 'string' || !isAbsolute(keyFile)) {
    throw new Error('OpenCode provider.keyFile must be an absolute path');
  }
  if (/[\r\n}]/.test(keyFile)) {
    throw new Error('OpenCode provider.keyFile contains characters unsafe for a file reference');
  }
  let details;
  try {
    details = await lstat(keyFile);
  } catch (err) {
    throw new Error(`OpenCode provider key file is unavailable: ${err.message}`);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error('OpenCode provider.keyFile must be a regular, non-symlink file');
  }
  if ((details.mode & 0o777) !== 0o600) {
    throw new Error('OpenCode provider.keyFile must have mode 0600');
  }
  if (typeof workspacePath !== 'string' || !isAbsolute(workspacePath)) {
    throw new Error('OpenCode provider.keyFile requires an absolute workspace path');
  }
  let realKeyFile;
  let realWorkspace;
  try {
    realKeyFile = realpathSync(keyFile);
    realWorkspace = realpathSync(workspacePath);
  } catch (err) {
    throw new Error(`OpenCode provider key path could not be resolved: ${err.message}`);
  }
  if (isPathWithin(realWorkspace, realKeyFile)) {
    throw new Error('OpenCode provider.keyFile must be outside the workspace');
  }
  return realKeyFile;
};

const readProviderKey = async (keyFile) => {
  const noFollow = fsConstants.O_NOFOLLOW || 0;
  const handle = await open(keyFile, fsConstants.O_RDONLY | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile() || (details.mode & 0o777) !== 0o600) {
      throw new Error('OpenCode provider.keyFile changed after validation; expected a regular mode-0600 file');
    }
    const value = (await handle.readFile()).toString('utf8').trim();
    if (!value) throw new Error('OpenCode provider.keyFile must not be empty');
    return value;
  } finally {
    await handle.close();
  }
};

const startProviderProxy = async ({ provider, keyFile, tokenFile }) => {
  const upstream = new URL(provider.baseURL);
  if (!['http:', 'https:'].includes(upstream.protocol)
    || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('OpenCode provider.baseURL must be an http(s) URL without embedded credentials or query data');
  }
  const basePath = upstream.pathname.replace(/\/+$/, '') || '/';
  const upstreamKey = await readProviderKey(keyFile);
  const proxyToken = randomBytes(32).toString('base64url');
  await writeFile(tokenFile, proxyToken, { encoding: 'utf8', mode: 0o600 });
  await chmod(tokenFile, 0o600);

  const logRefusedRequest = (method, requestPath) => {
    let normalizedPath = '/';
    try {
      normalizedPath = new URL(requestPath || '/', 'http://127.0.0.1').pathname || '/';
    } catch {
      // Do not include an unparseable raw request target in logs.
    }
    const safeMethod = typeof method === 'string' && /^[A-Z]+$/.test(method)
      ? method : 'UNKNOWN';
    process.stderr.write(`[opencode] provider proxy refused ${safeMethod} ${normalizedPath}\n`);
  };

  const server = createServer((incoming, outgoing) => {
    const supplied = Buffer.from(incoming.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${proxyToken}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      incoming.resume();
      outgoing.writeHead(401).end();
      return;
    }
    if (!['GET', 'POST'].includes(incoming.method || '')) {
      incoming.resume();
      outgoing.writeHead(405).end();
      return;
    }
    const rejectRoute = (path) => {
      logRefusedRequest(incoming.method, path);
      incoming.resume();
      outgoing.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      outgoing.end(`Unsupported provider request: ${incoming.method || 'UNKNOWN'} ${path}`);
    };
    const rejectBadRequest = () => {
      logRefusedRequest(incoming.method, incoming.url);
      incoming.resume();
      outgoing.writeHead(400).end();
    };

    let target;
    try {
      const requestPath = incoming.url || '/';
      if (!requestPath.startsWith('/') || requestPath.startsWith('//')) {
        rejectBadRequest();
        return;
      }
      if (/%(?:2f|5c|2e)/i.test(requestPath)) {
        rejectBadRequest();
        return;
      }
      // OpenCode owns this local request path, so never use it as an outbound
      // URL. The OpenAI-compatible chat provider needs only these fixed routes;
      // parse the incoming URL against a loopback sentinel, then select a
      // constant endpoint after matching the configured base path exactly.
      // This keeps an OpenCode request from turning the proxy into an arbitrary
      // path/URL fetcher (including paths on a local provider host).
      const requested = new URL(requestPath, 'http://127.0.0.1');
      if (requested.origin !== 'http://127.0.0.1' || requested.search || requested.hash) {
        rejectRoute(requested.pathname);
        return;
      }
      const configuredPath = basePath === '/' ? '' : basePath;
      let endpoint;
      if (incoming.method === 'POST'
        && requested.pathname === `${configuredPath}/chat/completions`) {
        endpoint = 'chat/completions';
      } else if (incoming.method === 'GET'
        && requested.pathname === `${configuredPath}/models`) {
        endpoint = 'models';
      } else {
        rejectRoute(requested.pathname);
        return;
      }
      target = {
        path: `${configuredPath}/${endpoint}`,
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        host: upstream.host,
      };
    } catch {
      rejectBadRequest();
      return;
    }

    const headers = Object.fromEntries(Object.entries(incoming.headers)
      .filter(([name]) => ![
        'authorization', 'connection', 'host', 'keep-alive', 'proxy-authenticate',
        'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
        'x-api-key',
      ].includes(name.toLowerCase())));
    headers.authorization = `Bearer ${upstreamKey}`;
    headers.host = target.host;
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: incoming.method,
      headers,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        outgoing.writeHead(502).end('Provider redirects are not supported');
        return;
      }
      const responseHeaders = Object.fromEntries(Object.entries(response.headers)
        .filter(([name]) => ![
          'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
          'te', 'trailer', 'transfer-encoding', 'upgrade',
        ].includes(name.toLowerCase())));
      outgoing.writeHead(response.statusCode || 502, responseHeaders);
      response.pipe(outgoing);
    });
    request.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end('Provider request failed');
    });
    outgoing.on('close', () => request.destroy());
    incoming.on('aborted', () => request.destroy());
    incoming.pipe(request);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address();
  const proxyBaseURL = new URL(upstream.pathname, `http://127.0.0.1:${port}`).toString();
  return {
    baseURL: proxyBaseURL,
    tokenFile,
    port,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
};

const validateProviderEnvironment = async (environment, workspacePath) => {
  if (environment?.provider === undefined) return null;
  const validation = validateEnvironmentSpec({
    provider: environment.provider,
    model: environment.model,
  });
  if (!validation.ok) {
    throw new Error(`Invalid OpenCode provider configuration: ${validation.errors.join('; ')}`);
  }
  return resolveProviderKeyFile(environment.provider, workspacePath);
};

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
  if (publicSeat) {
    // A public model must never inherit the operator's OpenCode login. The
    // provider proxy is the only supported credential path for public seats.
    const targetStat = await statOrNull(targetAuth);
    if (targetStat && !targetStat.isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink OpenCode seat credential: ${targetAuth}`);
    }
    if (targetStat) await unlink(targetAuth);
    return {
      root,
      appData,
      dataHome,
      authPath: null,
    };
  }
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

const parseOpenCodeVersion = (output) => {
  const match = String(output || '').trim().match(
    /^(?:opencode\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i,
  );
  return match?.[1] || null;
};

const readOpenCodeVersion = (binary, env) => {
  try {
    const probeEnv = { ...env };
    for (const key of DISABLED_ENV) probeEnv[key] = '1';
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8', env: probeEnv, timeout: VERSION_CHECK_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return null;
    return parseOpenCodeVersion(result.stdout);
  } catch {
    return null;
  }
};

const compareOpenCodeVersions = (left, right) => {
  const leftParts = left.split(/[+-]/, 1)[0].split('.').map(Number);
  const rightParts = right.split(/[+-]/, 1)[0].split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
};

const describeOpenCodeVersionMismatch = (installedVersion) => {
  if (!installedVersion) return 'installed OpenCode version is unknown';
  const relation = compareOpenCodeVersions(installedVersion, TESTED_OPENCODE_VERSION);
  if (relation === 0) {
    return `installed OpenCode ${installedVersion} differs from smoke-tested ${TESTED_OPENCODE_VERSION}`;
  }
  return `installed OpenCode ${installedVersion} is ${relation > 0 ? 'newer' : 'older'} than smoke-tested ${TESTED_OPENCODE_VERSION}`;
};

export default {
  name: 'opencode',
  runtimeType: 'opencode',

  async validateEnvironment(environment, workspacePath) {
    return validateProviderEnvironment(environment, workspacePath);
  },

  async detect() {
    try {
      const res = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
      if (res.error || res.status !== 0) return null;
      const stdout = (res.stdout || '').trim();
      const version = parseOpenCodeVersion(stdout) || stdout || 'unknown';
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

    const provider = ctx.environment?.provider;
    if (isPublic && !provider) {
      throw new Error('public OpenCode seats require environment.provider; the implicit public tier and operator auth.json are unsupported for public trust');
    }
    if (isPublic && sandboxMode === 'bwrap' && provider
      && sandbox?.network?.policy === 'restricted') {
      throw new Error('public OpenCode provider proxy requires shared bwrap networking; sandbox.network.policy=restricted cannot reach the loopback proxy');
    }
    const providerKeyFile = await validateProviderEnvironment(ctx.environment, ctx.cwd);

    const sourceEnv = ctx.env || process.env;
    const childSourceEnv = Object.fromEntries(Object.entries(sourceEnv)
      .filter(([key]) => key !== ALLOW_UNTESTED_OPENCODE_VERSION_ENV));
    const runtimeEnv = isPublic
      ? Object.fromEntries(Object.entries(childSourceEnv).filter(([key]) => PUBLIC_SAFE_ENV.test(key)))
      : childSourceEnv;
    const binary = ctx._binaryPath || spawnBinaryPath(runtimeEnv);
    const installedVersion = readOpenCodeVersion(binary, runtimeEnv);
    if (installedVersion !== TESTED_OPENCODE_VERSION) {
      const mismatch = describeOpenCodeVersionMismatch(installedVersion);
      const allowOverride = process.env[ALLOW_UNTESTED_OPENCODE_VERSION_ENV] === '1';
      if (isPublic && !allowOverride) {
        throw new Error(
          `Public OpenCode seats refuse to run: ${mismatch}. `
          + `To override from the host process, set ${ALLOW_UNTESTED_OPENCODE_VERSION_ENV}=1.`,
        );
      }
      // eslint-disable-next-line no-console
      console.warn(isPublic
        ? `[opencode] ${mismatch}; continuing because the host process set ${ALLOW_UNTESTED_OPENCODE_VERSION_ENV}=1`
        : `[opencode] ${mismatch}; trusted seat continues`);
    }

    const fullPrompt = buildMemoryPreamble(prompt, ctx.memoryLongTerm, {
      freshSession: !ctx.sessionId,
    });
    const tempDir = await mkdtemp(join(tmpdir(), 'commonly-opencode-'));
    await chmod(tempDir, 0o700);
    const configPath = join(tempDir, 'opencode.json');
    const configDir = join(tempDir, 'config-dir');
    const xdgConfig = join(tempDir, 'xdg-config');
    const home = isPublic ? join(tempDir, 'home') : null;
    // OpenCode initializes its global and XDG config directories during
    // startup, so create those roots and their ignore files before wrapping.
    // Keep public HOME per-spawn, but leave $HOME/.opencode absent: OpenCode
    // loads it after OPENCODE_CONFIG when present, which could persist config
    // or MCP injection into later spawns.
    const xdgConfigDir = join(xdgConfig, 'opencode');
    await Promise.all([
      mkdir(configDir),
      mkdir(xdgConfigDir, { recursive: true }),
    ]);
    await Promise.all([configDir, xdgConfigDir].map((directory) => writeFile(
      join(directory, '.gitignore'),
      OPENCODE_CONFIG_GITIGNORE,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    )));
    const credential = writeCredentialFile(ctx.runtimeToken, {
      agentName: ctx.agentName || 'agent',
      root: tempDir,
    });
    let openCodeHome = null;
    let providerProxy = null;
    try {
      openCodeHome = await prepareOpenCodeDataHome(ctx, { publicSeat: isPublic });
      if (isPublic && provider) {
        // OpenCode can spend the configured model budget through this proxy;
        // the bearer only prevents unrelated local processes from using it.
        providerProxy = await startProviderProxy({
          provider,
          keyFile: providerKeyFile,
          tokenFile: join(tempDir, 'provider-proxy-token'),
        });
      }
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
        permission: isPublic
          ? publicPermissions(sandboxMode, Object.keys(mcp))
          : 'allow',
        share: 'disabled',
        autoupdate: false,
        ...(provider ? {
          enabled_providers: [provider.id],
          provider: buildProviderConfig(providerProxy
            ? { ...provider, baseURL: providerProxy.baseURL }
            : provider, ctx.environment.model, providerProxy?.tokenFile || providerKeyFile),
        } : {}),
        ...(Object.keys(mcp).length ? { mcp } : {}),
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600,
      });
      await chmod(configPath, 0o600);

      const childEnv = makeChildEnvironment({
        source: runtimeEnv,
        tempDir,
        configPath,
        configDir,
        dataHome: openCodeHome.dataHome,
        stateHome,
        cacheHome,
        home,
        tempWork,
        credentialFile: credential?.path || null,
      });
      const args = buildArgs({
        prompt: fullPrompt,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        model: qualifiedProviderModel(provider, ctx.environment?.model),
        effort: ctx.environment?.effort,
        title: ctx.agentName,
      });
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
          loopbackNetworkPorts: providerProxy ? [providerProxy.port] : [],
          readOnlyPaths: [],
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
      try { await providerProxy?.close(); } catch { /* ignore */ }
      try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  },
};

export {
  ALLOW_UNTESTED_OPENCODE_VERSION_ENV,
  DISABLED_ENV,
  TESTED_OPENCODE_VERSION,
  buildArgs,
  buildMcpConfig,
  buildProviderConfig,
  makeEventParser,
  prepareOpenCodeDataHome,
  publicPermissions,
  readOpenCodeVersion,
  qualifiedProviderModel,
  resolveProviderKeyFile,
  startProviderProxy,
};
