/**
 * The MCP server object: the tool surface, plus channel mode when asked for.
 *
 * With channel mode off this is the tools-only server it always was: the same
 * capabilities (`tools: {}`), no instructions, and nothing polls. With it on,
 * the server also declares `experimental['claude/channel']`, carries the
 * channel instructions, and runs the poll loop in ./channel.js once the client
 * has initialized, until the transport closes. The permission-relay capability
 * is never declared.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { buildTools } from './tools.js';
import { createPublicSeatGate } from './public-seat-gate.js';
import { PACKAGE_VERSION } from './version.js';
import {
  CHANNEL_CAPABILITY,
  CHANNEL_INSTRUCTIONS,
  CHANNEL_NOTIFICATION,
  startChannel,
} from './channel.js';

const PACKAGE_NAME = '@commonlyai/mcp';

export const createServer = (config, { channel = false, env = process.env, channelOptions = {} } = {}) => {
  // Off unless the CLI declared this a public seat; see ./public-seat-gate.js.
  const gate = createPublicSeatGate(env);
  const tools = buildTools(config, { onFailure: gate.observe });
  const byName = new Map(tools.map((t) => [t.name, t]));

  const options = channel
    ? {
      capabilities: { tools: {}, experimental: { [CHANNEL_CAPABILITY]: {} } },
      instructions: CHANNEL_INSTRUCTIONS,
    }
    : { capabilities: { tools: {} } };
  const server = new Server({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, options);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({
      name, description, inputSchema, annotations,
    }) => ({
      name, description, inputSchema, ...(annotations ? { annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({ message: `Unknown tool: ${req.params.name}` }),
        }],
      };
    }
    const refused = gate.refusal(tool.name);
    if (refused) return refused;
    return tool.call(req.params.arguments || {});
  });

  const handle = { server, channel: null, gate };

  handle.connect = async (transport) => {
    if (!channel) {
      await server.connect(transport);
      return;
    }
    // The poll loop claims nothing until the client has initialized, and a
    // notification goes out only while the transport is open. `ready` resolves
    // true on initialize and false if the transport closes first; the loop
    // waits on it before its first claim.
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    let open = true;
    server.oninitialized = () => markReady(true);
    server.onclose = () => {
      open = false;
      markReady(false);
      handle.channel?.stop();
    };
    await server.connect(transport);
    // If the transport closed while connect() was pending, `ready` may already
    // have resolved true (initialize won the race) even though the session is
    // gone — starting the loop would claim one mention only to fail its push.
    // Don't start it; onclose has already run and there is nothing to stop.
    if (!open) return;
    handle.channel = startChannel({
      ...channelOptions,
      config,
      env,
      ready,
      notify: async (params) => {
        if (!open) throw new Error('the transport closed');
        await server.notification({ method: CHANNEL_NOTIFICATION, params });
      },
    });
  };

  return handle;
};
