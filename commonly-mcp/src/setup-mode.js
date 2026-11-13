/**
 * Setup mode: start without a token and say how to add one.
 *
 * A plugin install (the Codex plugin, for one) points COMMONLY_TOKEN_FILE at a
 * file the person writes after installing. Without a token the normal server
 * ends at start, and Codex shows only that the Commonly tools are missing: the
 * startup error with the path stays in a log nobody reads (walked 2026-11-13,
 * Codex 0.162.1). With COMMONLY_MCP_SETUP_MODE=1 the server instead starts with
 * one read-only tool, `commonly_get_started`, and server instructions, both of
 * which name the token path and the steps. The model reads them and tells the
 * person.
 *
 * Opt-in, and only for a declared token FILE that is absent or empty. The CLI's
 * own seats pass their token through the same variable, and a seat whose file
 * is missing must still end loudly; an unreadable file (permissions) is a fault,
 * not a fresh install, so it stays fatal too. Nothing here reads or prints a
 * token, and no request reaches Commonly in setup mode.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { PACKAGE_VERSION } from './version.js';

export const SETUP_MODE_ENV = 'COMMONLY_MCP_SETUP_MODE';

const HOSTED_API = 'https://api.commonly.me';
const HOSTED_PAGE = 'https://commonly.me/v2/agents/byo';

const blank = (value) => value === undefined || String(value).trim() === '';

/**
 * The declared token file's absolute path when setup mode is on and the file is
 * absent or holds nothing; otherwise null, and the normal start runs (and fails
 * as it always did). A missing COMMONLY_API_URL is not a fresh install either:
 * a token alone would not fix it, so that start stays loud too. A relative path
 * is resolved the way the server reads it, so the steps name the file it reads.
 */
export const missingTokenFile = (env = process.env, { readImpl = readFileSync, cwd = process.cwd() } = {}) => {
  if (String(env[SETUP_MODE_ENV] ?? '').trim() !== '1') return null;
  if (!blank(env.COMMONLY_TOKEN_FD) || blank(env.COMMONLY_TOKEN_FILE) || blank(env.COMMONLY_API_URL)) return null;
  const tokenPath = resolve(cwd, String(env.COMMONLY_TOKEN_FILE).trim());
  try {
    return String(readImpl(tokenPath, 'utf8') ?? '').trim() ? null : tokenPath;
  } catch (err) {
    return err && err.code === 'ENOENT' ? tokenPath : null;
  }
};

/** The steps, as one plain-text answer. A path is not a secret. */
export const setupMessage = ({ tokenPath, apiUrl }) => {
  const hosted = String(apiUrl ?? '').replace(/\/+$/, '') === HOSTED_API;
  const page = hosted
    ? `the Bring your own page, ${HOSTED_PAGE}`
    : 'the Bring your own page on your Commonly instance (/v2/agents/byo)';
  return [
    `Commonly is not connected yet: there is no agent token at ${tokenPath}.`,
    'To connect:',
    `1. Get a token for an agent in your pod from ${page}. It starts with cm_agent_.`,
    `2. Write only that token to ${tokenPath}, then run: chmod 600 '${tokenPath.replace(/'/g, `'\\''`)}'`,
    '3. Start a new session, so the Commonly server restarts and reads it.',
    'Never paste the token into a chat or a pod message.',
    '(To the assistant: give the user these steps with the full path exactly as written above.)',
  ].join('\n');
};

/** A server with the steps as instructions and as its only tool. */
export const createSetupServer = ({ tokenPath, apiUrl }) => {
  const text = setupMessage({ tokenPath, apiUrl });
  const server = new Server(
    { name: '@commonlyai/mcp', version: PACKAGE_VERSION },
    { capabilities: { tools: {} }, instructions: text },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'commonly_get_started',
      description: 'Commonly is not connected yet. Call this to get the steps for adding the agent token, then give the user those steps with the token path exactly as written.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    ...(req.params.name === 'commonly_get_started' ? {} : { isError: true }),
    content: [{ type: 'text', text }],
  }));
  return server;
};
