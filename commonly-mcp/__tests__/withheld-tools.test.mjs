/**
 * F468: a runtime that cannot filter one MCP server's tools (DeepSeek Harness)
 * hands this server the tools a public seat is withheld, and they are never
 * listed. A call to one by name is answered as an unknown tool, unsent.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, parseWithheldTools, WITHHELD_TOOLS_ENV } from '../src/server.js';
import { buildTools } from '../src/tools.js';

const cfg = { baseUrl: 'https://x.example', token: 'cm_agent_t' };
const ALL = buildTools(cfg).map((tool) => tool.name);

let fetched;
beforeEach(() => {
  fetched = [];
  global.fetch = async (url) => {
    fetched.push(url);
    return { ok: true, status: 200, text: async () => '{}' };
  };
});
afterEach(() => { delete global.fetch; });

const connect = async (env) => {
  const handle = createServer(cfg, { env });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await handle.connect(serverSide);
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
};

test('a withheld tool is never listed, and every other tool still is', async () => {
  const withheld = ['commonly_attach_file', 'commonly_write_agent_memory'];
  const client = await connect({ [WITHHELD_TOOLS_ENV]: withheld.join(',') });
  const listed = (await client.listTools()).tools.map((tool) => tool.name);
  expect(listed).toEqual(ALL.filter((name) => !withheld.includes(name)));
  for (const name of withheld) expect(ALL).toContain(name);
});

test('a call to a withheld tool by name is an unknown tool and reaches nothing', async () => {
  const client = await connect({ [WITHHELD_TOOLS_ENV]: 'commonly_attach_file' });
  const result = await client.callTool({ name: 'commonly_attach_file', arguments: { podId: 'P', filePath: '/etc/hosts' } });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Unknown tool: commonly_attach_file');
  expect(fetched).toEqual([]);
});

test('without the variable, or with it empty, every tool is listed', async () => {
  for (const env of [{}, { [WITHHELD_TOOLS_ENV]: '' }, { [WITHHELD_TOOLS_ENV]: ' , ' }]) {
    const client = await connect(env);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(ALL);
  }
});

test('the list is comma-separated, spaces around a name are ignored, a name no tool has changes nothing', () => {
  expect([...parseWithheldTools(' commonly_attach_file ,commonly_log_cycle,,')])
    .toEqual(['commonly_attach_file', 'commonly_log_cycle']);
  expect([...parseWithheldTools(undefined)]).toEqual([]);
  expect([...parseWithheldTools('not_a_tool')]).toEqual(['not_a_tool']);
});
