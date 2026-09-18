/**
 * The pi ↔ MCP bridge's stdio client against a fake MCP server: initialize,
 * tools/list, tools/call over newline-delimited JSON-RPC, and the result
 * mapping pi receives.
 */
import { spawn } from 'child_process';
import { connectMcp, toPiResult, readServers } from '../src/lib/adapters/pi-mcp-client.mjs';

// A fake MCP server: one tool, echoes its arguments; errors on `boom`.
const FAKE_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => { const m = JSON.parse(line); if (m.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake' } });
  if (m.method === 'tools/list') return reply({ tools: [{ name: 'commonly_echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
  if (m.method === 'tools/call') { if (m.params.name !== 'commonly_echo') return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { message: 'unknown tool ' + m.params.name } }) + '\\n'); if (m.params.arguments.text === 'boom') return reply({ isError: true, content: [{ type: 'text', text: 'nope' }] }); return reply({ content: [{ type: 'text', text: 'echo:' + m.params.arguments.text + ':' + process.env.SEAT_ENV }] }); }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { message: 'unknown ' + m.method } }) + '\\n'); });
`;

test('initialize → tools/list → tools/call round-trip over stdio, with the server env applied', async () => {
  const client = connectMcp({ name: 'fake', command: ['node', '-e', FAKE_SERVER], env: { SEAT_ENV: 'kai' } }, { spawnImpl: spawn, timeoutMs: 5000 });
  try {
    const init = await client.initialize();
    expect(init.serverInfo.name).toBe('fake');
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['commonly_echo']);
    expect(toPiResult(await client.callTool('commonly_echo', { text: 'hi' }))).toEqual({ content: [{ type: 'text', text: 'echo:hi:kai' }], details: { isError: false } });
    expect(toPiResult(await client.callTool('commonly_echo', { text: 'boom' }))).toEqual({ content: [{ type: 'text', text: 'error: nope' }], details: { isError: true } });
    await expect(client.callTool('nope', {})).rejects.toThrow(/unknown tool nope/);
  } finally { client.close(); }
});

test('a request outstanding when the server dies rejects instead of hanging', async () => {
  const client = connectMcp({ name: 'dead', command: ['node', '-e', 'process.stdin.on("data", () => process.exit(3))'] }, { spawnImpl: spawn, timeoutMs: 5000 });
  await expect(client.initialize()).rejects.toThrow(/exited \(3\)/);
});

test('readServers keeps only stdio entries and tolerates bad JSON', () => {
  expect(readServers('[{"name":"a","command":["x"]},{"name":"b"},{"command":["y"]}]')).toEqual([{ name: 'a', command: ['x'] }]);
  expect(readServers('not json')).toEqual([]);
  expect(readServers(undefined)).toEqual([]);
});
