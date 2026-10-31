/**
 * The 0600 copy of an agent's runtime token that `commonly mcp config` points
 * COMMONLY_TOKEN_FILE at (TASK-666). It is a second live secret, so the agent
 * token's lifecycle owns it: save refreshes it, delete removes it.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const validMcpTokenName = (name) => typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('.');

export const mcpTokenPath = (name) => {
  if (!validMcpTokenName(name)) throw new Error(`Invalid agent name '${name}'`);
  return join(homedir(), '.commonly', 'mcp', `${name}.token`);
};

// Remove first, then create exclusively at 0600: no write into a looser-mode file or through a symlink.
export const writeMcpTokenCopy = (name, token) => {
  const dir = join(homedir(), '.commonly', 'mcp');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = mcpTokenPath(name);
  rmSync(path, { force: true });
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return path;
};

// A bad name never has a copy, so remove and refresh are no-ops for it and cannot block detach or save.
export const removeMcpTokenCopy = (name) => {
  if (validMcpTokenName(name)) rmSync(mcpTokenPath(name), { force: true });
};

// Reattach mints a new token; a copy that already exists must follow it.
export const refreshMcpTokenCopy = (name, token) => {
  if (token && validMcpTokenName(name) && existsSync(mcpTokenPath(name))) writeMcpTokenCopy(name, token);
};
