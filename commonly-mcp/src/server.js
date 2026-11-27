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
  McpError,
  ErrorCode,
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
import {
  EVENTS_EXTENSION,
  createEventsHub,
  discoverResult,
} from './events.js';

const PACKAGE_NAME = '@commonlyai/mcp';

/**
 * F468: tools this process never lists and answers as unknown. The CLI sets it
 * for a public seat whose runtime cannot filter one MCP server's tools
 * (DeepSeek Harness), so a withheld tool isn't offered to the model at all.
 * A comma-separated list of tool names; absent or empty withholds nothing.
 */
export const WITHHELD_TOOLS_ENV = 'COMMONLY_MCP_WITHHELD_TOOLS';

export const parseWithheldTools = (raw) => new Set(String(raw ?? '')
  .split(',').map((name) => name.trim()).filter(Boolean));

/**
 * Events mode only: a 2026-07-28 client refuses a result this SDK (1.x, up to
 * 2025-11-25) writes as is. Every 2026-07-28 result carries `resultType`, and
 * the cacheable ones (`server/discover`, `tools/list`) carry `ttlMs` and
 * `cacheScope`. So a response to a request that arrived with the 2026-07-28
 * envelope (`_meta[PROTOCOL_VERSION_META]`) gets those fields when it lacks
 * them: complete, not cached, private. Legacy responses are left exactly as
 * they were.
 */
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CACHEABLE = new Set(['server/discover', 'tools/list']);
const markModernResults = (transport) => {
  const modern = new Map();
  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (message?.method && message.id !== undefined && message.params?._meta?.[PROTOCOL_VERSION_META]) {
      modern.set(message.id, message.method);
    }
    // A cancelled request gets no response, so its entry would never leave.
    if (message?.method === 'notifications/cancelled' && message.id === undefined) {
      modern.delete(message.params?.requestId);
    }
    return receive?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (!message || message.id === undefined || message.method || !modern.has(message.id)) {
      return send(message, options);
    }
    const method = modern.get(message.id);
    modern.delete(message.id);
    if (!message.result || typeof message.result !== 'object') return send(message, options);
    const result = {
      resultType: 'complete',
      ...(CACHEABLE.has(method) ? { ttlMs: 0, cacheScope: 'private' } : {}),
      ...message.result,
    };
    return send({ ...message, result }, options);
  };
};

export const createServer = (config, {
  channel = false, env = process.env, channelOptions = {}, events = false, eventsOptions = {},
} = {}) => {
  if (channel && events) {
    throw new Error('Choose one: channel mode or MCP events mode. Both claim the same mentions.');
  }
  // Off unless the CLI declared this a public seat; see ./public-seat-gate.js.
  const gate = createPublicSeatGate(env);
  const withheld = parseWithheldTools(env?.[WITHHELD_TOOLS_ENV]);
  const tools = buildTools(config, { onFailure: gate.observe }).filter((tool) => !withheld.has(tool.name));
  const byName = new Map(tools.map((t) => [t.name, t]));

  let options;
  if (channel) {
    options = {
      capabilities: { tools: {}, experimental: { [CHANNEL_CAPABILITY]: {} } },
      instructions: CHANNEL_INSTRUCTIONS,
    };
  } else if (events) {
    // MCP Events spike (./events.js): off unless asked for.
    options = { capabilities: { tools: {}, extensions: { [EVENTS_EXTENSION]: {} } } };
  } else {
    options = { capabilities: { tools: {} } };
  }
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

  const handle = {
    server, channel: null, gate, events: null,
  };

  if (events) {
    // The extension's methods aren't in this SDK's schemas, so they are
    // answered by the fallback handler, which only exists with the flag on.
    // `server/discover` is the piece of protocol 2026-07-28 a client such as
    // OpenCode needs before it uses events; see ./events.js.
    const hub = createEventsHub({ config, ...eventsOptions });
    handle.events = hub;
    server.fallbackRequestHandler = async (request, extra) => {
      if (request.method === 'server/discover') {
        return discoverResult({
          name: PACKAGE_NAME, version: PACKAGE_VERSION, capabilities: options.capabilities,
        });
      }
      if (String(request.method).startsWith('events/')) return hub.handle(request, extra);
      throw new McpError(ErrorCode.MethodNotFound, 'Method not found');
    };
  }

  handle.connect = async (transport) => {
    if (events) {
      server.onclose = () => handle.events.stop();
      // Wrap the transport after the SDK sets its callbacks and before it starts
      // reading, so a request delivered from start() is tracked too.
      const start = transport.start.bind(transport);
      transport.start = async () => {
        markModernResults(transport);
        return start();
      };
      await server.connect(transport);
      return;
    }
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
