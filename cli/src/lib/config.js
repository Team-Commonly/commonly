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

export const getActiveInstance = (instanceOverride = null) => {
  const config = read();
  const key = instanceOverride || config.active || 'default';
  const inst = config.instances[key];
  if (!inst) return null;
  return { key, ...inst };
};

export const resolveInstanceUrl = (instanceArg = null) => {
  if (instanceArg) {
    // Explicit --instance flag — return as-is, may not be in config
    return instanceArg.replace(/\/$/, '');
  }
  const inst = getActiveInstance();
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
  const inst = getActiveInstance(instanceOverride);
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
