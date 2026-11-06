/**
 * What a public Codex seat is offered, read from the request the real `codex`
 * binary sends. Argv alone can't show this: the tool list depends on the Codex
 * version and on the model's catalog entry, and gpt-6 and gpt-5.6 models get a
 * different shape from gpt-5.5 (`exec` with nested tools, and `collaboration.*`).
 *
 * The model is a stub on loopback and the fixture's auth.json is an API key, so
 * the route is forwarded to it. Proxy variables point at the same stub, which
 * records any other host Codex tries and refuses it.
 *
 * Runs only where `codex` is on PATH, on macOS: on Linux the sandbox helper needs
 * bwrap, which a test runner may not have. adapters.codex.test.mjs covers the argv
 * everywhere.
 */

import { jest } from '@jest/globals';
import { spawnSync } from 'child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import codex from '../src/lib/adapters/codex.js';

// Each test starts Codex at least once.
jest.setTimeout(60000);

const hasCodex = process.platform === 'darwin'
  && spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasCodex) console.warn('adapters.codex.public-tools: no codex on this Mac or platform, real-binary checks skipped');
const describeWithCodex = hasCodex ? describe : describe.skip;

const message = (text) => ({
  type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text }],
});

const startModel = async (reply) => {
  const requests = [];
  const refused = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || !/\/responses$/.test(req.url)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ host: req.headers.host, subagent: req.headers['x-openai-subagent'], body });
      const items = reply(requests.length - 1, body) || [message('done')];
      const id = `r${requests.length}`;
      const events = [
        { type: 'response.created', response: { id } },
        ...items.map((item) => ({ type: 'response.output_item.done', item })),
        { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  server.on('connect', (req, socket) => {
    refused.push(req.url);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    requests,
    refused,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
};

const toolNames = (body) => {
  const name = (tool) => (tool.type === 'namespace'
    ? (tool.tools || []).map((inner) => (tool.name === 'functions' ? name(inner) : `${tool.name}.${name(inner)}`)).flat()
    : tool.name || tool.type);
  const additional = (body.input || []).filter((item) => item.type === 'additional_tools').flatMap((item) => item.tools);
  return [...(body.tools || []), ...additional].flatMap(name);
};

const outputOf = (body, callId) => JSON.stringify(
  (body.input || []).find((item) => item.call_id === callId && /output/.test(item.type))?.output ?? null,
);

const runExec = (callId, source) => ({
  type: 'custom_tool_call', call_id: callId, namespace: 'functions', name: 'exec', input: source,
});

describeWithCodex('a public codex seat, on the real binary', () => {
  let root;
  let model;

  const runTurn = async ({
    modelName, reply, mcp, sessionId = null, path = process.env.PATH,
  }) => {
    if (!model) model = await startModel(reply);
    const proxy = `http://127.0.0.1:${model.port}`;
    const result = await codex.spawn('hi', {
      sessionId,
      cwd: join(root, 'workspace'),
      agentName: 'public-tools-test',
      timeoutMs: 60000,
      environment: { model: modelName, sandbox: { trust: 'public', mode: 'workspace' }, ...(mcp ? { mcp } : {}) },
      env: {
        PATH: path,
        HOME: join(root, 'home'),
        TMPDIR: tmpdir(),
        CODEX_HOME: join(root, 'operator'),
        OPENAI_BASE_URL: `${proxy}/v1`,
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        ALL_PROXY: proxy,
        NO_PROXY: '127.0.0.1,localhost',
      },
      _publicCodexHome: join(root, 'public'),
    });
    const hosts = new Set(model.requests.map((request) => request.host));
    expect([...hosts]).toEqual([`127.0.0.1:${model.port}`]);
    expect(model.refused).not.toContain('api.openai.com:443');
    model.sessionId = result.newSessionId;
    return model.requests;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'commonly-codex-tools-'));
    await Promise.all(['workspace', 'home', 'operator'].map((dir) => mkdir(join(root, dir))));
    await writeFile(
      join(root, 'operator', 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'stub-key' }),
    );
  });

  afterEach(async () => {
    await model?.close();
    model = null;
    await rm(root, { recursive: true, force: true });
  });

  test('gpt-5.5 is offered the shell, file edits and view_image, and no other Codex built-in', async () => {
    const [first] = await runTurn({ modelName: 'gpt-5.5', reply: () => null });
    expect(toolNames(first.body).sort()).toEqual(
      ['apply_patch', 'exec_command', 'request_user_input', 'view_image', 'write_stdin'],
    );
  });

  test('a gpt-6 model nests the same tools under exec', async () => {
    const requests = await runTurn({
      modelName: 'gpt-6-astra',
      reply: (index) => (index === 0 ? [runExec('list', 'text(JSON.stringify(Object.keys(tools)))')] : null),
    });
    const names = toolNames(requests[0].body);
    const nested = outputOf(requests.at(-1).body, 'list');
    for (const tool of ['exec_command', 'apply_patch', 'view_image']) expect(nested).toContain(tool);
    for (const tool of ['web__run', 'create_goal', 'get_goal', 'update_goal']) {
      expect(nested).not.toContain(tool);
      expect(names).not.toContain(tool);
    }
  });

  test('view_image reads through the permission profile', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const inside = join(root, 'workspace', 'in.png');
    const outside = join(root, 'home', 'out.png');
    await Promise.all([writeFile(inside, png), writeFile(outside, png)]);
    const call = (callId, path) => ({
      type: 'function_call', name: 'view_image', call_id: callId, arguments: JSON.stringify({ path }),
    });
    const requests = await runTurn({
      modelName: 'gpt-5.5',
      reply: (index) => [[call('inside', inside)], [call('outside', outside)]][index] || null,
    });
    const last = requests.at(-1).body;
    expect(outputOf(last, 'inside')).toContain('data:image/png;base64,');
    expect(outputOf(last, 'outside')).toContain('Operation not permitted');
  });

  test('a denied folder stays closed to the shell and view_image', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const denied = await mkdtemp('/private/tmp/commonly-codex-denied-');
    try {
      const file = join(denied, 'a.png');
      await writeFile(file, png);
      const requests = await runTurn({
        modelName: 'gpt-5.5',
        reply: (index) => [
          [{ type: 'function_call', name: 'view_image', call_id: 'view', arguments: JSON.stringify({ path: file }) }],
          [{
            type: 'function_call',
            name: 'exec_command',
            call_id: 'shell',
            arguments: JSON.stringify({ cmd: `wc -c < ${file}`, yield_time_ms: 3000 }),
          }],
        ][index] || null,
      });
      const last = requests.at(-1).body;
      expect(outputOf(last, 'view')).toContain('Operation not permitted');
      expect(outputOf(last, 'view')).not.toContain('data:image');
      expect(outputOf(last, 'shell')).toContain('operation not permitted');
    } finally {
      await rm(denied, { recursive: true, force: true });
    }
  });

  test('a gpt-6 model lists its agent tools but cannot start an agent', async () => {
    const requests = await runTurn({
      modelName: 'gpt-6-astra',
      reply: (index) => (index === 0
        ? [{
          type: 'function_call',
          namespace: 'collaboration',
          name: 'spawn_agent',
          call_id: 'spawn',
          arguments: JSON.stringify({ task_name: 'task', message: 'hello' }),
        }]
        : null),
    });
    expect(toolNames(requests[0].body)).toContain('collaboration.spawn_agent');
    expect(outputOf(requests.at(-1).body, 'spawn')).toContain('agent thread limit reached');
    expect(requests.filter((request) => request.subagent)).toEqual([]);
  });

  test('a thread started with the agent tools loses them when resumed', async () => {
    // Stands in for a seat that was already running: the first turn drops these
    // settings from argv before it reaches the real binary.
    const wrapper = join(root, 'older-seat');
    await mkdir(wrapper);
    await writeFile(join(wrapper, 'codex'), [
      '#!/bin/bash',
      'out=()',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = -c ] && [[ "$2" =~ ^(web_search=|features\\.|agents\\.) ]]; then shift 2; continue; fi',
      '  out+=("$1"); shift',
      'done',
      `exec ${JSON.stringify(spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout.trim())} "${"${out[@]}"}"`,
    ].join('\n'), { mode: 0o755 });

    const [older] = await runTurn({
      modelName: 'gpt-5.5',
      reply: () => null,
      path: `${wrapper}:${process.env.PATH}`,
    });
    expect(toolNames(older.body)).toContain('tool_search');

    const requests = await runTurn({ modelName: 'gpt-5.5', sessionId: model.sessionId });
    expect(toolNames(requests.at(-1).body).sort()).toEqual(
      ['apply_patch', 'exec_command', 'request_user_input', 'view_image', 'write_stdin'],
    );
  });

  test('Commonly\'s MCP tools stay reachable through tool_search', async () => {
    const server = join(root, 'mcp.mjs');
    await writeFile(server, `
      let buffer = '';
      process.stdin.on('data', (data) => {
        buffer += data;
        for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (!line.trim()) continue;
          const { id, method, params } = JSON.parse(line);
          if (id === undefined) continue;
          const result = method === 'initialize'
            ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'commonly', version: '0' } }
            : method === 'tools/list'
              ? { tools: [{ name: 'commonly_post_message', description: 'post', inputSchema: { type: 'object' } }] }
              : {};
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
        }
      });
    `);
    const requests = await runTurn({
      modelName: 'gpt-5.5',
      mcp: [{ name: 'commonly', transport: 'stdio', command: [process.execPath, server] }],
      reply: (index) => (index === 0
        ? [{
          type: 'tool_search_call',
          call_id: 'search',
          status: 'completed',
          execution: 'client',
          arguments: { query: 'commonly post message', limit: 10 },
        }]
        : null),
    });
    expect(toolNames(requests[0].body)).toContain('tool_search');
    const found = requests.at(-1).body.input.find((item) => item.type === 'tool_search_output');
    expect(JSON.stringify(found.tools)).toContain('commonly_post_message');
    expect(JSON.stringify(found.tools)).not.toContain('spawn_agent');
  });
});
