/**
 * Launch functions for ACP agents. Each one turns a run ctx into a command, an
 * isolated env and a cleanup; the protocol itself is adapters/acp.js.
 *
 * The provider is an OpenAI-compatible route from `ctx.provider = { baseURL,
 * apiKey, model }`. The key travels in the child env (goose) or a 0600 file
 * the agent's config points at (opencode), never in argv, which any same-user
 * process can read.
 *
 * HOME comes from ctx.env.HOME when the caller gives one, because that is
 * where an agent keeps the sessions a later resume needs. Without one, the
 * spawn gets a throwaway HOME, so nothing of the operator's leaks in and
 * nothing of the run survives it.
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFailure } from '../failures.js';
import { createAcpAdapter, readsAsRefusal } from './acp.js';

const SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|TMPDIR|SSL_CERT_FILE|SSL_CERT_DIR)$/;
const VERSION_TIMEOUT_MS = 5000;

/** The provider route, checked: a plain HTTP(S) base URL, a key and a model. */
export const providerOf = (ctx, label) => {
  const { baseURL, apiKey, model } = ctx?.provider || {};
  let url;
  try { url = new URL(String(baseURL)); } catch {
    throw runFailure('unsupported', `${label}: ctx.provider.baseURL must be an HTTP(S) URL`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw runFailure('unsupported', `${label}: ctx.provider.baseURL must be a plain HTTP(S) URL with no credentials, query or fragment`);
  }
  if (typeof apiKey !== 'string' || !apiKey) throw runFailure('unsupported', `${label}: ctx.provider.apiKey is missing`);
  if (typeof model !== 'string' || !model) throw runFailure('unsupported', `${label}: ctx.provider.model is missing`);
  return { url, apiKey, model };
};

/**
 * Safe launch variables from the caller's env, plus HOME and XDG roots. Only
 * the safe names are read from process.env, and only when ctx.env is absent.
 */
export const isolatedEnv = async (ctx, label) => {
  const source = ctx.env || process.env;
  const env = Object.fromEntries(Object.entries(source).filter(([name]) => SAFE_ENV.test(name)));
  const callerHome = ctx.env?.HOME;
  const home = callerHome || await mkdtemp(join(tmpdir(), `seats-${label}-home-`));
  env.HOME = home;
  env.XDG_CONFIG_HOME = ctx.env?.XDG_CONFIG_HOME || join(home, '.config');
  env.XDG_DATA_HOME = ctx.env?.XDG_DATA_HOME || join(home, '.local', 'share');
  env.XDG_STATE_HOME = ctx.env?.XDG_STATE_HOME || join(home, '.local', 'state');
  env.XDG_CACHE_HOME = ctx.env?.XDG_CACHE_HOME || join(home, '.cache');
  const removeHome = callerHome ? async () => {} : () => rm(home, { recursive: true, force: true });
  return { env, removeHome };
};

const detectVersion = (binary, pattern) => async () => {
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS });
  if (probe.error || probe.status !== 0) return null;
  const version = pattern.exec(String(probe.stdout || ''))?.[1] || 'unknown';
  return { path: binary, version };
};

/**
 * goose 1.54.0 ends a turn whose provider call failed with stopReason
 * end_turn and the error as its reply: "Ran into this error: …". Without this
 * reader that error would be posted as the agent's answer. Measured against
 * the fake provider: a 400 content-policy body, a 500 and a 429 all take this
 * shape, after goose's own retries.
 */
export const readGooseReplyFailure = (text, { credentials = [] } = {}) => {
  const match = /^\s*Ran into this error:\s*([\s\S]*)$/.exec(String(text ?? ''));
  if (!match) return null;
  const detail = match[1].split('\n\nPlease retry')[0].trim();
  return runFailure(readsAsRefusal(detail) ? 'refusal' : 'protocol',
    `goose ended the turn on a provider error: ${detail}`, { credentials, limit: 500 });
};

