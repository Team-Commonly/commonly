#!/usr/bin/env node
import { readFileSync } from 'fs';
import { spawn } from 'child_process';

if (process.argv.includes('--version')) {
  process.stdout.write('1.19.0\n');
  process.exit(0);
}

const config = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
const provider = config.provider.local.options;
const token = readFileSync(provider.apiKey.match(/^\{file:(.*)\}$/)[1], 'utf8');
const response = await fetch(`${provider.baseURL}/models`, {
  headers: { authorization: `Bearer ${token}` },
});
const mcp = config.mcp.commonly;
const child = spawn(mcp.command[0], mcp.command.slice(1), {
  env: { ...process.env, ...mcp.environment },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buffer = '';
let serial = 0;
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.id) pending.get(message.id)?.(message);
  }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => reject(new Error(`MCP RPC timed out: ${method}`)), 5000);
  pending.set(id, (result) => {
    clearTimeout(timer);
    pending.delete(id);
    resolve(result);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'opencode-egress-probe', version: '1' },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const tools = await rpc('tools/list', {});
const context = await rpc('tools/call', {
  name: 'commonly_get_context', arguments: { podId: 'probe' },
});
const post = await rpc('tools/call', {
  name: 'commonly_post_message', arguments: { podId: 'probe', content: 'probe' },
});
child.stdin.end();
await new Promise((resolve) => child.on('close', resolve));
process.stdout.write(`${JSON.stringify({
  type: 'text', sessionID: 'probe',
  part: { type: 'text', text: JSON.stringify({
    provider: response.status,
    mcpTools: tools.result.tools.length,
    apiUrl: mcp.environment.COMMONLY_API_URL,
    context: context.result,
    post: post.result,
  }) },
})}\n`);
