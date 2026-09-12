import express from 'express';
import rateLimit from 'express-rate-limit';
import { getToolDefinitions, callTool } from '../services/toolBrokerService';

// The SDK is CommonJS-compatible, but its package exports use subpath entry
// points. Requiring them here keeps this route compatible with the backend's
// ts-node/CommonJS runtime while still using the official Streamable HTTP
// transport.
// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-unresolved, import/extensions
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-unresolved, import/extensions
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-unresolved, import/extensions
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { agentRateLimitKeyGenerator } = require('../middleware/agentRateLimit');

const router = express.Router();

// The handler authenticates through Mongo, loads pod membership, spends a
// budget row, and writes an audit row. Bound that work before auth runs so an
// unauthenticated caller cannot turn the grant endpoint into a database probe.
const brokerRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: agentRateLimitKeyGenerator,
  handler: (_req, res) => res.status(429).json({ error: 'rate_limit_exceeded' }),
});

const errorPayload = (error: unknown): Record<string, unknown> => {
  const e = error as { code?: string; message?: string; details?: unknown };
  return {
    error: e.code || 'broker_error',
    message: e.message || 'Tool call refused',
    ...(e.details ? { details: e.details } : {}),
  };
};

/**
 * Stateless MCP endpoint. The bearer agent token authenticates the caller;
 * the grant id in the URL supplies capabilities. No credential or grant
 * secret is placed in the MCP tool list or response.
 */
router.post('/:grantId', brokerRateLimit, agentRuntimeAuth, async (req: express.Request, res: express.Response) => {
  const agent = req.agentUser;
  const installation = req.agentInstallation;
  const agentUserId = String(agent?._id || '');
  if (!agentUserId) return res.status(401).json({ error: 'agent_identity_required' });
  const agentName = installation?.agentName
    || agent?.botMetadata?.agentName
    || agent?.username;
  const instanceId = installation?.instanceId
    || agent?.botMetadata?.instanceId
    || 'default';

  const server = new Server(
    { name: 'commonly-grant-broker', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  const definitions = getToolDefinitions();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const tool = String(request.params?.name || '');
    const args = request.params?.arguments || {};
    try {
      const result = await callTool({
        grantId: String(req.params.grantId),
        agentUserId,
        agentName,
        instanceId,
        tool,
        args,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.result) }],
      };
    } catch (error) {
      const approvalError = error as { code?: string; details?: { approvalId?: string } };
      if (approvalError.code === 'approval_required') {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            status: 'pending_approval',
            approvalId: approvalError.details?.approvalId || null,
          }) }],
        };
      }
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(errorPayload(error)) }],
      };
    }
  });

  // `sessionIdGenerator: undefined` intentionally makes each request
  // stateless. Grants and audit rows are the durable state; an MCP session
  // must not become another capability cache that survives revocation.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ ...errorPayload(error), error: 'broker_transport_error' });
    else console.error('[mcp-grants] transport error after response:', error);
  } finally {
    await server.close().catch(() => {});
  }
});

export default router;

// CJS compat: let require() return the router directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"];
Object.assign(module.exports, exports);
