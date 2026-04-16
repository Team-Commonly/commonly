/**
 * Config management — ~/.commonly/config.json
 *
 * Stores auth tokens and instance URLs across sessions.
 * Multiple instances supported (default, local, custom).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.commonly');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_INSTANCE_URL = 'https://api.commonly.me';
const LOCAL_INSTANCE_URL = 'http://localhost:5000';

const read = () => {
  if (!existsSync(CONFIG_FILE)) return { instances: {}, active: 'default' };
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { instances: {}, active: 'default' };
  }
};

const write = (config) => {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
};

export const getConfig = () => read();

const normalizeUrl = (value) => (value || '').replace(/\/$/, '').toLowerCase();

/**
 * Resolve an instance identifier to the saved instance record.
 *
 * Accepts either form:
 *   - A saved key:  'dev', 'default', 'local'
 *   - A URL:        'https://api-dev.commonly.me' (any case; trailing / ok)
 *   - null:         falls back to config.active
 *
 * Historically `resolveInstanceUrl` treated the arg as a URL and `getToken`
 * treated it as a key — so `--instance dev` and `--instance <url>` each
 * worked for exactly one of URL-resolution or token-lookup and broke the
 * other. Funneling both through this helper closes that asymmetry.
 *
 * URL-shaped inputs (http[s]://) go through URL resolution first so a
 * hypothetical key named `"https-backup"` can't collide with a real URL.
 * For an unknown URL (no saved match) we return the URL with a null token,
 * which is needed for login bootstrap (there is no saved instance yet) and
 * for unauthenticated probe calls.
 */
export const resolveInstance = (identifier = null) => {
  const config = read();

  if (!identifier) {
    const key = config.active || 'default';
    const inst = config.instances[key];
    return inst ? { key, ...inst } : null;
  }

  // URL-shaped inputs: resolve by URL first. Case-insensitive match so that
  // `HTTPS://API-DEV.commonly.me/` finds a record saved as the lowercased
  // `https://api-dev.commonly.me`.
  const looksLikeUrl = /^https?:\/\//i.test(identifier);
  if (looksLikeUrl) {
    const normalized = normalizeUrl(identifier);
    const urlEntry = Object.entries(config.instances)
      .find(([, v]) => normalizeUrl(v.url) === normalized);
    if (urlEntry) {
      const [key, value] = urlEntry;
      return { key, ...value };
    }
    // Unknown URL — still usable for bootstrapping. Preserve the caller's
    // original case in the returned URL (some servers are case-sensitive on
    // paths; we only lowercase for match comparison above).
    return { key: null, url: identifier.replace(/\/$/, ''), token: null };
  }

  // Key-shaped inputs: exact lookup only.
  if (config.instances[identifier]) {
    return { key: identifier, ...config.instances[identifier] };
  }

  // Unknown key — caller falls back to defaults.
  return null;
};

// Alias kept for existing imports (login.js). Functionally identical to
// resolveInstance; callers using this name pre-date the refactor.
export const getActiveInstance = (instanceOverride = null) => resolveInstance(instanceOverride);

export const resolveInstanceUrl = (instanceArg = null) => {
  const inst = resolveInstance(instanceArg);
  if (inst?.url) return inst.url.replace(/\/$/, '');
  return DEFAULT_INSTANCE_URL;
};

export const saveInstance = ({ key = 'default', url, token, userId, username }) => {
  const config = read();
  config.instances[key] = {
    url: url.replace(/\/$/, ''),
    token,
    userId,
    username,
    savedAt: new Date().toISOString(),
  };
  config.active = key;
  write(config);
};

export const setActive = (key) => {
  const config = read();
  if (!config.instances[key]) throw new Error(`Instance '${key}' not found in config`);
  config.active = key;
  write(config);
};

export const getToken = (instanceOverride = null) => {
  // Env var takes precedence (CI, scripts)
  if (process.env.COMMONLY_TOKEN) return process.env.COMMONLY_TOKEN;
  const inst = resolveInstance(instanceOverride);
  return inst?.token || null;
};

export const listInstances = () => {
  const config = read();
  return Object.entries(config.instances).map(([key, val]) => ({
    key,
    ...val,
    active: key === config.active,
  }));
};

export const LOCAL_URL = LOCAL_INSTANCE_URL;
export const DEFAULT_URL = DEFAULT_INSTANCE_URL;
