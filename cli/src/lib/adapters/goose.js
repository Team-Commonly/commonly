/** Goose 1.54.0 wrapper. Public seats wait for TASK-236's deny-by-default proof. */
import { requireSeatModel } from './seat-model.js';
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { buildMemoryPreamble } from '../memory-bridge.js';
import { effectiveSandboxTrust, refuseWorkspaceTrust, validateEnvironmentSpec } from '../environment.js';
import { writeCredentialFile } from '../credential-file.js';
import { deliverSeatCredential, withholdRuntimeCredential } from '../mcp-credential-delivery.js';
import { prepareMcpSpawn } from '../mcp-home.js';
import { resolveProviderKeyFile } from '../provider-proxy.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';

// A version enters this list only after a real headless turn with that binary.
export const TESTED_GOOSE_VERSIONS = Object.freeze(['1.54.0']);
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const TERMINATION_GRACE_MS = 5000;
const DEFAULT_PROVIDER_HOST = 'https://litellm.commonly.me';
const DEFAULT_PROVIDER_KEY = 'COMMONLY_LITELLM_KEY';
const PLACEHOLDER_RE = /\$\{(COMMONLY_[A-Z_]+)\}/g;
const SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR)$/;

export const assertNoSandboxDeclared = (environment = {}) => {
  const sandbox = environment?.sandbox || {};
  refuseWorkspaceTrust(sandbox, 'goose');
  if (effectiveSandboxTrust(sandbox.trust) === 'public') {
    throw new Error('goose adapter: public-trust seats are not supported until the deny-by-default attack test passes');
  }
  if (sandbox.mode && sandbox.mode !== 'none') {
    throw new Error(`goose adapter: sandbox.mode=${sandbox.mode} cannot be enforced by Goose`);
  }
};

const versionOf = (value) => String(value || '').trim().match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;

/** Goose splits this string itself; reject quotes it cannot represent safely. */
const gooseWord = (value) => {
  const word = String(value);
  if (!word || /["\r\n\0]/.test(word)) throw new Error('goose adapter: MCP argument contains an unsupported character');
  return `"${word}"`;
};

const substitute = (value, ctx) => String(value).replace(PLACEHOLDER_RE, (whole, name) => ({
  COMMONLY_TOKEN_FILE: ctx.credentialFile,
  COMMONLY_API_URL: ctx.instanceUrl,
  COMMONLY_INSTANCE_URL: ctx.instanceUrl,
}[name] || whole));

/** The flag contains paths and URLs only. Literal MCP secrets cannot ride argv. */
export const extensionArgs = (servers, ctx) => {
  const args = [];
  for (const server of servers || []) {
    if (!/^[A-Za-z0-9_-]{2,}$/.test(server?.name || '')) {
      throw new Error('goose adapter: MCP server needs a safe name');
    }
    const transport = server.transport || 'stdio';
    if (transport === 'http') {
      if (server.headers && Object.keys(server.headers).length) {
        throw new Error(`goose adapter: HTTP MCP server ${server.name} has headers Goose cannot deliver without exposing credentials`);
      }
      if (typeof server.url !== 'string' || !server.url) throw new Error(`goose adapter: ${server.name} has no HTTP URL`);
      const url = substitute(server.url, ctx);
      const parsed = new URL(url);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(`goose adapter: HTTP MCP server ${server.name} contains a credential-bearing URL`);
      }
      if (parsed.origin !== new URL(ctx.instanceUrl).origin) {
        throw new Error(`goose adapter: HTTP MCP server ${server.name} is outside the Commonly instance`);
      }
      args.push('--with-streamable-http-extension', url);
      continue;
    }
    if (transport !== 'stdio' || !Array.isArray(server.command) || !server.command.length) {
      throw new Error(`goose adapter: MCP server ${server.name} has an unsupported transport or command`);
    }
    const command = prepareMcpSpawn(server.command, { apiUrl: ctx.instanceUrl });
    const delivery = deliverSeatCredential({ ...server, command }, {
      credentialFile: ctx.credentialFile, label: 'goose',
    });
    if (delivery.delivered === 'env' || delivery.delivered === 'unavailable') {
      throw new Error(`goose adapter: MCP server ${server.name} cannot receive its credential by file`);
    }
    const env = Object.entries(delivery.env).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('goose adapter: invalid MCP environment key');
      if (!['COMMONLY_TOKEN_FILE', 'COMMONLY_API_URL', 'COMMONLY_INSTANCE_URL'].includes(name)) {
        throw new Error(`goose adapter: MCP server ${server.name} has ${name}, which cannot safely ride a CLI flag`);
      }
      const resolved = substitute(value, ctx);
      if (resolved.includes('${COMMONLY_AGENT_TOKEN}') || (ctx.runtimeToken && resolved.includes(ctx.runtimeToken))) {
        throw new Error(`goose adapter: MCP server ${server.name} would expose the runtime token in argv`);
      }
      return gooseWord(`${name}=${resolved}`);
    });
    const commandWords = command.map((part) => gooseWord(substitute(part, ctx)));
    args.push('--with-extension', `${server.name}:${[...env, ...commandWords].join(' ')}`);
  }
  return args;
};

export const readGooseStream = (stdout) => {
  let text = '';
  let error = null;
  let complete = false;
  for (const line of String(stdout || '').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'complete') complete = true;
    if (event?.type === 'error') error = event.error?.message || event.message || 'Goose turn failed';
    if (event?.type === 'message' && event.message?.role === 'assistant'
      && event.message?.metadata?.userVisible !== false) {
      const body = event.message.content?.filter((item) => item?.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text).join('') || '';
      if (body.trim()) text = body.trim();
    }
  }
  return { text, error, complete };
};

