/**
 * A public Codex seat reads its workspace's history through the read-only git
 * tool, on the real `codex` binary. Its shell can't run git on macOS (Homebrew's
 * git is outside the profile and /usr/bin/git is an xcrun shim), so this tool is
 * the seat's only way to read a commit.
 *
 * The model is a stub on loopback, as in adapters.codex.public-tools.test.mjs.
 * Runs only where `codex` and `git` are on PATH, on macOS.
 */

import { jest } from '@jest/globals';
import { spawnSync } from 'child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import codex from '../src/lib/adapters/codex.js';

jest.setTimeout(60000);

const hasTools = process.platform === 'darwin'
  && spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0
  && spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasTools) console.warn('adapters.codex.workspace-git: no codex or git on this Mac or platform, real-binary checks skipped');
const describeWithCodex = hasTools ? describe : describe.skip;

const startModel = async (reply) => {
  const requests = [];
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
      requests.push(body);
      const items = reply(requests.length - 1, body) || [{
        type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'done' }],
      }];
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
  server.on('connect', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    requests,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
};

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

describeWithCodex('a public codex seat and the workspace git tool, on the real binary', () => {
  let root;
  let model;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'commonly-codex-git-'));
    await Promise.all(['workspace', 'home', 'operator'].map((dir) => mkdir(join(root, dir))));
    await writeFile(
      join(root, 'operator', 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'stub-key' }),
    );
    const workspace = join(root, 'workspace');
    git(workspace, 'init', '-q');
    await writeFile(join(workspace, 'a.txt'), 'one\n');
    git(workspace, 'add', 'a.txt');
    git(workspace, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'a subject only git can show');
  });

  afterEach(async () => {
    await model?.close();
    model = null;
    await rm(root, { recursive: true, force: true });
  });

  const runTurn = async (reply, environment = {}) => {
    model = await startModel(reply);
    const proxy = `http://127.0.0.1:${model.port}`;
    await codex.spawn('hi', {
      cwd: join(root, 'workspace'),
      agentName: 'workspace-git-test',
      timeoutMs: 60000,
      environment: { model: 'gpt-5.5', sandbox: { trust: 'public', mode: 'workspace' }, ...environment },
      env: {
        PATH: process.env.PATH,
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
    return model.requests;
  };

  const search = {
    type: 'tool_search_call',
    call_id: 'search',
    status: 'completed',
    execution: 'client',
    arguments: { query: 'workspace git log', limit: 10 },
  };

  test('the seat finds the git tool and reads a commit through it', async () => {
    const requests = await runTurn((index, body) => {
      if (index === 0) return [search];
      if (index === 1) {
        const found = body.input.find((item) => item.type === 'tool_search_output');
        const namespace = found?.tools?.find((tool) => /workspace_git/.test(tool.name || ''));
        if (!namespace) return null;
        return [{
          type: 'function_call',
          namespace: namespace.name,
          name: 'git',
          call_id: 'log',
          arguments: JSON.stringify({ subcommand: 'log', args: ['-n', '1', '--format=%s'] }),
        }];
      }
      return null;
    });
    const found = requests[1].input.find((item) => item.type === 'tool_search_output');
    expect(JSON.stringify(found.tools)).toContain('workspace_git');
    const output = requests.at(-1).input.find((item) => item.call_id === 'log' && /output/.test(item.type));
    expect(JSON.stringify(output?.output)).toContain('a subject only git can show');
  });

  test('the shell still cannot run git, so the tool is not a way around it', async () => {
    const requests = await runTurn((index) => (index === 0
      ? [{
        type: 'function_call',
        name: 'exec_command',
        call_id: 'shell',
        arguments: JSON.stringify({ cmd: 'git log -n 1 --format=%s', yield_time_ms: 5000 }),
      }]
      : null));
    const output = requests.at(-1).input.find((item) => item.call_id === 'shell' && /output/.test(item.type));
    expect(output).toBeDefined();
    expect(JSON.stringify(output.output)).not.toContain('a subject only git can show');
  });
});
