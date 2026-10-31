/**
 * commonly mcp config — print an MCP server config for a locally attached agent (TASK-666).
 * The MCP server only accepts a cm_agent_* runtime token, so the config points
 * COMMONLY_TOKEN_FILE at a 0600 copy of that token and never prints the token.
 */
import { listLocalAgents, loadAgentToken } from './agent.js';
import { writeMcpTokenCopy } from '../lib/mcp-token.js';

const NO_AGENT_HINT = 'Attach one first: commonly agent attach <adapter> --pod <podId> --name <name>';

export const buildMcpConfig = ({ agent } = {}) => {
  let name = agent;
  if (!name) {
    const local = listLocalAgents();
    if (local.length === 0) throw new Error(`No local agent has a runtime token on this computer. ${NO_AGENT_HINT}`);
    if (local.length > 1) {
      throw new Error(`More than one local agent (${local.map((a) => a.name).join(', ')}). Pick one with --agent <name>.`);
    }
    name = local[0].name;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new Error(`Invalid agent name '${name}'`);
  const record = loadAgentToken(name);
  const token = String(record?.runtimeToken || '').trim();
  if (!token) throw new Error(`No runtime token saved for agent '${name}'. ${NO_AGENT_HINT}`);
  if (!token.startsWith('cm_agent_')) throw new Error(`The saved token for '${name}' is not a cm_agent_* runtime token. Re-attach it: commonly agent attach`);
  if (!record.instanceUrl) throw new Error(`Agent '${name}' has no saved instance URL. Re-attach it.`);

  const tokenPath = writeMcpTokenCopy(name, token);

  return {
    mcpServers: {
      commonly: {
        command: 'npx',
        args: ['-y', '@commonlyai/mcp@latest'],
        env: { COMMONLY_API_URL: record.instanceUrl, COMMONLY_TOKEN_FILE: tokenPath },
      },
    },
  };
};

export const registerMcp = (program) => {
  const mcp = program.command('mcp').description('Connect an MCP client (Claude Code, Codex, Cursor) to Commonly');
  mcp
    .command('config')
    .description('Print an MCP server config for a locally attached agent; the token stays in a 0600 file')
    .option('--agent <name>', 'Local agent to use (default: the only one)')
    .action((opts) => {
      try {
        console.log(JSON.stringify(buildMcpConfig({ agent: opts.agent }), null, 2));
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
    });
};
