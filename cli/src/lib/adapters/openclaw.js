/** OpenClaw 2026.10.5 BYO wrapper. Embedded exec uses a pinned, isolated config. */
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMemoryPreamble } from '../memory-bridge.js';
import { commonlyMcpServer } from '../default-environment.js';
import { effectiveSandboxTrust, validateEnvironmentSpec } from '../environment.js';
import { writeCredentialFile } from '../credential-file.js';
import { deliverSeatCredential } from '../mcp-credential-delivery.js';
import { prepareMcpSpawn } from '../mcp-home.js';
import { resolveProviderKeyFile } from '../provider-proxy.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';

export const TESTED_OPENCLAW_VERSIONS = Object.freeze(['2026.10.5']);
const PROVIDER_KEY_ENV = 'COMMONLY_OPENCLAW_PROVIDER_KEY';
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const TERMINATION_GRACE_MS = 5000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR)$/;

export const assertPrivateOpenClaw = (environment = {}) => {
  const sandbox = environment?.sandbox || {};
  if (effectiveSandboxTrust(sandbox.trust) === 'public') {
    throw new Error('openclaw adapter: public-trust seats are not supported');
  }
  if (sandbox.mode && sandbox.mode !== 'none') {
    throw new Error(`openclaw adapter: sandbox.mode=${sandbox.mode} cannot be enforced`);
  }
};

export const parseOpenClawVersion = (output) => {
  const match = String(output || '').trim().match(/^OpenClaw (\d{4}\.\d{1,2}\.\d{1,2})(?: \([0-9a-f]+\))?$/);
  return match?.[1] || null;
};

const readVersion = (binary, env) => {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000, env });
  return result.status === 0 && !result.error ? parseOpenClawVersion(result.stdout) : null;
};

const readProviderKey = async (path) => {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const details = await handle.stat();
    if (!details.isFile() || (details.mode & 0o777) !== 0o600) {
      throw new Error('openclaw adapter: provider key file changed after validation');
    }
    const key = (await handle.readFile()).toString('utf8').trim();
    if (!key) throw new Error('openclaw adapter: provider key file is empty');
    return key;
  } finally {
    await handle.close();
  }
};

const substitute = (value, ctx) => String(value).replace(/\$\{(COMMONLY_[A-Z_]+)\}/g, (whole, name) => ({
  COMMONLY_TOKEN_FILE: ctx.credentialFile,
  COMMONLY_API_URL: ctx.instanceUrl,
  COMMONLY_INSTANCE_URL: ctx.instanceUrl,
}[name] || whole));

/** OpenClaw 2026.10.5 agent exec initializes mcp.servers from --config. */
export const openClawMcpServers = (servers, ctx) => {
  const configured = {};
  for (const server of servers || []) {
    if (!/^[A-Za-z0-9_-]+$/.test(server?.name || '')) {
      throw new Error('openclaw adapter: MCP server needs a safe name');
    }
    if ((server.transport || 'stdio') !== 'stdio' || !Array.isArray(server.command) || !server.command.length) {
      throw new Error(`openclaw adapter: MCP server ${server.name} needs a stdio command`);
    }
    const command = prepareMcpSpawn(server.command, { apiUrl: ctx.instanceUrl });
    const delivery = deliverSeatCredential({ ...server, command }, {
      credentialFile: ctx.credentialFile, label: 'openclaw',
    });
    const env = Object.fromEntries(Object.entries(delivery.env)
      .map(([name, value]) => [name, substitute(value, ctx)]));
    const entry = {
      command: substitute(command[0], ctx),
      args: command.slice(1).map((part) => substitute(part, ctx)),
      env,
    };
    const serialized = JSON.stringify(entry);
    if (serialized.includes('${COMMONLY_AGENT_TOKEN}')
      || (ctx.runtimeToken && serialized.includes(ctx.runtimeToken))) {
      throw new Error(`openclaw adapter: MCP server ${server.name} has no file-backed credential delivery`);
    }
    configured[server.name] = entry;
  }
  return configured;
};