const runGoose = ({ binary, args, cwd, env, timeoutMs, credentials, spawnImpl = childSpawn }) => new Promise((resolve, reject) => {
  const child = spawnImpl(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  const stdoutDecoder = new StringDecoder('utf8');
  let stderr = '';
  let timedOut = false;
  let streamOverflow = false;
  let extensionFailure = null;
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
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS);
  }, timeoutMs);
  child.stdout?.on('data', (chunk) => {
    if (streamOverflow) return;
    stdout += stdoutDecoder.write(chunk);
    if (stdout.length > 2 * 1024 * 1024) {
      streamOverflow = true;
      stdout = '';
      clearTimeout(timer);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS);
    }
  });
  child.stderr?.on('data', (chunk) => {
    const received = chunk.toString();
    extensionFailure ||= (stderr + received).match(/Failed to start extension '[^']+'[^\n]*/)?.[0] || null;
    stderr = (stderr + received).slice(-8192);
  });
  child.on('error', (error) => finish(error));
  child.on('close', (code) => {
    stdout += stdoutDecoder.end();
    if (timedOut) return finish(new Error(`goose adapter: timed out after ${timeoutMs}ms`));
    if (streamOverflow) return finish(new Error('goose adapter: stream exceeded 2 MiB'));
    const result = readGooseStream(stdout);
    // Goose reports an extension startup failure on stderr yet exits 0 and
    // lets the model answer without that tool. A Commonly seat cannot silently
    // lose its only path back to the pod.
    if (code !== 0 || result.error || !result.complete || extensionFailure) {
      return finish(adapterFailure('goose', extensionFailure || result.error || stderr.trim() || `exit ${code}; incomplete stream`, {
        credentials, exitCode: code, limit: 500,
      }));
    }
    return finish(null, result.text);
  });
});

export default {
  requiresModel: true,
  name: 'goose',
  providerKeyEnv: DEFAULT_PROVIDER_KEY,
  supportsProvider: true,

  async validateEnvironment(environment, workspacePath) {
    assertNoSandboxDeclared(environment);
    const validation = validateEnvironmentSpec(environment || {});
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    return resolveProviderKeyFile(environment?.provider, workspacePath, 'Goose');
  },

  async detect() {
    const result = spawnSync('goose', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status !== 0) return null;
    const where = spawnSync('which', ['goose'], { encoding: 'utf8', timeout: 5000 });
    return { path: String(where.stdout || 'goose').trim() || 'goose', version: versionOf(result.stdout) || 'unknown' };
  },

  async spawn(prompt, ctx = {}) {
    const seatModel = requireSeatModel(ctx.environment, 'goose', true);
    const keyFile = await this.validateEnvironment(ctx.environment, ctx.cwd);
    const sourceEnv = ctx.env || process.env;
    const configured = ctx.environment?.provider;
    const key = configured
      ? (await readFile(keyFile, 'utf8')).trim() : sourceEnv[DEFAULT_PROVIDER_KEY];
    if (!key) throw new Error(`goose adapter: ${configured ? 'provider.keyFile' : DEFAULT_PROVIDER_KEY} is missing`);
    const baseUrl = new URL(configured?.baseURL || `${DEFAULT_PROVIDER_HOST}/v1`);
    if (!/^https?:$/.test(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new Error('goose adapter: provider.baseURL must be a plain HTTP(S) URL');
    }
    const model = seatModel;
    const binary = ctx._binaryPath || 'goose';
    const version = ctx._version || versionOf(spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout);
    if (!TESTED_GOOSE_VERSIONS.includes(version)) {
      // eslint-disable-next-line no-console
      console.warn(`[goose] installed ${version || 'unknown'} differs from smoke-tested ${TESTED_GOOSE_VERSIONS.join(', ')}; private seat continues`);
    }
    const home = await mkdtemp(join(tmpdir(), 'commonly-goose-'));
    try {
      const credential = writeCredentialFile(ctx.runtimeToken, {
        root: home, agentName: ctx.agentName || 'agent',
      });
      const args = [
        'run', '--no-session', '--no-profile', '--with-builtin', 'developer',
        '--output-format', 'stream-json', '--provider', 'openai', '--model', model,
        ...extensionArgs(ctx.environment?.mcp, {
          credentialFile: credential?.path || '', instanceUrl: ctx.instanceUrl || '',
          runtimeToken: ctx.runtimeToken || '',
        }),
        '-t', buildMemoryPreamble(prompt, ctx.memoryLongTerm, { freshSession: true }),
      ];
      const env = {
        ...Object.fromEntries(Object.entries(sourceEnv).filter(([name]) => SAFE_ENV.test(name))),
        HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        GOOSE_PROVIDER: 'openai',
        GOOSE_MODEL: model,
        GOOSE_MODE: 'auto',
        GOOSE_TELEMETRY_ENABLED: 'false',
        OPENAI_HOST: baseUrl.origin,
        OPENAI_BASE_PATH: `${baseUrl.pathname.replace(/\/$/, '')}/chat/completions`.replace(/^\//, ''),
        OPENAI_API_KEY: key,
      };
      withholdRuntimeCredential(env, { credentialFile: credential?.path || null });
      const requestedTimeout = Number(ctx.timeoutMs);
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(requestedTimeout, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
      const text = await runGoose({
        binary, args, cwd: ctx.cwd, env, timeoutMs,
        credentials: [...spawnCredentials(ctx, [DEFAULT_PROVIDER_KEY]), key],
        spawnImpl: ctx._spawnImpl,
      });
      return { text, newSessionId: null };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
};
