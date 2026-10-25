/**
 * Where a codex run sends its model traffic, and the `-c` override that sends
 * it through the supervisor's loopback provider relay instead.
 *
 * Checked against openai/codex at rust-v0.162.0:
 *   - model-provider-info/src/lib.rs, merge_configured_model_providers(): a
 *     `model_providers.<id>` entry whose id is BUILT IN is dropped
 *     (`entry(key).or_insert(..)`), Amazon Bedrock excepted. So
 *     `-c model_providers.openai.base_url=...` silently does nothing.
 *   - core/src/config/mod.rs: the built-in `openai` provider takes its base URL
 *     from the top-level `openai_base_url` key. The TypeScript SDK's `baseUrl`
 *     option sets exactly `--config openai_base_url=...`.
 *   - ModelProviderInfo::to_api_provider(): with no base URL, ChatGPT-family
 *     auth calls https://chatgpt.com/backend-api/codex and API-key auth calls
 *     https://api.openai.com/v1. With one, both modes call it, so the relay
 *     needs the mode to pick the upstream.
 *   - supports_codex_backend_routes(): the Codex backend routes stay on only
 *     while the base URL ends in /backend-api/codex. The relay keeps the
 *     upstream's path, so a relayed ChatGPT seat keeps them.
 *   - core/src/client.rs: a 426 on the Responses WebSocket handshake makes the
 *     session fall back to HTTP, which is how the relay keeps every turn tappable.
 *
 * Anything this cannot resolve with certainty is reported not covered, with
 * the reason. A wrong guess would either break the seat or report coverage it
 * does not have.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const OPENAI_API = 'https://api.openai.com/v1';
const CHATGPT_CODEX = 'https://chatgpt.com/backend-api/codex';
const OTHER_BUILT_IN = new Set(['amazon-bedrock', 'amazon-bedrock-runtime', 'ollama', 'lmstudio', 'oss', 'ollama-chat']);
const CHATGPT_MODES = new Set(['chatgpt', 'chatgptAuthTokens', 'headers', 'agentIdentity', 'personalAccessToken']);
const PROVIDER_ID = /^[A-Za-z0-9_-]+$/;

const toml = (s) => JSON.stringify(String(s));
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

// ── a reader for the part of config.toml that names the provider ───────────
// Only `key = "string"` / `key = 'string'` / booleans / numbers, dotted keys,
// and `[table]` headers. Arrays and inline tables are skipped as values this
// route never needs. A multi-line string makes the file unreadable here,
// because a line inside one can look like an assignment.

const unquoteKey = (part) => {
  const p = part.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(p)) return JSON.parse(p);
  if (/^'[^']*'$/.test(p)) return p.slice(1, -1);
  if (/^[A-Za-z0-9_-]+$/.test(p)) return p;
  return null;
};

// Split a dotted key on dots outside quotes.
const splitKey = (key) => {
  const parts = [];
  let current = '';
  let quote = null;
  for (const ch of key) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '.') { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  const keys = parts.map(unquoteKey);
  return keys.includes(null) ? null : keys;
};

const scalar = (raw) => {
  const value = raw.trim();
  let m = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(value);
  if (m) return { value: JSON.parse(`"${m[1]}"`) };
  m = /^'([^']*)'\s*(?:#.*)?$/.exec(value);
  if (m) return { value: m[1] };
  m = /^(true|false)\s*(?:#.*)?$/.exec(value);
  if (m) return { value: m[1] === 'true' };
  m = /^([-+]?\d[\d_]*(?:\.\d+)?)\s*(?:#.*)?$/.exec(value);
  if (m) return { value: Number(m[1].replace(/_/g, '')) };
  return null; // arrays, inline tables, dates: not needed here
};

const setIn = (root, path, value) => {
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (node[key] === undefined) node[key] = {};
    if (typeof node[key] !== 'object' || node[key] === null) return false;
    node = node[key];
  }
  node[path.at(-1)] = value;
  return true;
};

/** The provider-naming subset of a codex config.toml, or null when it cannot be read safely. */
export const readCodexConfigSubset = (text) => {
  if (/"""|'''/.test(text)) return null;
  const root = {};
  let table = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[[')) { table = null; continue; } // array of tables: not read
    const header = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = splitKey(header[1]);
      if (!table) return null;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue; // a continuation line of a multi-line array
    if (table === null) continue;
    const key = splitKey(line.slice(0, eq));
    if (!key) continue;
    const parsed = scalar(line.slice(eq + 1));
    if (!parsed) continue;
    if (!setIn(root, [...table, ...key], parsed.value)) return null;
  }
  return root;
};

const readOptional = (readFile, path) => {
  try { return readFile(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
};

// The upstream of the built-in openai provider when no base URL is configured.
// The auth file is parsed only for its mode; nothing from it is kept.
const openaiDefaultUpstream = (env, codexHome, readFile) => {
  if (nonEmpty(env.CODEX_API_KEY)) return { upstream: OPENAI_API };
  let text;
  try { text = readFile(join(codexHome, 'auth.json'), 'utf8'); } catch {
    return { reason: 'codex has no readable auth.json in its CODEX_HOME (keyring storage, or not logged in), so its auth mode and upstream are unknown' };
  }
  let mode = null;
  let hasKey = false;
  let hasTokens = false;
  try {
    const auth = JSON.parse(text);
    mode = typeof auth?.auth_mode === 'string' ? auth.auth_mode : null;
    hasKey = nonEmpty(auth?.OPENAI_API_KEY);
    hasTokens = !!auth?.tokens;
  } catch {
    return { reason: 'codex auth.json could not be parsed for its auth mode' };
  }
  text = null;
  if (mode === 'apikey') return { upstream: OPENAI_API };
  if (mode && CHATGPT_MODES.has(mode)) return { upstream: CHATGPT_CODEX };
  if (mode) return { reason: `codex auth mode ${JSON.stringify(mode)} does not use an OpenAI base URL the relay can stand in for` };
  if (hasKey && !hasTokens) return { upstream: OPENAI_API };
  if (hasTokens && !hasKey) return { upstream: CHATGPT_CODEX };
  return { reason: 'codex auth.json names no auth mode, so its upstream is ambiguous' };
};

/**
 * @param {object} args
 * @param {object} args.env               the env codex will be spawned with
 * @param {boolean} [args.ignoreUserConfig]  codex runs with --ignore-user-config
 * @returns {{ covered: true, upstream: string, provider: string, flags: (baseURL: string) => string[] }
 *          | { covered: false, reason: string }}
 */
export const codexProviderRoute = ({ env = {}, ignoreUserConfig = false, readFile = readFileSync } = {}) => {
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
  let config = {};
  if (!ignoreUserConfig) {
    let text;
    try { text = readOptional(readFile, join(codexHome, 'config.toml')); } catch {
      return { covered: false, reason: 'codex config.toml could not be read' };
    }
    config = readCodexConfigSubset(text);
    if (!config) return { covered: false, reason: 'codex config.toml uses syntax this route does not read (multi-line strings), so its provider is unknown' };
  }
  const profile = nonEmpty(config.profile) ? config.profiles?.[config.profile] : null;
  const provider = profile?.model_provider ?? config.model_provider ?? 'openai';
  if (!nonEmpty(provider) || !PROVIDER_ID.test(provider)) {
    return { covered: false, reason: 'codex model_provider is not a plain provider id' };
  }

  if (provider === 'openai') {
    const configured = nonEmpty(config.openai_base_url) ? { upstream: config.openai_base_url } : null;
    const route = configured || openaiDefaultUpstream(env, codexHome, readFile);
    if (!route.upstream) return { covered: false, reason: route.reason };
    return {
      covered: true, provider, upstream: route.upstream,
      flags: (baseURL) => ['-c', `openai_base_url=${toml(baseURL)}`],
    };
  }
  if (OTHER_BUILT_IN.has(provider)) {
    return { covered: false, reason: `codex built-in provider ${provider} is not routed through the relay` };
  }
  const entry = config.model_providers?.[provider];
  if (!entry || typeof entry !== 'object') {
    return { covered: false, reason: `codex provider ${provider} is not defined in a table this route reads` };
  }
  if (entry.aws !== undefined) return { covered: false, reason: `codex provider ${provider} signs requests for AWS, which a relay would invalidate` };
  if (!nonEmpty(entry.base_url)) return { covered: false, reason: `codex provider ${provider} has no base_url` };
  return {
    covered: true, provider, upstream: entry.base_url,
    flags: (baseURL) => ['-c', `model_providers.${provider}.base_url=${toml(baseURL)}`],
  };
};

/**
 * Point codex at ctx.providerRelay, or report why it cannot be. Returns the
 * extra `-c` flags; none when there is no relay.
 */
export const routeCodexThroughRelay = ({ relay, env, ignoreUserConfig, readFile }) => {
  if (!relay) return [];
  let route;
  try {
    route = codexProviderRoute({ env, ignoreUserConfig, readFile });
  } catch {
    route = { covered: false, reason: 'codex provider route could not be resolved' };
  }
  if (!route.covered) { relay.notCovered(route.reason); return []; }
  let baseURL;
  try { baseURL = relay.bind({ upstream: route.upstream }); } catch (error) {
    relay.notCovered(`codex provider ${route.provider} base URL cannot be relayed: ${error.message}`);
    return [];
  }
  return route.flags(baseURL);
};
