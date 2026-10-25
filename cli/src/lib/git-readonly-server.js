/**
 * The `workspace_git` MCP server: one tool, `git`, for a workspace-trust seat
 * (TASK-294). The claude adapter spawns it as
 *
 *   node git-readonly-server.js --root <workspace> --git <binary>
 *
 * and the model sees it as `mcp__workspace_git__git`. It speaks the MCP stdio
 * transport (newline-delimited JSON-RPC 2.0) and hands every call to
 * runReadonlyGit, which refuses anything that is not read-only and runs the
 * rest with execFile in the workspace.
 */
import { realpathSync, statSync } from 'fs';
import { isAbsolute } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { READONLY_GIT_SUBCOMMANDS, runReadonlyGit } from './git-readonly.js';

export const SERVER_NAME = 'workspace_git';
export const TOOL_NAME = 'git';
const SERVER_VERSION = '1.0.0';

// The tool surface is the same in each of these, so the server answers in the
// version the client asked for when it is one of them.
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18']);

export const GIT_TOOL = Object.freeze({
  name: TOOL_NAME,
  description: `Run read-only git in your workspace: ${READONLY_GIT_SUBCOMMANDS.join(', ')}. `
    + 'Pass the subcommand and its arguments separately, one argument per array entry, '
    + "e.g. { subcommand: 'log', args: ['-n', '5', '--oneline'] }. "
    + 'Options that write a file, run a program, or read outside the workspace are refused with the reason, '
    + 'and paths must stay inside the workspace. This is the only git available to you.',
  inputSchema: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', enum: [...READONLY_GIT_SUBCOMMANDS] },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments after the subcommand, one per entry.',
      },
    },
    required: ['subcommand'],
    additionalProperties: false,
  },
});

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * A handler for one parsed JSON-RPC message. Resolves the response, or null
 * for a notification (a message with no id), which gets none.
 */
export const createGitServerHandler = ({
  root, git = 'git', baseEnv = process.env, run = runReadonlyGit,
}) => async (message) => {
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
    return fail(message?.id ?? null, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;
  if (id === undefined) return null;
  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    return reply(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: [GIT_TOOL] });
  if (method === 'tools/call') {
    if (params?.name !== TOOL_NAME) return fail(id, -32602, `Unknown tool: ${params?.name}`);
    const { subcommand, args = [] } = params.arguments || {};
    const { ok, text } = await run({
      subcommand, args, root, git, baseEnv,
    });
    return reply(id, { content: [{ type: 'text', text }], isError: !ok });
  }
  return fail(id, -32601, `Method not found: ${method}`);
};

/** `--root <dir> --git <binary>`; the root must be an existing directory. */
export const parseServerArgs = (argv) => {
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const root = value('--root');
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('--root <absolute workspace path> is required');
  const real = realpathSync(root);
  if (!statSync(real).isDirectory()) throw new Error(`--root ${root} is not a directory`);
  return { root: real, git: value('--git') || 'git' };
};

export const serve = ({
  root, git, input = process.stdin, output = process.stdout, baseEnv = process.env,
}) => {
  const handle = createGitServerHandler({ root, git, baseEnv });
  // A closed pipe on the client side is the client leaving, not an error.
  output.on('error', () => {});
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(fail(null, -32700, 'Parse error'))}\n`);
      return;
    }
    const response = await handle(message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  });
  return lines;
};

const runAsMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (runAsMain()) {
  let options;
  try {
    options = parseServerArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${SERVER_NAME}: ${err.message}\n`);
    process.exit(2);
  }
  serve(options);
}
