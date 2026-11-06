/**
 * A local model, Commonly API and grant broker for the real-binary grant proofs
 * (F175d). The model is scripted, so it does what a stranger's message could
 * make a real model do: `attack(tools)` returns the tool calls for the first
 * turn that offers tools, whether or not they were advertised. With
 * `oneCallPerTurn` each call gets its own turn, because Qwen skips whatever
 * follows a plan-mode call in the same turn, and a skipped call proves nothing.
 */
import { createServer } from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BROKER_PATH = '/api/mcp/grants/g1';
export const BROKER_TOOL = 'github_list_issues';
export const BROKER_ANSWER = 'BROKER-FIXTURE-ANSWER';
export const POD_ID = '0123456789abcdef01234567';

/** The prepared Commonly MCP tree a public seat runs, with no warm in the background. */
export const prepareCommonlyMcp = async (root) => {
  const home = join(root, 'mcp-home');
  const source = process.env.COMMONLY_SMOKE_MCP_SOURCE
    || fileURLToPath(new URL('../../commonly-mcp/', import.meta.url));
  const { version } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await cp(source, join(home, version, 'node_modules', '@commonlyai', 'mcp'), { recursive: true });
  await writeFile(join(home, 'current'), version);
  await writeFile(join(home, '.warm.lock'), 'fixture');
  return home;
};

const rpc = (id, payload) => JSON.stringify({ jsonrpc: '2.0', id, ...payload });

export const startSeatFixture = async ({ attack = () => [], brokerStatus = () => 200, oneCallPerTurn = false }) => {
  const state = {
    brokerAuth: [], brokerCalls: [], modelBodies: [], advertised: [], apiBodies: [], results: [],
  };
  let queued = null;
  let nextCall = 0;

  const answerBroker = (request, body, response) => {
    state.brokerAuth.push(request.headers.authorization);
    const status = brokerStatus();
    if (status !== 200) {
      response.statusCode = status;
      response.end(JSON.stringify({ error: 'refused' }));
      return;
    }
    if (request.method !== 'POST') {
      response.statusCode = 405;
      response.end();
      return;
    }
    const message = JSON.parse(body);
    if (message.id === undefined) {
      response.statusCode = 202;
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (message.method === 'initialize') {
      response.end(rpc(message.id, { result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'commonly-grant-broker', version: '1' },
      } }));
    } else if (message.method === 'tools/list') {
      response.end(rpc(message.id, { result: { tools: [{
        name: BROKER_TOOL, description: 'List issues.', inputSchema: { type: 'object', properties: {} },
      }] } }));
    } else if (message.method === 'tools/call') {
      state.brokerCalls.push(message.params.name);
      response.end(rpc(message.id, { result: { content: [{ type: 'text', text: BROKER_ANSWER }] } }));
    } else {
      // What the broker's MCP SDK server answers to a method it doesn't have.
      response.end(rpc(message.id, { error: { code: -32601, message: 'Method not found' } }));
    }
  };

  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.url.startsWith(BROKER_PATH)) {
      answerBroker(request, body, response);
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/api/')) {
      state.apiBodies.push(`${request.method} ${request.url} ${body}`);
      response.end(JSON.stringify({ pod: { id: POD_ID, name: 'fixture' }, messages: [] }));
      return;
    }
    if (request.url.endsWith('/models')) {
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture' }] }));
      return;
    }
    const input = JSON.parse(body);
    state.modelBodies.push(body);
    const tools = input.tools?.map((tool) => tool.function.name) || [];
    if (tools.length) state.advertised.push(tools);
    state.results = input.messages?.filter((message) => message.role === 'tool') || state.results;
    if (tools.length && !queued) queued = attack(tools);
    const calls = (tools.length && queued.splice(0, oneCallPerTurn ? 1 : queued.length)) || [];
    const delta = calls.length
      ? { role: 'assistant', tool_calls: calls.map(({ name, args }, index) => {
        const id = `attempt-${nextCall}`;
        nextCall += 1;
        return { index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
      }) }
      : { role: 'assistant', content: 'proof complete' };
    const envelope = (extra) => ({
      id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture',
      choices: [{ index: 0, ...extra }],
    });
    if (input.stream) {
      response.setHeader('content-type', 'text/event-stream');
      response.end(`data: ${JSON.stringify(envelope({ delta, finish_reason: null }))}\n\n`
        + `data: ${JSON.stringify(envelope({ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }))}\n\n`
        + 'data: [DONE]\n\n');
      return;
    }
    response.end(JSON.stringify({
      id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',
      choices: [{ index: 0, message: { role: 'assistant', content: 'fixture title' }, finish_reason: 'stop' }],
    }));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const resultFor = (index) => {
    const result = state.results.find((candidate) => candidate.tool_call_id === `attempt-${index}`);
    return result && JSON.stringify(result.content);
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
  };
  return { origin, state, resultFor, close };
};

/** The seat's declared environment: Commonly MCP plus one live grant broker. */
export const seatEnvironment = (origin, keyFile) => ({
  model: 'fixture',
  sandbox: { trust: 'public' },
  provider: { id: 'fixture', baseURL: `${origin}/v1`, keyFile },
  mcp: [
    { name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'],
      env: { COMMONLY_TOKEN_FILE: '${COMMONLY_TOKEN_FILE}', COMMONLY_API_URL: '${COMMONLY_API_URL}' } },
    { name: 'commonly-grant-broker', transport: 'http', url: `\${COMMONLY_API_URL}${BROKER_PATH}`,
      headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' } },
  ],
});

export const writeProviderKey = async (root) => {
  await mkdir(root, { recursive: true });
  const keyFile = join(root, 'provider-key');
  await writeFile(keyFile, 'fixture-provider-key', { mode: 0o600 });
  return keyFile;
};