/** `goose acp` with goose's OpenAI provider pointed at ctx.provider. */
export const launchGoose = async (ctx = {}) => {
  const { url, apiKey, model } = providerOf(ctx, 'goose');
  const { env, removeHome } = await isolatedEnv(ctx, 'goose');
  Object.assign(env, {
    GOOSE_PROVIDER: 'openai',
    GOOSE_MODEL: model,
    // approve: every tool call asks over session/request_permission, so the
    // caller's decidePermission (or the reject default) is the policy.
    GOOSE_MODE: 'approve',
    GOOSE_TELEMETRY_ENABLED: 'false',
    // No keychain prompts or keychain reads: the key arrives in env only.
    GOOSE_DISABLE_KEYRING: '1',
    OPENAI_HOST: url.origin,
    OPENAI_BASE_PATH: `${url.pathname.replace(/\/$/, '')}/chat/completions`.replace(/^\//, ''),
    OPENAI_API_KEY: apiKey,
  });
  return {
    command: ctx._binaryPath || 'goose', args: ['acp'], env, cwd: ctx.cwd, cleanup: removeHome,
  };
};

const OPENCODE_PROVIDER_ID = 'seats';
const OPENCODE_DISABLED_ENV = [
  'OPENCODE_DISABLE_CLAUDE_CODE',
  'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT',
  'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS',
  'OPENCODE_DISABLE_EXTERNAL_SKILLS',
  'OPENCODE_DISABLE_DEFAULT_PLUGINS',
  'OPENCODE_DISABLE_AUTOUPDATE',
];

/**
 * The opencode config for one spawn: a single enabled openai-compatible
 * provider and it as the default model. Same shape as the cli opencode
 * adapter's buildProviderConfig; the default model matters more here, because
 * `opencode acp` has no -m flag and its built-in default is a hosted service.
 */
export const opencodeConfig = ({ baseURL, model, keyFile }) => ({
  share: 'disabled',
  autoupdate: false,
  enabled_providers: [OPENCODE_PROVIDER_ID],
  model: `${OPENCODE_PROVIDER_ID}/${model}`,
  provider: {
    [OPENCODE_PROVIDER_ID]: {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL, apiKey: `{file:${keyFile}}` },
      models: { [model]: { name: model } },
    },
  },
});

/**
 * opencode 2.x reports each provider retry as a session_info_update whose
 * `_meta["opencode/retry"]` is {attempt, nextRetryAt, error: {type, message,
 * status, response: {body}}}, and sends the key as null when the waited-for
 * attempt goes out. Only attempt, nextRetryAt, status and the error's type
 * are read: message and body are provider text.
 */
export const readOpencodeRetry = (update) => {
  const retry = update?._meta?.['opencode/retry'];
  if (retry === null) return { state: 'started' };
  if (typeof retry !== 'object') return null;
  return {
    state: 'scheduled',
    attempt: retry.attempt,
    nextRetryAt: retry.nextRetryAt,
    status: retry.error?.status,
    errorType: retry.error?.type,
  };
};

/** `opencode acp` with a generated config; project and global config are off. */
export const launchOpencode = async (ctx = {}) => {
  const { url, apiKey, model } = providerOf(ctx, 'opencode');
  const { env, removeHome } = await isolatedEnv(ctx, 'opencode');
  const dir = await mkdtemp(join(tmpdir(), 'seats-opencode-'));
  try {
    await chmod(dir, 0o700);
    const keyFile = join(dir, 'provider-key');
    const configPath = join(dir, 'opencode.json');
    const configDir = join(dir, 'config-dir');
    const xdgConfig = join(dir, 'xdg-config');
    await Promise.all([mkdir(configDir), mkdir(join(xdgConfig, 'opencode'), { recursive: true })]);
    await writeFile(keyFile, apiKey, { mode: 0o600, flag: 'wx' });
    await writeFile(configPath, `${JSON.stringify(opencodeConfig({ baseURL: url.href.replace(/\/$/, ''), model, keyFile }), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    Object.assign(env, {
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_AUTO_SHARE: 'false',
      // opencode merges global config from XDG_CONFIG_HOME; point it at an
      // empty dir so only the generated file counts. Data (sessions) stays
      // under the caller's XDG_DATA_HOME, which is what a resume reads.
      XDG_CONFIG_HOME: xdgConfig,
      ...Object.fromEntries(OPENCODE_DISABLED_ENV.map((name) => [name, '1'])),
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    await removeHome();
    throw error;
  }
  return {
    command: ctx._binaryPath || 'opencode',
    args: ['acp'],
    env,
    cwd: ctx.cwd,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await removeHome();
    },
  };
};

export const createAcpGooseAdapter = (host = {}) => createAcpAdapter({
  ...host,
  name: 'acp-goose',
  launch: launchGoose,
  detect: detectVersion('goose', /(\d+\.\d+\.\d+)/),
  readReplyFailure: readGooseReplyFailure,
});

export const createAcpOpencodeAdapter = (host = {}) => createAcpAdapter({
  ...host,
  name: 'acp-opencode',
  launch: launchOpencode,
  readRetryStatus: readOpencodeRetry,
  detect: detectVersion('opencode', /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/),
});

export const acpGoose = createAcpGooseAdapter();
export const acpOpencode = createAcpOpencodeAdapter();