const runOpenClaw = ({ binary, args, cwd, env, prompt, timeoutMs, credentials, spawnImpl = childSpawn }) => new Promise((resolve, reject) => {
  const child = spawnImpl(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const decoder = new StringDecoder('utf8');
  let stdout = '';
  let stderr = '';
  let bytes = 0;
  let failure = null;
  let settled = false;
  let killTimer;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (error) reject(error); else resolve(value);
  };
  const terminate = (message) => {
    if (failure) return;
    failure = message;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS);
  };
  const timer = setTimeout(() => terminate(`timed out after ${timeoutMs}ms`), timeoutMs);
  child.stdout?.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) return terminate('JSON output exceeded 2 MiB');
    stdout += decoder.write(chunk);
  });
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.stdin?.on('error', () => terminate('could not deliver prompt on stdin'));
  child.stdin?.end(prompt);
  child.on('error', (error) => finish(error));
  child.on('close', (code, signal) => {
    stdout += decoder.end();
    let envelope;
    try { envelope = JSON.parse(stdout); } catch { /* handled below */ }
    const exitCode = code ?? ({ SIGINT: 130, SIGTERM: 143 }[signal] || null);
    const message = failure || envelope?.error?.message || stderr.trim() || `exit ${exitCode}; invalid JSON envelope`;
    if (failure || exitCode !== 0 || envelope?.ok !== true || envelope?.status !== 'ok'
      || typeof envelope.final !== 'string') {
      return finish(adapterFailure('openclaw', message, { credentials, exitCode, limit: 500 }));
    }
    const costUsd = Number.isFinite(envelope.costUsd) ? envelope.costUsd
      : (Number.isFinite(envelope.usage?.cost?.total) ? envelope.usage.cost.total : undefined);
    return finish(null, { text: envelope.final.trim(), newSessionId: null,
      ...(costUsd === undefined ? {} : { costUsd }) });
  });
});

export default {
  name: 'openclaw',
  runtimeType: 'openclaw',
  supportsProvider: true,

  async detect() {
    const version = readVersion('openclaw', process.env);
    if (!version) return null;
    const where = spawnSync('which', ['openclaw'], { encoding: 'utf8', timeout: 5000 });
    return { path: where.status === 0 ? where.stdout.trim() : 'openclaw', version };
  },

  async validateEnvironment(environment, workspacePath) {
    assertPrivateOpenClaw(environment);
    const validation = validateEnvironmentSpec(environment);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    if (!environment.provider || !environment.model) {
      throw new Error('openclaw adapter: a host-local provider and model are required');
    }
    return resolveProviderKeyFile(environment.provider, workspacePath, 'openclaw');
  },

  async spawn(prompt, ctx = {}) {
    const keyFile = await this.validateEnvironment(ctx.environment, ctx.cwd);
    const binary = ctx._binaryPath || 'openclaw';
    const sourceEnv = ctx.env || process.env;
    const version = ctx._version || readVersion(binary, sourceEnv);
    if (!TESTED_OPENCLAW_VERSIONS.includes(version)) {
      throw new Error(`openclaw adapter: installed version ${version || 'unknown'} is not smoke-tested (${TESTED_OPENCLAW_VERSIONS.join(', ')})`);
    }
    const home = await mkdtemp(join(tmpdir(), 'commonly-openclaw-'));
    await chmod(home, 0o700);
    try {
      const credential = writeCredentialFile(ctx.runtimeToken, { root: home, agentName: ctx.agentName || 'agent' });
      if (!credential?.path) throw new Error('openclaw adapter: a Commonly seat credential is required');
      const declaredMcp = ctx.environment.mcp?.length ? ctx.environment.mcp : [commonlyMcpServer()];
      const mcp = openClawMcpServers(declaredMcp, {
        credentialFile: credential?.path || '', instanceUrl: ctx.instanceUrl || '', runtimeToken: ctx.runtimeToken || '',
      });
      const key = await readProviderKey(keyFile);
      const model = ctx.environment.model;
      const provider = ctx.environment.provider;
      const modelConfig = provider.models?.[model] || {};
      const config = {
        agents: { defaults: { model: { primary: `${provider.id}/${model}` }, contextInjection: 'never' } },
        models: { mode: 'replace', providers: { [provider.id]: {
          baseUrl: provider.baseURL, apiKey: `\${${PROVIDER_KEY_ENV}}`, api: 'openai-completions',
          models: [{ id: model, name: model, input: ['text'], reasoning: false,
            ...(modelConfig.cost ? { cost: modelConfig.cost } : {}),
            contextWindow: modelConfig.contextWindow || 128000,
            maxTokens: modelConfig.maxTokens || 8192 }],
        } } },
        mcp: { servers: mcp },
      };
      const configPath = join(home, 'config.json');
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      const env = Object.fromEntries(Object.entries(sourceEnv).filter(([name]) => SAFE_ENV.test(name)));
      Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
        [PROVIDER_KEY_ENV]: key });
      const requested = Number(ctx.timeoutMs);
      const timeoutMs = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
      const fullPrompt = buildMemoryPreamble(prompt, ctx.memoryLongTerm, { freshSession: true });
      const args = ['agent', 'exec', '--config', configPath, '--model', `${provider.id}/${model}`,
        '--json', '--cwd', ctx.cwd, '--timeout', String(Math.ceil(timeoutMs / 1000)), '--message-file', '-'];
      return await runOpenClaw({
        binary, args, cwd: ctx.cwd, env, prompt: fullPrompt, timeoutMs,
        credentials: [...spawnCredentials(ctx, []), key], spawnImpl: ctx._spawnImpl,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
};
