/** Grok Build local CLI wrapper. Authentication stays with the operator's grok login. */
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { buildMemoryPreamble } from '../memory-bridge.js';
import { commonlyMcpServer } from '../default-environment.js';
import { isShippedCommonlyMcpEntry } from '../declared-mcp-guard.js';
import { effectiveSandboxTrust } from '../environment.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;
const MANAGED_HEADER = '# Commonly-managed Grok MCP config. Do not add other servers here.\n';
const tomlString = (value) => JSON.stringify(String(value));

const grokVersion = (output) => String(output || '').trim().match(/^grok\s+(\d+\.\d+\.\d+)(?:\s|$)/i)?.[1] || null;

const ancestorConfigs = (cwd, home) => {
  const seatCwd = resolve(cwd);
  for (let dir = seatCwd; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, '.mcp.json'))) {
      throw new Error('Grok adapter refuses a workspace with inherited .mcp.json servers');
    }
    if (dir !== seatCwd && existsSync(join(dir, '.grok', 'config.toml'))) {
      throw new Error('Grok adapter refuses inherited project .grok/config.toml servers');
    }
  }
  const userConfig = join(home, '.grok', 'config.toml');
  if (existsSync(userConfig)) {
    const content = lstatSync(userConfig).isSymbolicLink() ? 'mcp_servers' : null;
    return { userConfig, content };
  }
  return { userConfig: null, content: null };
};

/** Refuse extra native servers; Grok merges rather than replaces user config. */
const assertNoUserMcp = async (userConfig, symlinkMarker) => {
  if (!userConfig) return;
  if (symlinkMarker) throw new Error('Grok adapter refuses a symlinked user config');
  const content = await readFile(userConfig, 'utf8');
  if (content.split('\n').some((line) => !line.trimStart().startsWith('#') && /\bmcp_servers\b/.test(line))) {
    throw new Error('Grok adapter refuses a user config with inherited MCP servers; use a clean HOME for this seat');
  }
};

const managedConfig = (command) => `${MANAGED_HEADER}\n[mcp_servers.commonly]\n`
  + `command = ${tomlString(command[0])}\n`
  + `args = [${command.slice(1).map(tomlString).join(', ')}]\n`
  + 'env = { COMMONLY_API_URL = "${COMMONLY_API_URL}", COMMONLY_AGENT_TOKEN = "${COMMONLY_AGENT_TOKEN}" }\n';

const writeManagedConfig = async (cwd, content) => {
  const dir = join(cwd, '.grok');
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
    throw new Error('Grok adapter refuses a symlinked .grok directory');
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'config.toml');
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || await readFile(path, 'utf8') !== content) {
      throw new Error('Grok adapter refuses to replace an existing .grok/config.toml');
    }
    return;
  }
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
};

/** Grok merges user, project, plugin and compat servers. Check the merged view. */
const assertSoleMcpServer = (cwd, env, command, spawnSyncImpl = spawnSync) => {
  const result = spawnSyncImpl('grok', ['--cwd', cwd, '--trust', 'mcp', 'list', '--json'], {
    cwd, env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Grok MCP inventory failed; refusing to start a seat without a verified tool set');
  }
  let servers;
  try { servers = JSON.parse(result.stdout); } catch {
    throw new Error('Grok MCP inventory was not JSON; refusing to start');
  }
  if (!Array.isArray(servers) || servers.length !== 1 || servers[0]?.name !== 'commonly'
    || servers[0]?.enabled !== true || servers[0]?.command !== command[0]
    || JSON.stringify(servers[0]?.args || []) !== JSON.stringify(command.slice(1))
    || servers[0]?.env?.COMMONLY_AGENT_TOKEN !== env.COMMONLY_AGENT_TOKEN
    || servers[0]?.env?.COMMONLY_API_URL !== env.COMMONLY_API_URL) {
    throw new Error('Grok loaded MCP servers other than the pinned Commonly server; refusing to start');
  }
};

const runGrok = ({ args, cwd, env, timeoutMs, spawnImpl, credentials }) => new Promise((resolveTurn, rejectTurn) => {
  const child = (spawnImpl || childSpawn)('grok', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const decoder = new StringDecoder('utf8');
  let stdout = '';
  let stderr = '';
  let overflow = false;
  let stopping = false;
  let timedOut = false;
  let settled = false;
  let closed = false;
  let killTimer;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (error) rejectTurn(error); else resolveTurn(result);
  };
  const stop = () => {
    if (closed || stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 5000);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  child.on('error', (error) => {
    stop();
    finish(adapterFailure('Grok', error?.message || 'spawn failed', { credentials }));
  });
  child.stdout.on('data', (chunk) => {
    if (overflow) return;
    stdout += decoder.write(chunk);
    if (stdout.length > MAX_OUTPUT_CHARS) {
      overflow = true;
      stop();
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.on('close', (code) => {
    closed = true;
    if (settled) return;
    if (timedOut) return finish(new Error(`Grok timed out after ${timeoutMs}ms`));
    if (overflow) return finish(new Error('Grok JSON result exceeded 2 MiB'));
    stdout += decoder.end();
    let result;
    try { result = JSON.parse(stdout); } catch {
      return finish(adapterFailure('Grok', stderr || 'invalid JSON result', { credentials, exitCode: code }));
    }
    if (code !== 0 || result?.type === 'error') {
      return finish(adapterFailure('Grok', result?.message || stderr || `exit ${code}`, { credentials, exitCode: code }));
    }
    if (typeof result?.text !== 'string' || typeof result?.sessionId !== 'string' || !result.sessionId) {
      return finish(new Error('Grok result omitted text or sessionId'));
    }
    return finish(null, { text: result.text, newSessionId: result.sessionId });
  });
});

export default {
  name: 'grok',
  runtimeType: 'grok',
  supportsProvider: false,

  async validateEnvironment(environment) {
    if (environment?.provider !== undefined) throw new Error('Grok uses the operator grok login, not environment.provider');
    if (effectiveSandboxTrust(environment?.sandbox?.trust) === 'public'
      || (environment?.sandbox?.mode && environment.sandbox.mode !== 'none')) {
      throw new Error('Grok public or sandbox-declared seats are unsupported: no enforced confinement adapter exists');
    }
    const servers = environment?.mcp || [commonlyMcpServer()];
    if (!Array.isArray(servers) || servers.length !== 1 || servers[0]?.name !== 'commonly'
      || servers[0]?.transport !== 'stdio' || !isShippedCommonlyMcpEntry(servers[0])) {
      throw new Error('Grok adapter requires only the shipped Commonly stdio MCP server');
    }
  },

  async detect() {
    const result = spawnSync('grok', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status !== 0) return null;
    const version = grokVersion(result.stdout);
    return version ? { path: 'grok', version } : null;
  },

  async spawn(prompt, ctx = {}) {
    await this.validateEnvironment(ctx.environment);
    const cwd = ctx.cwd;
    const env = { ...(ctx.env || process.env) };
    if (!cwd || !isAbsolute(cwd) || !env.HOME || !isAbsolute(env.HOME)) {
      throw new Error('Grok adapter requires an absolute seat cwd and the wrapper HOME');
    }
    if (!ctx.runtimeToken || !ctx.instanceUrl) throw new Error('Grok adapter requires a per-spawn Commonly credential and instance URL');
    // Browser login lives under this HOME. Never silently switch to an API key
    // or an inherited GROK_HOME that points at another operator's profile.
    delete env.XAI_API_KEY;
    delete env.GROK_HOME;
    env.COMMONLY_AGENT_TOKEN = ctx.runtimeToken;
    env.COMMONLY_API_URL = ctx.instanceUrl;
    env.GROK_CLAUDE_MCPS_ENABLED = 'false';
    env.GROK_CURSOR_MCPS_ENABLED = 'false';
    env.GROK_MANAGED_MCPS_ENABLED = 'false';
    env.GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED = 'false';
    env.GROK_SUBAGENTS = '0';
    env.GROK_MEMORY = '0';
    const userConfig = ancestorConfigs(cwd, env.HOME);
    await assertNoUserMcp(userConfig.userConfig, userConfig.content);
    const declared = ctx.environment?.mcp?.[0] || commonlyMcpServer();
    // A project config persists across turns. The MCP warm cache may move from
    // npx to a versioned executable between them, so use the canonical stable
    // declaration here instead of writing a one-turn warm path into TOML.
    const command = declared.command;
    await writeManagedConfig(cwd, managedConfig(command));
    assertSoleMcpServer(cwd, env, command, ctx._spawnSyncImpl);
    const dir = await mkdtemp(join(tmpdir(), 'commonly-grok-prompt-'));
    try {
      const promptPath = join(dir, 'prompt.txt');
      await writeFile(promptPath, buildMemoryPreamble(prompt, ctx.memoryLongTerm, {
        freshSession: !ctx.sessionId,
      }), { mode: 0o600 });
      const args = ['--prompt-file', promptPath, '--output-format', 'json',
        '--permission-mode', 'dontAsk', '--allow', 'MCPTool(commonly__*)',
        '--deny', 'Bash', '--deny', 'Read', '--deny', 'Grep', '--deny', 'Edit',
        '--deny', 'Write', '--deny', 'WebFetch', '--deny', 'WebSearch', '--no-subagents',
        '--disable-web-search', '--no-auto-update', '--cwd', cwd, '--trust'];
      if (ctx.environment?.model) args.push('--model', ctx.environment.model);
      if (ctx.sessionId) args.push('--resume', ctx.sessionId);
      const requestedTimeout = Number(ctx.timeoutMs);
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(requestedTimeout, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
      return await runGrok({
        args, cwd, env, timeoutMs, spawnImpl: ctx._spawnImpl,
        credentials: spawnCredentials(ctx, ['COMMONLY_AGENT_TOKEN']),
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  },
};
